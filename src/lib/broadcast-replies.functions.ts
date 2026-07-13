import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ── shared helpers ──────────────────────────────────────────────────────

async function assertAdmin(supabase: any) {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

async function assertOwnsAccount(supabase: any, accountId: string) {
  const { data, error } = await supabase
    .from("telegram_accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Account not found or not owned by you");
}

async function resolveTargetEntity(client: any, Api: any, t: string) {
  const cleaned = t
    .trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "");
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
}

type SerializedButton =
  | { kind: "callback"; text: string; data: string /* base64 */; requiresPassword?: boolean }
  | { kind: "url"; text: string; url: string }
  | { kind: "urlAuth"; text: string; url: string; buttonId?: number }
  | { kind: "switchInline"; text: string; query: string; samePeer: boolean }
  | { kind: "webview"; text: string; url?: string }
  | { kind: "game"; text: string }
  | { kind: "buy"; text: string }
  | { kind: "other"; text: string; className: string };

function serializeButton(btn: any): SerializedButton {
  const cn = String(btn?.className ?? "");
  const text = String(btn?.text ?? "");
  if (cn.includes("Callback")) {
    const data = btn?.data
      ? Buffer.from(btn.data).toString("base64")
      : "";
    return { kind: "callback", text, data, requiresPassword: !!btn?.requiresPassword };
  }
  if (cn === "KeyboardButtonUrl") return { kind: "url", text, url: String(btn?.url ?? "") };
  if (cn === "KeyboardButtonUrlAuth" || cn === "InputKeyboardButtonUrlAuth")
    return { kind: "urlAuth", text, url: String(btn?.url ?? ""), buttonId: btn?.buttonId };
  if (cn === "KeyboardButtonSwitchInline")
    return { kind: "switchInline", text, query: String(btn?.query ?? ""), samePeer: !!btn?.samePeer };
  if (cn === "KeyboardButtonWebView" || cn === "KeyboardButtonSimpleWebView")
    return { kind: "webview", text, url: btn?.url ? String(btn.url) : undefined };
  if (cn === "KeyboardButtonGame") return { kind: "game", text };
  if (cn === "KeyboardButtonBuy") return { kind: "buy", text };
  return { kind: "other", text, className: cn };
}

function serializeReplyMarkup(markup: any): SerializedButton[][] | null {
  if (!markup) return null;
  const cn = String(markup?.className ?? "");
  if (!cn.includes("ReplyInlineMarkup")) return null;
  const rows = Array.isArray(markup.rows) ? markup.rows : [];
  return rows
    .map((row: any) => (Array.isArray(row?.buttons) ? row.buttons.map(serializeButton) : []))
    .filter((r: SerializedButton[]) => r.length > 0);
}

function serializeMediaKind(msg: any): string | null {
  if (!msg?.media) return null;
  const cn = String(msg.media.className ?? "");
  if (cn.includes("Photo")) return "photo";
  if (cn.includes("Document")) return "document";
  if (cn.includes("Video")) return "video";
  if (cn.includes("Voice") || cn.includes("Audio")) return "audio";
  if (cn.includes("Poll")) return "poll";
  if (cn.includes("Webpage")) return "webpage";
  return "other";
}

async function fetchRepliesForPair(
  client: any,
  Api: any,
  target: string,
  sinceMs: number,
  sinceMsgId: number,
  meId: string,
) {
  const peer = await resolveTargetEntity(client, Api, target);
  // When sinceMsgId=0 we re-fetch the latest 12 so edits + newly-added inline
  // buttons on existing messages show up. When >0 we only pull strictly newer.
  const raw = await client.getMessages(peer, {
    limit: 12,
    ...(sinceMsgId ? { minId: sinceMsgId } : {}),
  });
  const chronological = [...raw].reverse();
  const filtered = chronological.filter((m: any) => {
    const dateMs = Number(m?.date ?? 0) * 1000;
    // Keep messages from bots/others sent after our broadcast.
    if (dateMs && dateMs + 2000 < sinceMs) return false;
    // Drop our own outgoing messages (the broadcast itself).
    if (m?.out) return false;
    const fromUserId = m?.fromId?.userId ?? m?.senderId;
    if (fromUserId && String(fromUserId) === meId) return false;
    return true;
  });

  return filtered.map((m: any) => ({
    id: Number(m.id),
    date: m.date ? Number(m.date) * 1000 : Date.now(),
    editDate: m.editDate ? Number(m.editDate) * 1000 : null,
    senderId: m.fromId?.userId ? String(m.fromId.userId) : null,
    text: typeof m.message === "string" ? m.message : "",
    mediaKind: serializeMediaKind(m),
    replyMarkup: serializeReplyMarkup(m.replyMarkup),
  }));
}

