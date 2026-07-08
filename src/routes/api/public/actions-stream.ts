import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

// A single Telegram message reference: `t.me/<user>/<id>` or `t.me/c/<internalId>/<id>`
const msgRefSchema = z.object({
  chat: z.string().min(1), // username, `c/<id>` for private, or invite peer key
  msgId: z.number().int().positive(),
});

const reactSchema = z.object({
  kind: z.literal("react"),
  source: msgRefSchema,
  emoji: z.string().min(0).max(20).default(""),
  customEmojiId: z.string().regex(/^\d+$/).optional(),
  retake: z.boolean().optional(),
  mode: z.enum(["apply", "clear"]).optional(),
});

const forwardSchema = z.object({
  kind: z.literal("forward"),
  source: msgRefSchema,
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
});

const voteSchema = z.object({
  kind: z.literal("vote"),
  source: msgRefSchema,
  options: z.array(z.number().int().min(0).max(20)).max(10).default([]),
  retake: z.boolean().optional(),
  mode: z.enum(["apply", "clear"]).optional(),
});

const attachmentSchema = z.object({
  path: z.string().min(1).max(500), // storage path in "action-attachments" bucket
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200).optional(),
});

const broadcastRowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  attachment: attachmentSchema.optional(),
}).refine((r) => r.message.length > 0 || !!r.attachment, {
  message: "Row needs a message or an attachment",
});

const broadcastSchema = z.object({
  kind: z.literal("broadcast"),
  rows: z.array(broadcastRowSchema).min(1).max(200),
});

const replyRowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  attachment: attachmentSchema.optional(),
}).refine((r) => r.message.length > 0 || !!r.attachment, {
  message: "Row needs a message or an attachment",
});

const replySchema = z.object({
  kind: z.literal("reply"),
  source: msgRefSchema,
  viaDiscussion: z.boolean().optional(), // true = comment under a channel post
  rows: z.array(replyRowSchema).min(1).max(200),
});

