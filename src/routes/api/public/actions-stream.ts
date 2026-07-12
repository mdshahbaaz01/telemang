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
  isVoice: z.boolean().optional(),
});

const broadcastRowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  attachment: attachmentSchema.optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
}).refine((r) => r.message.length > 0 || !!r.attachment || (r.attachments?.length ?? 0) > 0, {
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
  attachments: z.array(attachmentSchema).max(10).optional(),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
}).refine((r) => r.message.length > 0 || !!r.attachment || (r.attachments?.length ?? 0) > 0, {
  message: "Row needs a message or an attachment",
});

const replySchema = z.object({
  kind: z.literal("reply"),
  source: msgRefSchema,
  viaDiscussion: z.boolean().optional(), // true = comment under a channel post
  rows: z.array(replyRowSchema).min(1).max(200),
});

const botFlowSchema = z.object({
  kind: z.literal("botflow"),
  bot: z.string().min(1).max(200),
  startParam: z.string().max(200).optional(),
  steps: z.array(z.string().min(1).max(4096)).min(1).max(50),
  autoJoinRequired: z.boolean().optional(),
  maxJoinRounds: z.number().int().min(1).max(15).optional(),
});

const editSchema = z.object({
  kind: z.literal("edit"),
  source: msgRefSchema,
  message: z.string().min(1).max(4096),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
});

const deleteMessagesSchema = z.object({
  kind: z.literal("deleteMessages"),
  chat: z.string().min(1).max(200),
  messageIds: z.array(z.number().int().positive()).min(1).max(100),
  revoke: z.boolean().default(true),
});

