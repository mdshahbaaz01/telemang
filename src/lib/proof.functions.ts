import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const createSchema = z.object({
  channelLink: z.string().min(1).max(400),
  target: z.string().min(1).max(200),
  caption: z.string().max(1000).optional().nullable(),
  format: z.enum(["auto", "chat_list", "channel_view"]).default("auto"),
  parallel: z.number().int().min(1).max(20).default(1),
  accountIds: z.array(z.string().uuid()).min(1).max(500),
});

function cleanTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/[?#].*$/, "");
}

export const createProofTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: task, error } = await context.supabase
      .from("proof_tasks")
      .insert({
        user_id: context.userId,
        channel_link: data.channelLink.trim(),
        target: data.target.trim(),
        caption: data.caption ?? null,
        format: data.format,
        parallel: data.parallel,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const rows = data.accountIds.map((accountId) => ({
      task_id: task.id,
      user_id: context.userId,
      account_id: accountId,
      status: "pending",
    }));
    const { error: rerr } = await context.supabase.from("proof_runs").insert(rows);
    if (rerr) throw new Error(rerr.message);
    return { taskId: task.id as string };
  });

export const listProofTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("proof_tasks")
      .select("id, channel_link, target, caption, format, parallel, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listProofRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("proof_runs")
      .select("id, account_id, status, channel_title, channel_username, subscribers, format_used, error, updated_at, telegram_accounts(phone, username, first_name)")
      .eq("task_id", data.taskId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const runProofTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ taskId: z.string().uuid(), accountId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: task, error: terr } = await context.supabase
      .from("proof_tasks")
      .select("id, channel_link, target, caption, format, parallel")
      .eq("id", data.taskId)
      .single();
    if (terr || !task) throw new Error("Task not found");

    const runQ = context.supabase
      .from("proof_runs")
      .select("id, account_id")
      .eq("task_id", task.id);
    if (data.accountId) runQ.eq("account_id", data.accountId);
    else runQ.in("status", ["pending", "failed"]);
    const { data: runs, error: rerr } = await runQ;
    if (rerr) throw new Error(rerr.message);
    if (!runs?.length) return { ran: 0 };

    const { openClientForAccount } = await import("./cleanup.server");
    const { buildChannelViewSvg, buildChatListSvg, renderSvgToPng } = await import(
      "./proof-render.server"
    );
    const { CustomFile } = await import("telegram/client/uploads");
    const { Api } = await import("telegram");

    const rawTarget = task.channel_link;
    const cleaned = cleanTarget(rawTarget);
    const inviteHash = cleaned.startsWith("+")
      ? cleaned.slice(1)
      : cleaned.toLowerCase().startsWith("joinchat/")
        ? cleaned.slice("joinchat/".length)
        : null;

    let processed = 0;
    const stamp = async (runId: string, patch: Record<string, unknown>) => {
      await context.supabase
        .from("proof_runs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", runId);
    };

    const processOne = async (run: { id: string; account_id: string }) => {
      let client: Awaited<ReturnType<typeof openClientForAccount>> | null = null;
      try {
        client = await openClientForAccount(context.supabase, run.account_id, {
          requireOwnerId: context.userId,
        });

        // Join
        let joinedPrivate = false;
        try {
          if (inviteHash) {
            const invite: any = await client.invoke(
              new Api.messages.CheckChatInvite({ hash: inviteHash }),
            );
            if (invite?.className !== "ChatInviteAlready") {
              await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
            }
            joinedPrivate = true;
          } else {
            await client.invoke(new Api.channels.JoinChannel({ channel: cleaned }));
          }
        } catch (e) {
          const msg = (e as Error).message || String(e);
          if (!msg.includes("USER_ALREADY_PARTICIPANT")) {
            // Continue anyway to try to fetch info; but record note
          }
        }

        // Resolve entity + channel info
        let entity: any;
        let title = cleaned;
        let username: string | null = null;
        let subscribers = 0;
        let verified = false;
        try {
          if (inviteHash) {
            const invite: any = await client.invoke(
              new Api.messages.CheckChatInvite({ hash: inviteHash }),
            );
            const chat = invite?.chat ?? invite?.chats?.[0];
            if (chat) {
              title = chat.title ?? title;
              username = chat.username ?? null;
              subscribers = Number(chat.participantsCount ?? 0);
              verified = Boolean(chat.verified);
              entity = chat;
            }
          } else {
            entity = await client.getEntity(cleaned);
            title = (entity?.title as string) ?? cleaned;
            username = (entity?.username as string) ?? null;
            verified = Boolean((entity as any)?.verified);
            try {
              const full: any = await client.invoke(
                new Api.channels.GetFullChannel({ channel: entity }),
              );
              subscribers = Number(full?.fullChat?.participantsCount ?? entity?.participantsCount ?? 0);
            } catch {
              subscribers = Number(entity?.participantsCount ?? 0);
            }
          }
        } catch (e) {
          // fallthrough with defaults
        }

        // Try to download channel profile photo (small variant)
        let avatarBase64: string | null = null;
        try {
          if (entity) {
            const buf: any = await client.downloadProfilePhoto(entity, { isBig: false });
            if (buf && buf.length) {
              avatarBase64 = Buffer.from(buf).toString("base64");
            }
          }
        } catch {}

        // Joining account display name (for caption)
        let accountName = "";
        try {
          const me: any = await client.getMe();
          accountName = [me?.firstName, me?.lastName].filter(Boolean).join(" ") ||
            (me?.username ? `@${me.username}` : "") ||
            String(me?.phone ?? "");
        } catch {}

        // Determine format
        const fmt =
          task.format === "auto"
            ? joinedPrivate || !username
              ? "chat_list"
              : "channel_view"
            : task.format;

        // Fetch dialogs for chat_list style
        let svg: string;
        if (fmt === "chat_list") {
          const others: Array<{ title: string; lastMessage: string; time: string; unread?: number }> = [];
          try {
            const dialogs = await client.getDialogs({ limit: 12 });
            for (const d of dialogs) {
              const entTitle = (d.entity as any)?.title || (d.entity as any)?.firstName || (d.entity as any)?.username || "Chat";
              if (entTitle === title) continue;
              const msg = (d.message?.message as string) || "";
              const dt = d.message?.date ? new Date(d.message.date * 1000) : new Date();
              const h = dt.getHours();
              const m = dt.getMinutes().toString().padStart(2, "0");
              const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
              const ap = h >= 12 ? "PM" : "AM";
              others.push({
                title: entTitle,
                lastMessage: msg || "…",
                time: `${hh}:${m} ${ap}`,
                unread: d.unreadCount || undefined,
              });
              if (others.length >= 8) break;
            }
          } catch {}
          svg = buildChatListSvg({ title, username, subscribers }, others);
        } else {
          // Fetch recent messages with media types + forwards + views
          const msgs: Array<{
            text: string;
            time: string;
            views?: number;
            forwardedFrom?: string | null;
            mediaKind?: "photo" | "video" | "document" | "poll" | "sticker" | "audio" | null;
            mediaLabel?: string | null;
          }> = [];
          try {
            if (entity) {
              const recent: any[] = await client.getMessages(entity, { limit: 8 });
              for (const m of recent.slice().reverse()) {
                const text = (m?.message as string) || "";
                if (m?.action) continue; // skip service messages
                const dt = m?.date ? new Date(m.date * 1000) : new Date();
                const h = dt.getHours();
                const mm = dt.getMinutes().toString().padStart(2, "0");
                const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
                const ap = h >= 12 ? "PM" : "AM";

                // media detection
                let mediaKind: any = null;
                let mediaLabel: string | null = null;
                const media = m?.media;
                if (media) {
                  const cn = media.className || "";
                  if (cn.includes("Photo")) mediaKind = "photo";
                  else if (cn.includes("Poll")) mediaKind = "poll";
                  else if (cn.includes("Document")) {
                    const attrs = media?.document?.attributes || [];
                    const isVideo = attrs.some((a: any) => a.className?.includes("Video"));
                    const isAudio = attrs.some((a: any) => a.className?.includes("Audio"));
                    const isSticker = attrs.some((a: any) => a.className?.includes("Sticker"));
                    const fnameAttr = attrs.find((a: any) => a.className?.includes("Filename"));
                    if (isSticker) mediaKind = "sticker";
                    else if (isVideo) mediaKind = "video";
                    else if (isAudio) mediaKind = "audio";
                    else {
                      mediaKind = "document";
                      mediaLabel = fnameAttr?.fileName || null;
                    }
                  }
                }

                let forwardedFrom: string | null = null;
                const fwd = m?.fwdFrom;
                if (fwd) {
                  forwardedFrom = fwd.fromName || null;
                  // if channel id present, try resolving via cached chats
                }

                if (!text && !mediaKind) continue;
                msgs.push({
                  text,
                  time: `${hh}:${mm} ${ap}`,
                  views: typeof m?.views === "number" ? m.views : undefined,
                  forwardedFrom,
                  mediaKind,
                  mediaLabel,
                });
              }
            }
          } catch {}
          svg = buildChannelViewSvg(
            {
              title,
              username,
              subscribers,
              verified,
              avatarBase64,
              avatarMime: "image/jpeg",
            },
            msgs,
            { joinedAt: new Date(), deviceTime: new Date() },
          );
        }

        const png = await renderSvgToPng(svg);

        // Send screenshot via MTProto to target
        const cleanedTarget = cleanTarget(task.target);
        const dest = await client.getEntity(cleanedTarget);
        const captionBase = task.caption || `You joined this channel · ${title}`;
        const caption = accountName ? `${captionBase}\n(by ${accountName})` : captionBase;
        await client.sendFile(dest, {
          file: new CustomFile("proof.png", png.length, "proof.png", png),
          caption,
        });

        await stamp(run.id, {
          status: "sent",
          channel_title: title,
          channel_username: username,
          subscribers,
          format_used: fmt,
          error: null,
        });
        processed++;
      } catch (e) {
        await stamp(run.id, { status: "failed", error: (e as Error).message || String(e) });
      } finally {
        try {
          await client?.disconnect();
        } catch {}
      }
    };

    // Worker pool with concurrency = task.parallel
    const concurrency = Math.max(1, Math.min(20, Number(task.parallel) || 1));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
      while (cursor < runs.length) {
        const idx = cursor++;
        await processOne(runs[idx]);
      }
    });
    await Promise.all(workers);
    return { ran: processed };
  });