const bodySchema = z.object({
  accountIds: z.array(z.string().uuid()).min(0).max(200).default([]),
  minDelay: z.number().int().min(0).max(60).default(2),
  maxDelay: z.number().int().min(0).max(60).default(6),
  op: z.discriminatedUnion("kind", [reactSchema, forwardSchema, voteSchema, broadcastSchema, replySchema]),
});

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function jitter(min: number, max: number) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo * 1000 + Math.random() * (hi - lo) * 1000;
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function floodWaitSeconds(message: string) {
  const floodMatch = message.match(/FLOOD_WAIT_?(\d+)/i);
  return floodMatch ? Number(floodMatch[1]) : null;
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

export const Route = createFileRoute("/api/public/actions-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const token = authHeader.slice(7);
        const supabase = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: {
              storage: undefined,
              persistSession: false,
              autoRefreshToken: false,
            },
          },
        );
        let userId: string;
        try {
          const { data: claims, error: claimsErr } =
            await supabase.auth.getClaims(token);
          if (claimsErr || !claims?.claims?.sub) {
            return new Response(`Unauthorized: ${claimsErr?.message ?? "invalid token"}`, { status: 401 });
          }
          userId = claims.claims.sub as string;
        } catch (e) {
          return new Response(`Auth error: ${(e as Error).message}`, { status: 401 });
        }

        const { data: roles } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId);
        const isAdmin = (roles ?? []).some((r) => r.role === "admin");
        if (!isAdmin) return new Response("Forbidden", { status: 403 });

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch (e) {
          return new Response(`Bad request: ${(e as Error).message}`, {
            status: 400,
          });
        }

        // Create run record
        const { data: runRow, error: runErr } = await supabase
          .from("action_runs")
          .insert({
            user_id: userId,
            kind: body.op.kind,
            status: "running",
            params: JSON.parse(JSON.stringify(body)),
          })
          .select("id")
          .single();
        if (runErr || !runRow) {
          return new Response(`run insert failed: ${runErr?.message ?? "unknown"}`, {
            status: 500,
          });
        }
        const runId = runRow.id as string;

        const abortSignal = request.signal;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(sseEncode(event, data));
              } catch {}
            };
            const close = () => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {}
            };
            const logDb = async (
              accountId: string | null,
              target: string | null,
              level: "info" | "success" | "warn" | "error",
              message: string,
            ) => {
              const { error } = await supabase
                .from("action_logs")
                .insert({ run_id: runId, account_id: accountId, target, level, message });
              if (error) {
                console.error("action log insert failed:", error.message);
                send("log", { accountId, target: target ?? undefined, level: "warn", message: `Log save failed: ${error.message}` });
              }
            };

            let stopRequested = false;
            abortSignal.addEventListener("abort", () => {
              stopRequested = true;
              send("aborted", { message: "Stopped by client" });
            });

            // Poll run status for external stop
            const stopPoll = setInterval(async () => {
              const { data: r } = await supabase
                .from("action_runs")
                .select("status")
                .eq("id", runId)
                .maybeSingle();
              if (r?.status === "stopped") stopRequested = true;
            }, 2000);

            send("start", { runId, kind: body.op.kind });

            const { openClientForAccount } = await import("@/lib/cleanup.server");
            const { Api } = await import("telegram");
            const { CustomFile } = await import("telegram/client/uploads");

            const attachmentCache = new Map<string, { buf: Buffer; filename: string; mimeType?: string }>();
            const loadAttachment = async (att: { path: string; filename: string; mimeType?: string }) => {
              const key = att.path;
              const cached = attachmentCache.get(key);
              if (cached) return cached;
              const { data, error } = await supabase.storage
                .from("action-attachments")
                .createSignedUrl(att.path, 300);
              if (error || !data?.signedUrl) throw new Error(`Attachment fetch failed: ${error?.message ?? "no url"}`);
              const res = await fetch(data.signedUrl);
              if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
              const buf = Buffer.from(await res.arrayBuffer());
              const val = { buf, filename: att.filename, mimeType: att.mimeType };
              attachmentCache.set(key, val);
              return val;
            };
            const buildCustomFile = (att: { buf: Buffer; filename: string; mimeType?: string }) =>
              new CustomFile(att.filename, att.buf.length, att.filename, att.buf);

            // Resolve source peer & get message once per account (needed for react/vote/forward source)
            const resolveSource = async (client: any, src: { chat: string; msgId: number }) => {
              let peer: any;
              if (src.chat.startsWith("c/")) {
                // Private channel numeric id — resolve via PeerChannel so gramjs
                // treats it as a channel (a raw positive int is interpreted as a
                // user id and produces "Could not find the input entity … PeerUser").
                const raw = src.chat.slice(2);
                const { default: bigInt } = await import("big-integer");
                try {
                  peer = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
                } catch {
                  // Fallback: try the full t.me link so gramjs can resolve the invite/join state.
                  peer = await client.getEntity(`https://t.me/c/${raw}/${src.msgId}`);
                }
              } else {
                peer = await client.getEntity(src.chat.replace(/^@/, ""));
              }
              return peer;
            };

            const resolveTarget = async (client: any, t: string) => {
              const cleaned = t.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
              if (/^c\/\d+/.test(cleaned)) {
                const raw = cleaned.split("/")[1];
                const { default: bigInt } = await import("big-integer");
                try {
                  return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
                } catch {
                  return await client.getEntity(`https://t.me/${cleaned}`);
                }
              }
              return await client.getEntity(cleaned);
            };

            const pickDiscussionTarget = (disc: any) => {
              const chats = (disc?.chats ?? []) as any[];
              const messages = (disc?.messages ?? []) as any[];
              const rootMsg = messages.reduce((best, msg) => {
                if (!best) return msg;
                return Number(msg?.id ?? 0) < Number(best?.id ?? 0) ? msg : best;
              }, null as any);
              const peerId = rootMsg?.peerId?.channelId ?? rootMsg?.peerId?.chatId;
              if (peerId) {
                const match = chats.find((chat) => String(chat?.id) === String(peerId));
                if (match) return { chat: match, msgId: rootMsg.id as number };
              }
              const fallback = chats.find((chat) => chat?.megagroup || chat?.gigagroup || chat?.forum) ?? chats.find((chat) => !chat?.broadcast) ?? chats[0];
              return fallback && rootMsg ? { chat: fallback, msgId: rootMsg.id as number } : null;
            };

            const pauseAccountOnFlood = async (accountId: string, message: string) => {
              const secs = floodWaitSeconds(message);
              if (!secs) return false;
              const pausedUntil = new Date(Date.now() + secs * 1000).toISOString();
              await supabase
                .from("telegram_accounts")
                .update({ paused_until: pausedUntil, last_error: message })
                .eq("id", accountId);
              return secs;
            };

            const buildReaction = async (emoji: string, customEmojiId?: string) => {
              if (customEmojiId) {
                const { default: bigInt } = await import("big-integer");
                return new Api.ReactionCustomEmoji({ documentId: bigInt(customEmojiId) });
              }
              return new Api.ReactionEmoji({ emoticon: emoji });
            };

            const runOne = async (accountId: string) => {
              if (body.op.kind === "broadcast" || body.op.kind === "reply") return { ok: 0, fail: 0 };
              const op = body.op;
              send("log", { accountId, level: "info", message: "Connecting…" });
              let client;
              try {
                client = await openClientForAccount(supabase, accountId);
              } catch (e) {
                const msg = `Connect failed: ${errorText(e)}`;
                send("log", { accountId, level: "error", message: msg });
                await logDb(accountId, null, "error", msg);
                send("done", { accountId, ok: 0, fail: 1 });
                return { ok: 0, fail: 1 };
              }
              let ok = 0;
              let fail = 0;
              try {
                const src = op.source;
                let sourcePeer: any;
                try {
                  sourcePeer = await resolveSource(client, src);
                } catch (e) {
                  const msg = `Resolve source failed: ${(e as Error).message}`;
                  send("log", { accountId, level: "error", message: msg });
                  await logDb(accountId, null, "error", msg);
                  return { ok: 0, fail: 1 };
                }

                if (op.kind === "react") {
                  try {
                    await new Promise((r) =>
                      setTimeout(r, jitter(body.minDelay, body.maxDelay)),
                    );
                    // Bump view count like a real user opening the post
                    try {
                      await client.invoke(
                        new Api.messages.GetMessagesViews({
                          peer: sourcePeer,
                          id: [src.msgId],
                          increment: true,
                        }),
                      );
                      send("log", { accountId, level: "info", target: `${src.chat}/${src.msgId}`, message: "Viewed post" });
                    } catch {}
                    if (op.retake) {
                      try {
                        await client.invoke(
                          new Api.messages.SendReaction({ peer: sourcePeer, msgId: src.msgId, reaction: [] }),
                        );
                        send("log", { accountId, level: "info", target: `${src.chat}/${src.msgId}`, message: "Cleared previous reaction" });
                      } catch {}
                    }
                    await client.invoke(
                      new Api.messages.SendReaction({
                        peer: sourcePeer,
                        msgId: src.msgId,
                        reaction: [await buildReaction(op.emoji, op.customEmojiId)],
                      }),
                    );
                    ok++;
                    const m = op.customEmojiId ? `Reacted custom:${op.customEmojiId}` : `Reacted ${op.emoji}`;
                    send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
                  } catch (e) {
                    fail++;
                    const m = (e as Error).message || String(e);
                    send("log", { accountId, level: "error", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "error", m);
                  }
                } else if (op.kind === "vote") {
                  try {
                    await new Promise((r) =>
                      setTimeout(r, jitter(body.minDelay, body.maxDelay)),
                    );
                    try {
                      await client.invoke(
                        new Api.messages.GetMessagesViews({
                          peer: sourcePeer,
                          id: [src.msgId],
                          increment: true,
                        }),
                      );
                      send("log", { accountId, level: "info", target: `${src.chat}/${src.msgId}`, message: "Viewed post" });
                    } catch {}
                    const [msg] = await client.getMessages(sourcePeer, { ids: [src.msgId] });
                    if (!msg?.poll) throw new Error("Message is not a poll");
                    const pollObj = (msg.poll as { poll?: { answers?: Array<{ option: Uint8Array }> } }).poll;
                    const answers = pollObj?.answers ?? [];
                    const chosen = op.options
                      .map((i) => answers[i]?.option)
                      .filter((x): x is Uint8Array => !!x)
                      .map((x) => Buffer.from(x));
                    if (chosen.length === 0) throw new Error("No matching poll options");
                    if (op.retake) {
                      try {
                        await client.invoke(
                          new Api.messages.SendVote({ peer: sourcePeer, msgId: src.msgId, options: [] }),
                        );
                        send("log", { accountId, level: "info", target: `${src.chat}/${src.msgId}`, message: "Retracted previous vote" });
                      } catch {}
                    }
                    await client.invoke(
                      new Api.messages.SendVote({
                        peer: sourcePeer,
                        msgId: src.msgId,
                        options: chosen,
                      }),
                    );
                    ok++;
                    const m = `Voted options ${op.options.join(",")}`;
                    send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
                  } catch (e) {
                    fail++;
                    const m = (e as Error).message || String(e);
                    send("log", { accountId, level: "error", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "error", m);
                  }
                } else if (op.kind === "forward") {
                  try {
                    await client.invoke(
                      new Api.messages.GetMessagesViews({
                        peer: sourcePeer,
                        id: [src.msgId],
                        increment: true,
                      }),
                    );
                    send("log", { accountId, level: "info", target: `${src.chat}/${src.msgId}`, message: "Viewed source post" });
                  } catch {}
                  for (const t of op.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await resolveTarget(client, t);
                      const { default: bigInt } = await import("big-integer");
                      await client.invoke(
                        new Api.messages.ForwardMessages({
                          fromPeer: sourcePeer,
                          id: [src.msgId],
                          randomId: [bigInt(Math.floor(Math.random() * 1e18))],
                          toPeer: dest,
                        }),
                      );
                      ok++;
                      const m = `Forwarded to ${t}`;
                      send("log", { accountId, level: "success", target: t, message: m });
                      await logDb(accountId, t, "success", m);
                    } catch (e) {
                      fail++;
                      const em = errorText(e);
                      const secs = await pauseAccountOnFlood(accountId, em);
                      if (secs) {
                        send("log", { accountId, level: "warn", target: t, message: `FloodWait ${secs}s — account paused` });
                        await logDb(accountId, t, "warn", `FloodWait ${secs}s`);
                        break;
                      }
                      send("log", { accountId, level: "error", target: t, message: em });
                      await logDb(accountId, t, "error", em);
                    }
                    await new Promise((r) =>
                      setTimeout(r, jitter(body.minDelay, body.maxDelay)),
                    );
                  }
                }
              } finally {
                await client.disconnect().catch(() => {});
                send("done", { accountId, ok, fail });
              }
              return { ok, fail };
            };

            const runBroadcastRowsForAccount = async (accountId: string, rows: Array<{ accountId: string; message: string; targets: string[]; attachment?: { path: string; filename: string; mimeType?: string } }>) => {
              send("log", { accountId, level: "info", message: "Connecting…" });
              let client;
              try {
                client = await openClientForAccount(supabase, accountId);
              } catch (e) {
                const msg = `Connect failed: ${errorText(e)}`;
                send("log", { accountId, level: "error", message: msg });
                await logDb(accountId, null, "error", msg);
                const fail = rows.reduce((n, row) => n + row.targets.length, 0);
                send("done", { accountId, ok: 0, fail });
                return { ok: 0, fail };
              }
              let ok = 0;
              let fail = 0;
              try {
                for (const row of rows) {
                  let attData: { buf: Buffer; filename: string; mimeType?: string } | null = null;
                  if (row.attachment) {
                    try {
                      attData = await loadAttachment(row.attachment);
                    } catch (e) {
                      const em = errorText(e);
                      fail += row.targets.length;
                      send("log", { accountId, level: "error", message: em });
                      await logDb(accountId, null, "error", em);
                      continue;
                    }
                  }
                  for (const t of row.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await resolveTarget(client, t);
                      if (attData) {
                        await client.sendFile(dest, {
                          file: buildCustomFile(attData),
                          caption: row.message || undefined,
                        });
                      } else {
                        await client.sendMessage(dest, { message: row.message });
                      }
                      ok++;
                      const m = `Sent to ${t}`;
                      send("log", { accountId, level: "success", target: t, message: m });
                      await logDb(accountId, t, "success", m);
                    } catch (e) {
                      fail++;
                      const em = errorText(e);
                      const secs = await pauseAccountOnFlood(accountId, em);
                      if (secs) {
                        send("log", { accountId, level: "warn", target: t, message: `FloodWait ${secs}s — account paused` });
                        await logDb(accountId, t, "warn", `FloodWait ${secs}s`);
                        break;
                      }
                      send("log", { accountId, level: "error", target: t, message: em });
                      await logDb(accountId, t, "error", em);
                    }
                    await new Promise((r) =>
                      setTimeout(r, jitter(body.minDelay, body.maxDelay)),
                    );
                  }
                }
              } finally {
                await client.disconnect().catch(() => {});
                send("done", { accountId, ok, fail });
              }
              return { ok, fail };
            };

            const runReplyRow = async (
              row: { accountId: string; message: string; attachment?: { path: string; filename: string; mimeType?: string } },
              src: { chat: string; msgId: number },
              viaDiscussion: boolean,
            ) => {
              const accountId = row.accountId;
              send("log", { accountId, level: "info", message: "Connecting…" });
              let client;
              try {
                client = await openClientForAccount(supabase, accountId);
              } catch (e) {
                const msg = `Connect failed: ${errorText(e)}`;
                send("log", { accountId, level: "error", message: msg });
                await logDb(accountId, null, "error", msg);
                send("done", { accountId, ok: 0, fail: 1 });
                return { ok: 0, fail: 1 };
              }
              let ok = 0;
              let fail = 0;
              try {
                await new Promise((r) =>
                  setTimeout(r, jitter(body.minDelay, body.maxDelay)),
                );
                const sourcePeer = await resolveSource(client, src);
                let replyPeer: any = sourcePeer;
                let replyToId = src.msgId;
                let topMsgId: number | undefined;
                if (viaDiscussion) {
                  const disc: any = await client.invoke(
                    new Api.messages.GetDiscussionMessage({
                      peer: sourcePeer,
                      msgId: src.msgId,
                    }),
                  );
                  // Resolve discussion group peer from the returned chats
                  const discussionTarget = pickDiscussionTarget(disc);
                  if (!discussionTarget) throw new Error("No discussion group linked to this channel");
                  replyPeer = await client.getEntity(discussionTarget.chat);
                  replyToId = discussionTarget.msgId;
                  topMsgId = discussionTarget.msgId;
                  // View the post like a real reader before commenting
                  try {
                    await client.invoke(
                      new Api.messages.GetMessagesViews({
                        peer: sourcePeer,
                        id: [src.msgId],
                        increment: true,
                      }),
                    );
                  } catch {}
                }
                if (row.attachment) {
                  const att = await loadAttachment(row.attachment);
                  await client.sendFile(replyPeer, {
                    file: buildCustomFile(att),
                    caption: row.message || undefined,
                    replyTo: replyToId,
                    ...(topMsgId ? { topMsgId } : {}),
                  });
                } else {
                  await client.sendMessage(replyPeer, {
                    message: row.message,
                    replyTo: replyToId,
                    ...(topMsgId ? { topMsgId } : {}),
                  });
                }
                ok++;
                const label = viaDiscussion ? "Commented" : "Replied";
                const m = `${label} on ${src.chat}/${src.msgId}`;
                send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
              } catch (e) {
                fail++;
                const em = errorText(e);
                const target = `${src.chat}/${src.msgId}`;
                const secs = await pauseAccountOnFlood(accountId, em);
                if (secs) {
                  send("log", { accountId, level: "warn", message: `FloodWait ${secs}s — account paused` });
                  await logDb(accountId, target, "warn", `FloodWait ${secs}s`);
                } else {
                  send("log", { accountId, level: "error", target, message: em });
                  await logDb(accountId, target, "error", em);
                }
              } finally {
                await client.disconnect().catch(() => {});
                send("done", { accountId, ok, fail });
              }
              return { ok, fail };
            };

            let totalOk = 0;
            let totalFail = 0;
            try {
              const groupByAccount = <T extends { accountId: string }>(rows: T[]) => {
                const grouped = new Map<string, T[]>();
                for (const row of rows) grouped.set(row.accountId, [...(grouped.get(row.accountId) ?? []), row]);
                return Array.from(grouped.entries());
              };
              const results =
                body.op.kind === "broadcast"
                  ? await runWithConcurrency(groupByAccount(body.op.rows), 5, ([accountId, rows]) => runBroadcastRowsForAccount(accountId, rows))
                  : body.op.kind === "reply"
                    ? await runWithConcurrency(
                        groupByAccount(body.op.rows),
                        5,
                        async ([, rows]) => {
                          let ok = 0;
                          let fail = 0;
                          for (const row of rows) {
                            if (stopRequested) break;
                            const result = await runReplyRow(row, (body.op as any).source, !!(body.op as any).viaDiscussion);
                            ok += result.ok;
                            fail += result.fail;
                          }
                          return { ok, fail };
                        },
                      )
                    : await runWithConcurrency(body.accountIds, 8, (id) => runOne(id));
              for (const r of results) {
                totalOk += r.ok;
                totalFail += r.fail;
              }
            } catch (e) {
              totalFail++;
              const message = errorText(e);
              send("log", { level: "error", message });
              await logDb(null, null, "error", message);
            } finally {
              clearInterval(stopPoll);
              const finalStatus = stopRequested ? "stopped" : "done";
              await supabase
                .from("action_runs")
                .update({
                  status: finalStatus,
                  totals: { ok: totalOk, fail: totalFail },
                  updated_at: new Date().toISOString(),
                })
                .eq("id", runId);
              send("end", { ok: totalOk, fail: totalFail, status: finalStatus });
              close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          console.error("actions-stream fatal:", msg, (e as Error)?.stack);
          return new Response(`actions-stream error: ${msg}`, { status: 500 });
        }
      },
    },
  },
});