const bodySchema = z.object({
  accountIds: z.array(z.string().uuid()).min(0).max(200).default([]),
  minDelay: z.number().int().min(0).max(60).default(1),
  maxDelay: z.number().int().min(0).max(60).default(2),
  concurrency: z.number().int().min(1).max(20).default(5),
  op: z.discriminatedUnion("kind", [reactSchema, forwardSchema, voteSchema, broadcastSchema, replySchema, botFlowSchema, editSchema, deleteMessagesSchema]),
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

import { formatMessage } from "@/lib/message-format";

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
              if (level === "error") {
                void maybeOwnerAlertFromError(accountId, message);
              }
            };

            const alertLog = async (event: string, title: string, bodyText: string) => {
              const { notifyUser } = await import("@/lib/notifications.server");
              await notifyUser(supabase, userId, event as "success" | "failure" | "account", title, bodyText)
                .catch(() => undefined);
            };

            // De-duplicate owner alerts per run: only first ban / peer_flood per account fires.
            const ownerAlerted = new Set<string>();
            const maybeOwnerAlertFromError = async (accountId: string | null, message: string) => {
              try {
                const isBan = /USER_BANNED_IN_CHANNEL|CHAT_WRITE_FORBIDDEN|USER_DEACTIVATED|USER_BANNED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(message);
                const isPeerFlood = /PEER_FLOOD/i.test(message);
                if (!isBan && !isPeerFlood) return;
                const key = `${accountId ?? "?"}:${isBan ? "ban" : "pf"}`;
                if (ownerAlerted.has(key)) return;
                ownerAlerted.add(key);
                const { notifyOwner } = await import("@/lib/notifications.server");
                const shortId = accountId ? accountId.slice(0, 8) : "unknown";
                await notifyOwner(
                  supabase,
                  userId,
                  isBan ? "ban" : "peer_flood",
                  isBan ? "Account ban detected" : "Peer flood detected",
                  `Account ${shortId}: ${message}`,
                ).catch(() => undefined);
              } catch {
                /* swallow — alerts must never break a run */
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
            const { resolveTargetEntity } = await import("@/lib/telegram-target-resolver.server");
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
                const tryResolve = async () => {
                  try {
                    return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
                  } catch {
                    return await client.getEntity(`https://t.me/c/${raw}/${src.msgId}`);
                  }
                };
                try {
                  peer = await tryResolve();
                } catch (e) {
                  // Prime gramjs entity cache by walking dialogs, then retry once.
                  try {
                    await client.getDialogs({ limit: 1000 });
                  } catch {}
                  peer = await tryResolve();
                }
              } else {
                peer = await client.getEntity(src.chat.replace(/^@/, ""));
              }
              return peer;
            };

            // Auto-join a channel/supergroup if the account isn't already a member.
            // Safe to call for any entity: broadcasts return early, private c/<id>
            // sources cannot be joined without an invite link so we skip those, and
            // an already-joined channel throws USER_ALREADY_PARTICIPANT which we swallow.
            const ensureJoined = async (client: any, entity: any, label: string, accountId: string) => {
              try {
                if (!entity || !entity.className) return;
                if (!/^Channel$/i.test(entity.className)) return; // plain groups: can't join via link
                if (entity.left === false || entity.creator || entity.adminRights) return; // already in
                await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
                send("log", { accountId, level: "info", message: `Joined ${label}` });
                await logDb(accountId, label, "info", `Joined ${label} before commenting/replying`);
              } catch (e) {
                const em = errorText(e);
                if (/ALREADY_PARTICIPANT|USER_ALREADY/i.test(em)) return;
                send("log", { accountId, level: "warn", message: `Auto-join ${label} failed: ${em}` });
              }
            };

            const resolveTarget = async (client: any, t: string) => {
              return resolveTargetEntity(client, Api, t);
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
              const match = message.match(/FLOOD_WAIT_?(\d+)/i);
              const secs = match ? Number(match[1]) : null;
              if (!secs) return false;
              const pausedUntil = new Date(Date.now() + secs * 1000).toISOString();
              await supabase
                .from("telegram_accounts")
                .update({ paused_until: pausedUntil, last_error: `FloodWait ${secs}s` })
                .eq("id", accountId);
              await alertLog("account", "FloodWait detected", `Account ${accountId.slice(0, 8)} paused for ${secs}s: ${message}`);
              try {
                const { notifyOwner } = await import("@/lib/notifications.server");
                await notifyOwner(
                  supabase,
                  userId,
                  "peer_flood",
                  "FloodWait triggered",
                  `Account ${accountId.slice(0, 8)} paused ${secs}s — ${message}`,
                ).catch(() => undefined);
              } catch { /* ignore */ }
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
              if (body.op.kind === "broadcast" || body.op.kind === "reply" || body.op.kind === "botflow") return { ok: 0, fail: 0 };
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
                const src = op.kind === "deleteMessages" ? { chat: op.chat, msgId: op.messageIds[0] } : op.source;
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
                    // Always clear any previous reaction so a re-run is idempotent.
                    try {
                      await client.invoke(
                        new Api.messages.SendReaction({ peer: sourcePeer, msgId: src.msgId, reaction: [] }),
                      );
                    } catch {}
                    const clearOnly = op.mode === "clear";
                    if (!clearOnly) {
                      await client.invoke(
                        new Api.messages.SendReaction({
                          peer: sourcePeer,
                          msgId: src.msgId,
                          reaction: [await buildReaction(op.emoji, op.customEmojiId)],
                        }),
                      );
                    }
                    ok++;
                    const m = clearOnly
                      ? "Reaction taken back"
                      : op.customEmojiId ? `Reacted custom:${op.customEmojiId}` : `Reacted ${op.emoji}`;
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
                    const clearOnly = op.mode === "clear";
                    const chosen = op.options
                      .map((i) => answers[i]?.option)
                      .filter((x): x is Uint8Array => !!x)
                      .map((x) => Buffer.from(x));
                    if (!clearOnly && chosen.length === 0) throw new Error("No matching poll options");
                    // Always retract any previous vote first so a re-run just works.
                    try {
                      await client.invoke(
                        new Api.messages.SendVote({ peer: sourcePeer, msgId: src.msgId, options: [] }),
                      );
                    } catch {}
                    if (!clearOnly) {
                      await client.invoke(
                        new Api.messages.SendVote({
                          peer: sourcePeer,
                          msgId: src.msgId,
                          options: chosen,
                        }),
                      );
                    }
                    ok++;
                    const m = clearOnly ? "Vote taken back" : `Voted options ${op.options.join(",")}`;
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
                } else if (op.kind === "edit") {
                  try {
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                    const formatted = formatMessage(op.message, op.format);
                    await client.editMessage(sourcePeer, {
                      message: src.msgId,
                      text: formatted.message,
                      parseMode: formatted.parseMode,
                    });
                    ok++;
                    const m = `Edited ${src.chat}/${src.msgId}`;
                    send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
                  } catch (e) {
                    fail++;
                    const m = errorText(e);
                    send("log", { accountId, level: "error", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "error", m);
                  }
                } else if (op.kind === "deleteMessages") {
                  try {
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                    await client.deleteMessages(sourcePeer, op.messageIds, { revoke: op.revoke });
                    ok += op.messageIds.length;
                    const m = `Deleted ${op.messageIds.length} message(s)`;
                    send("log", { accountId, level: "success", target: op.chat, message: m });
                    await logDb(accountId, op.chat, "success", m);
                  } catch (e) {
                    fail += op.messageIds.length;
                    const m = errorText(e);
                    send("log", { accountId, level: "error", target: op.chat, message: m });
                    await logDb(accountId, op.chat, "error", m);
                  }
                }
              } finally {
                await client.disconnect().catch(() => {});
                send("done", { accountId, ok, fail });
              }
              return { ok, fail };
            };

            const runBroadcastRowsForAccount = async (accountId: string, rows: Array<{ accountId: string; message: string; targets: string[]; attachment?: { path: string; filename: string; mimeType?: string; isVoice?: boolean }; format?: "plain" | "mono" | "quote" | "html" }>) => {
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
                  const rowAtts = ((row as any).attachments && (row as any).attachments.length > 0
                    ? (row as any).attachments
                    : row.attachment
                      ? [row.attachment]
                      : []) as Array<{ path: string; filename: string; mimeType?: string; isVoice?: boolean }>;
                  let attDatas: Array<{ buf: Buffer; filename: string; mimeType?: string; isVoice?: boolean }> = [];
                  if (rowAtts.length) {
                    try {
                      attDatas = await Promise.all(rowAtts.map((a) => loadAttachment(a)));
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
                      if (attDatas.length > 1) {
                        const formatted = formatMessage(row.message, row.format);
                        await client.sendFile(dest, {
                          file: attDatas.map((a) => buildCustomFile(a)),
                          caption: formatted.message || undefined,
                          parseMode: formatted.parseMode,
                        });
                      } else if (attDatas.length === 1) {
                        const attData = attDatas[0];
                        const formatted = formatMessage(row.message, row.format);
                        await client.sendFile(dest, {
                          file: buildCustomFile(attData),
                          caption: formatted.message || undefined,
                          parseMode: formatted.parseMode,
                          voiceNote: !!rowAtts[0]?.isVoice,
                        });
                      } else {
                        await client.sendMessage(dest, formatMessage(row.message, row.format));
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
              row: { accountId: string; message: string; attachment?: { path: string; filename: string; mimeType?: string; isVoice?: boolean }; format?: "plain" | "mono" | "quote" | "html" },
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
                // Auto-join channel first if the account is not a member.
                await ensureJoined(client, sourcePeer, src.chat, accountId);
                // View the post like a real reader before replying/commenting
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
                  // Also join the linked discussion group so comments can be posted.
                  await ensureJoined(client, replyPeer, `${src.chat} (discussion)`, accountId);
                }
                const rowAtts = ((row as any).attachments && (row as any).attachments.length > 0
                  ? (row as any).attachments
                  : row.attachment
                    ? [row.attachment]
                    : []) as Array<{ path: string; filename: string; mimeType?: string; isVoice?: boolean }>;
                if (rowAtts.length > 1) {
                  const atts = await Promise.all(rowAtts.map((a) => loadAttachment(a)));
                  const formatted = formatMessage(row.message, row.format);
                  await client.sendFile(replyPeer, {
                    file: atts.map((a) => buildCustomFile(a)),
                    caption: formatted.message || undefined,
                    parseMode: formatted.parseMode,
                    replyTo: replyToId,
                    ...(topMsgId ? { topMsgId } : {}),
                  });
                } else if (rowAtts.length === 1) {
                  const att = await loadAttachment(rowAtts[0]);
                  const formatted = formatMessage(row.message, row.format);
                  await client.sendFile(replyPeer, {
                    file: buildCustomFile(att),
                    caption: formatted.message || undefined,
                    parseMode: formatted.parseMode,
                    voiceNote: !!rowAtts[0]?.isVoice,
                    replyTo: replyToId,
                    ...(topMsgId ? { topMsgId } : {}),
                  });
                } else {
                  await client.sendMessage(replyPeer, {
                    ...formatMessage(row.message, row.format),
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

            const parseBotHandle = (raw: string) => {
              let s = raw.trim();
              s = s.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "");
              s = s.replace(/^@/, "");
              // Support t.me/bot?start=xxx or t.me/bot?startapp=xxx
              let startParam: string | undefined;
              const q = s.indexOf("?");
              if (q >= 0) {
                const query = new URLSearchParams(s.slice(q + 1));
                startParam = query.get("start") ?? query.get("startapp") ?? undefined;
                s = s.slice(0, q);
              }
              // Drop trailing paths
              s = s.split("/")[0];
              return { username: s, startParam };
            };

            const runBotFlowForAccount = async (accountId: string, op: { bot: string; startParam?: string; steps: string[]; autoJoinRequired?: boolean; maxJoinRounds?: number }) => {
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
              let botPeer: any;
              try {
                const parsed = parseBotHandle(op.bot);
                const startParam = op.startParam?.trim() || parsed.startParam;
                const botLabel = `@${parsed.username}`;
                try {
                  botPeer = await client.getEntity(parsed.username);
                } catch (e) {
                  const msg = `Resolve bot failed: ${(e as Error).message}`;
                  send("log", { accountId, level: "error", target: botLabel, message: msg });
                  await logDb(accountId, botLabel, "error", msg);
                  return { ok: 0, fail: 1 };
                }

                // Kick off with /start (+ optional deep link param) so the bot is initialized.
                const doStartBot = async () => {
                  const { default: bigInt } = await import("big-integer");
                  const randomId = bigInt(Math.floor(Math.random() * 1e15));
                  await client.invoke(
                    new Api.messages.StartBot({
                      bot: botPeer,
                      peer: botPeer,
                      randomId,
                      startParam: startParam ?? "",
                    }),
                  );
                };
                try {
                  await doStartBot();
                  send("log", { accountId, level: "success", target: botLabel, message: startParam ? `Started with param "${startParam}"` : "Started" });
                  await logDb(accountId, botLabel, "success", startParam ? `Started with param "${startParam}"` : "Started");
                } catch (e) {
                  const em = errorText(e);
                  send("log", { accountId, level: "warn", target: botLabel, message: `StartBot: ${em}` });
                  await logDb(accountId, botLabel, "warn", `StartBot: ${em}`);
                }

                // ── Auto-join required channels ─────────────────────────
                // Many referral bots reply with "Please join these channels"
                // and a list of URL buttons / t.me links. Detect them, join
                // from this account, then re-fire /start so the bot re-checks.
                if (op.autoJoinRequired !== false) {
                  const rounds = Math.max(1, Math.min(15, op.maxJoinRounds ?? 10));
                  const alreadyJoined = new Set<string>();
                  const linkRe = /(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/(\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+|[A-Za-z0-9_]{4,})/gi;
                  for (let round = 0; round < rounds; round++) {
                    if (stopRequested) break;
                    // Give the bot a brief moment to reply (short = fast).
                    await new Promise((r) => setTimeout(r, 900));
                    let recent: any[] = [];
                    try { recent = await client.getMessages(botPeer, { limit: 5 }) as any[]; } catch { recent = []; }
                    const candidates: string[] = [];
                    let joinHintSeen = false;
                    for (const m of recent) {
                      const text = String(m?.message ?? m?.text ?? "");
                      if (/join|जॉइन|加入|подпис/i.test(text)) joinHintSeen = true;
                      let match: RegExpExecArray | null;
                      while ((match = linkRe.exec(text)) !== null) candidates.push(match[1]);
                      const rows: any[] = m?.replyMarkup?.rows ?? [];
                      for (const row of rows) for (const btn of (row?.buttons ?? [])) {
                        const url: string | undefined = btn?.url;
                        if (!url) continue;
                        if (/t(?:elegram)?\.me\//i.test(url)) joinHintSeen = true;
                        const mm = linkRe.exec(url);
                        linkRe.lastIndex = 0;
                        if (mm) candidates.push(mm[1]);
                      }
                    }
                    // Deduplicate + skip bot itself and already-joined.
                    const targets = Array.from(new Set(candidates))
                      .filter((c) => c && c.toLowerCase() !== parsed.username.toLowerCase() && !alreadyJoined.has(c.toLowerCase()));
                    if (!targets.length) {
                      // Nothing new to join. If the bot still shows a join
                      // prompt, re-fire /start once more in case it just
                      // needs a nudge; otherwise we're done.
                      if (joinHintSeen && round === 0) {
                        try { await doStartBot(); } catch { /* noop */ }
                        continue;
                      }
                      break;
                    }
                    let joinedThisRound = 0;
                    // Join in parallel batches for speed.
                    const joinOne = async (target: string) => {
                      if (stopRequested) return "stop";
                      alreadyJoined.add(target.toLowerCase());
                      try {
                        if (target.startsWith("+") || target.toLowerCase().startsWith("joinchat/")) {
                          const hash = target.startsWith("+") ? target.slice(1) : target.split("/")[1];
                          try {
                            await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                            joinedThisRound++;
                            send("log", { accountId, level: "success", target: botLabel, message: `Joined invite +${hash.slice(0, 8)}…` });
                          } catch (e) {
                            const em = errorText(e);
                            if (/USER_ALREADY_PARTICIPANT|INVITE_HASH_EXPIRED|CHANNELS_TOO_MUCH/i.test(em)) {
                              send("log", { accountId, level: "info", target: botLabel, message: `Invite +${hash.slice(0, 8)}: ${em}` });
                            } else throw e;
                          }
                        } else {
                          const ent: any = await client.getEntity(target);
                          try {
                            await client.invoke(new Api.channels.JoinChannel({ channel: ent }));
                            joinedThisRound++;
                            send("log", { accountId, level: "success", target: botLabel, message: `Joined @${target}` });
                          } catch (e) {
                            const em = errorText(e);
                            if (/USER_ALREADY_PARTICIPANT|CHANNELS_TOO_MUCH/i.test(em)) {
                              send("log", { accountId, level: "info", target: botLabel, message: `@${target}: ${em}` });
                            } else throw e;
                          }
                        }
                      } catch (e) {
                        const em = errorText(e);
                        const secs = await pauseAccountOnFlood(accountId, em);
                        if (secs) {
                          send("log", { accountId, level: "warn", target: botLabel, message: `FloodWait ${secs}s — account paused` });
                          return "flood";
                        }
                        send("log", { accountId, level: "warn", target: botLabel, message: `Join ${target}: ${em}` });
                      }
                      // Tiny pacing to avoid the API smacking us.
                      await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
                      return "ok";
                    };
                    // 4-wide parallel joins per account.
                    const batchSize = 4;
                    let floodHit = false;
                    for (let i = 0; i < targets.length; i += batchSize) {
                      if (stopRequested || floodHit) break;
                      const batch = targets.slice(i, i + batchSize);
                      const outs = await Promise.all(batch.map((t) => joinOne(t)));
                      if (outs.includes("flood")) { floodHit = true; break; }
                    }
                    if (!joinedThisRound) break;
                    // Re-fire /start so the bot re-verifies membership.
                    try {
                      await doStartBot();
                      send("log", { accountId, level: "success", target: botLabel, message: `Re-started after joining ${joinedThisRound} chat(s)` });
                    } catch (e) {
                      send("log", { accountId, level: "warn", target: botLabel, message: `Re-start: ${errorText(e)}` });
                    }
                  }
                }

                for (const rawStep of op.steps) {
                  if (stopRequested) break;
                  const step = rawStep.trim();
                  if (!step || step.startsWith("#")) continue;
                  const colon = step.indexOf(":");
                  const cmd = (colon >= 0 ? step.slice(0, colon) : step).trim().toLowerCase();
                  const arg = colon >= 0 ? step.slice(colon + 1).trim() : "";
                  try {
                    if (cmd === "wait" || cmd === "sleep") {
                      const secs = Math.max(0, Math.min(120, Number(arg) || 0));
                      send("log", { accountId, level: "info", target: botLabel, message: `Wait ${secs}s` });
                      await new Promise((r) => setTimeout(r, secs * 1000));
                    } else if (cmd === "text" || cmd === "send") {
                      if (!arg) throw new Error("empty text");
                      await client.sendMessage(botPeer, { message: arg });
                      ok++;
                      send("log", { accountId, level: "success", target: botLabel, message: `Sent: ${arg.slice(0, 80)}` });
                      await logDb(accountId, botLabel, "success", `Sent: ${arg}`);
                    } else if (cmd === "start") {
                      const { default: bigInt } = await import("big-integer");
                      const randomId = bigInt(Math.floor(Math.random() * 1e15));
                      await client.invoke(
                        new Api.messages.StartBot({ bot: botPeer, peer: botPeer, randomId, startParam: arg }),
                      );
                      ok++;
                      send("log", { accountId, level: "success", target: botLabel, message: `Re-started${arg ? ` (${arg})` : ""}` });
                      await logDb(accountId, botLabel, "success", `Re-started${arg ? ` (${arg})` : ""}`);
                    } else if (cmd === "click" || cmd === "tap" || cmd === "button") {
                      // Find latest bot message with an inline/reply keyboard button matching arg.
                      const wanted = arg.toLowerCase();
                      const recent = await client.getMessages(botPeer, { limit: 10 });
                      let clicked = false;
                      for (const m of recent as any[]) {
                        const rm: any = m?.replyMarkup;
                        const rows: any[] = rm?.rows ?? [];
                        for (const row of rows) {
                          for (const btn of (row?.buttons ?? [])) {
                            const label = String(btn?.text ?? "").toLowerCase();
                            if (!label.includes(wanted)) continue;
                            const cls = btn?.className || btn?.CONSTRUCTOR_ID;
                            if (btn?.data) {
                              // Inline callback button
                              await client.invoke(
                                new Api.messages.GetBotCallbackAnswer({ peer: botPeer, msgId: m.id, data: btn.data }),
                              );
                              clicked = true;
                            } else if (btn?.url) {
                              send("log", { accountId, level: "warn", target: botLabel, message: `Skipped URL button "${btn.text}"` });
                              clicked = true;
                            } else {
                              // Reply-keyboard button — send its label as a message.
                              await client.sendMessage(botPeer, { message: btn.text });
                              clicked = true;
                            }
                            void cls;
                            break;
                          }
                          if (clicked) break;
                        }
                        if (clicked) break;
                      }
                      if (!clicked) throw new Error(`Button "${arg}" not found`);
                      ok++;
                      send("log", { accountId, level: "success", target: botLabel, message: `Clicked "${arg}"` });
                      await logDb(accountId, botLabel, "success", `Clicked "${arg}"`);
                    } else {
                      throw new Error(`Unknown step "${cmd}"`);
                    }
                  } catch (e) {
                    fail++;
                    const em = errorText(e);
                    const secs = await pauseAccountOnFlood(accountId, em);
                    if (secs) {
                      send("log", { accountId, level: "warn", target: botLabel, message: `FloodWait ${secs}s — account paused` });
                      await logDb(accountId, botLabel, "warn", `FloodWait ${secs}s`);
                      break;
                    }
                    send("log", { accountId, level: "error", target: botLabel, message: `${step} — ${em}` });
                    await logDb(accountId, botLabel, "error", `${step} — ${em}`);
                  }
                  // Small pacing between steps
                  await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
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
                  ? await runWithConcurrency(groupByAccount(body.op.rows), body.concurrency, ([accountId, rows]) => runBroadcastRowsForAccount(accountId, rows))
                  : body.op.kind === "reply"
                    ? await runWithConcurrency(
                        groupByAccount(body.op.rows),
                        body.concurrency,
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
                    : body.op.kind === "botflow"
                      ? await runWithConcurrency(body.accountIds, body.concurrency, (id) => runBotFlowForAccount(id, body.op as any))
                      : await runWithConcurrency(body.accountIds, Math.max(body.concurrency, 1), (id) => runOne(id));
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
              await alertLog(totalFail ? "failure" : "success", totalFail ? "Action finished with failures" : "Action completed", `${body.op.kind}: ok ${totalOk}, fail ${totalFail}`);
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