// ── getBroadcastReplies ────────────────────────────────────────────────
export const getBroadcastReplies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ runId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const supabase = context.supabase;

    const { data: run, error } = await supabase
      .from("action_runs")
      .select("id, kind, params, created_at")
      .eq("id", data.runId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!run) throw new Error("Run not found");
    if (run.kind !== "broadcast") throw new Error("This run is not a broadcast");

    const op = (run.params as any)?.op ?? run.params ?? {};
    const rows: Array<{ accountId: string; targets: string[] }> = Array.isArray(op.rows) ? op.rows : [];
    const sinceMs = new Date(run.created_at).getTime() - 5000;

    // Group targets by account so each account only connects once.
    const byAccount = new Map<string, string[]>();
    for (const r of rows) {
      const arr = byAccount.get(r.accountId) ?? [];
      for (const t of r.targets ?? []) arr.push(t);
      byAccount.set(r.accountId, arr);
    }

    // Load account labels in one query.
    const { data: accts } = await supabase
      .from("telegram_accounts")
      .select("id, first_name, last_name, username, phone")
      .in("id", [...byAccount.keys()]);
    const labelOf = new Map<string, string>();
    for (const a of accts ?? []) {
      const name = [a.first_name, a.last_name].filter(Boolean).join(" ") ||
        a.username ||
        a.phone ||
        a.id.slice(0, 8);
      labelOf.set(a.id, name);
    }

    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");

    const results: Array<{
      accountId: string;
      accountName: string;
      target: string;
      messages: Awaited<ReturnType<typeof fetchRepliesForPair>>;
      error: string | null;
    }> = [];

    // Process up to 4 accounts concurrently.
    const entries = [...byAccount.entries()];
    const CONCURRENCY = 4;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const slice = entries.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async ([accountId, targets]) => {
          let client: any = null;
          try {
            client = await openClientForAccount(supabase, accountId);
            const me = await client.getMe();
            const meId = String((me as any).id);
            for (const target of targets) {
              try {
                const messages = await fetchRepliesForPair(client, Api, target, sinceMs, 0, meId);
                results.push({
                  accountId,
                  accountName: labelOf.get(accountId) ?? accountId.slice(0, 8),
                  target,
                  messages,
                  error: null,
                });
              } catch (e) {
                results.push({
                  accountId,
                  accountName: labelOf.get(accountId) ?? accountId.slice(0, 8),
                  target,
                  messages: [],
                  error: (e as Error).message || String(e),
                });
              }
            }
          } catch (e) {
            for (const target of targets) {
              results.push({
                accountId,
                accountName: labelOf.get(accountId) ?? accountId.slice(0, 8),
                target,
                messages: [],
                error: `Connect failed: ${(e as Error).message || String(e)}`,
              });
            }
          } finally {
            await client?.disconnect?.().catch(() => {});
          }
        }),
      );
    }

    return {
      runId: run.id,
      runCreatedAt: new Date(run.created_at).getTime(),
      pairs: results,
    };
  });

// ── refreshReplyThread ─────────────────────────────────────────────────
export const refreshReplyThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid(),
        target: z.string().min(1).max(200),
        sinceMs: z.number().int().min(0),
        sinceMsgId: z.number().int().min(0).default(0),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    await assertOwnsAccount(context.supabase, data.accountId);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const me = await client.getMe();
      const meId = String((me as any).id);
      const messages = await fetchRepliesForPair(
        client,
        Api,
        data.target,
        data.sinceMs,
        data.sinceMsgId,
        meId,
      );
      return { messages };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── pressInlineButton ──────────────────────────────────────────────────
export const pressInlineButton = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid(),
        target: z.string().min(1).max(200),
        msgId: z.number().int().positive(),
        // base64-encoded callback data
        data: z.string().min(1).max(700),
        runId: z.string().uuid().optional(),
        buttonLabel: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    await assertOwnsAccount(context.supabase, data.accountId);
    const { insertInlineButtonClick } = await import("./button-clicks.functions");

    // FloodWait guard
    const { data: acct } = await context.supabase
      .from("telegram_accounts")
      .select("paused_until")
      .eq("id", data.accountId)
      .maybeSingle();
    if (acct?.paused_until && new Date(acct.paused_until).getTime() > Date.now()) {
      throw new Error("Account is paused (FloodWait). Try again later.");
    }

    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const peer = await resolveTargetEntity(client, Api, data.target);
      const buf = Buffer.from(data.data, "base64");
      let res: any;
      try {
        res = await client.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer,
            msgId: data.msgId,
            data: buf,
          }),
        );
      } catch (e) {
        const em = (e as Error).message || String(e);
        // Surface FloodWait cleanly and pause the account
        const fw = parseFloodWait(e);
        if (fw) {
          const secs = fw.seconds;
          await context.supabase
            .from("telegram_accounts")
            .update({
              paused_until: new Date(Date.now() + secs * 1000).toISOString(),
              last_error: `FloodWait ${secs}s`,
            })
            .eq("id", data.accountId);
          await insertInlineButtonClick(context.supabase, context.userId, {
            runId: data.runId ?? null,
            accountId: data.accountId,
            target: data.target,
            msgId: data.msgId,
            buttonKind: "callback",
            buttonLabel: data.buttonLabel ?? null,
            buttonPayload: data.data,
            source: "broadcast",
            resultStatus: "error",
            resultMessage: `FloodWait ${secs}s — account paused`,
          });
          throw new Error(`FloodWait ${secs}s — account paused`);
        }
        await insertInlineButtonClick(context.supabase, context.userId, {
          runId: data.runId ?? null,
          accountId: data.accountId,
          target: data.target,
          msgId: data.msgId,
          buttonKind: "callback",
          buttonLabel: data.buttonLabel ?? null,
          buttonPayload: data.data,
          source: "broadcast",
          resultStatus: "error",
          resultMessage: em,
        });
        throw new Error(em);
      }
      await insertInlineButtonClick(context.supabase, context.userId, {
        runId: data.runId ?? null,
        accountId: data.accountId,
        target: data.target,
        msgId: data.msgId,
        buttonKind: "callback",
        buttonLabel: data.buttonLabel ?? null,
        buttonPayload: data.data,
        source: "broadcast",
        resultStatus: "ok",
        resultMessage: res?.message ? String(res.message) : null,
        resultAlert: !!res?.alert,
        resultUrl: res?.url ? String(res.url) : null,
      });
      return {
        message: res?.message ? String(res.message) : "",
        alert: !!res?.alert,
        url: res?.url ? String(res.url) : null,
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });