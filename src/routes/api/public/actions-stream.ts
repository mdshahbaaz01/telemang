import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";
import {
  getPacingConfig,
  loadCacheForAccount,
  tryAcquireJoinLock,
  finalizeJoinLock,
  logJoinAttempt,
  jitteredDelayMs,
  normalizeTargetKey,
  type PacingConfig,
} from "@/lib/join-cache.server";
import { adaptivePacing } from "@/lib/telegram/executor.server";
import { markPeerRead } from "@/lib/telegram-read-helper.server";

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
  dropAuthor: z.boolean().optional(),
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
  bot: z.string().max(200).default(""),
  startParam: z.string().max(200).optional(),
  steps: z.array(z.string().min(1).max(4096)).min(0).max(50),
  autoJoinRequired: z.boolean().optional(),
  maxJoinRounds: z.number().int().min(1).max(15).optional(),
  preJoinChannels: z.array(z.string().min(1).max(300)).max(100).optional(),
  preJoinOnly: z.boolean().optional(),
  publicInviteFallback: z.boolean().optional(),
  forceRejoin: z.boolean().optional(),
  parallel: z.boolean().optional(),
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
            const { joinTelegramTargetVerified, extractTelegramErrorCode } = await import("@/lib/telegram-join-helper.server");
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
              let client: any;
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
                    // Mark chat as read like a real user would before reacting
                    await markPeerRead(client, sourcePeer, src.msgId);
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
                  // Mark source chat as read before forwarding
                  await markPeerRead(client, sourcePeer, src.msgId);
                  for (const t of op.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await resolveTarget(client, t);
                      // Read destination chat first, then forward
                      await markPeerRead(client, dest);
                      const { default: bigInt } = await import("big-integer");
                      await client.invoke(
                        new Api.messages.ForwardMessages({
                          fromPeer: sourcePeer,
                          id: [src.msgId],
                          randomId: [bigInt(Math.floor(Math.random() * 1e18))],
                          toPeer: dest,
                          dropAuthor: op.dropAuthor === true,
                        }),
                      );
                      ok++;
                      const m = op.dropAuthor ? `Forwarded to ${t} (no tag)` : `Forwarded to ${t}`;
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
              let client: any;
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
                      // Mark destination as read before broadcasting
                      await markPeerRead(client, dest);
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
              let client: any;
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

            const runBotFlowForAccount = async (accountId: string, op: { bot: string; startParam?: string; steps: string[]; autoJoinRequired?: boolean; maxJoinRounds?: number; preJoinChannels?: string[]; preJoinOnly?: boolean; publicInviteFallback?: boolean; forceRejoin?: boolean }) => {
              send("log", { accountId, level: "info", message: "Connecting…" });
              let client: any;
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
                const parsed = op.bot ? parseBotHandle(op.bot) : { username: "", startParam: undefined as string | undefined };
                const startParam = op.startParam?.trim() || parsed.startParam;
                const botLabel = op.preJoinOnly ? "pre-join" : `@${parsed.username}`;
                if (!op.preJoinOnly) {
                  try {
                    botPeer = await client.getEntity(parsed.username);
                  } catch (e) {
                    const msg = `Resolve bot failed: ${(e as Error).message}`;
                    send("log", { accountId, level: "error", target: botLabel, message: msg });
                    await logDb(accountId, botLabel, "error", msg);
                    return { ok: 0, fail: 1 };
                  }
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
                // Extract "username" or "+invitehash" from any raw t.me link.
                const extractHandle = (raw: string): string | null => {
                  const s = raw.trim();
                  if (!s) return null;
                  if (s.startsWith("@")) return s.slice(1);
                  const m = s.match(/(?:t(?:elegram)?\.me\/)?(\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+|[A-Za-z0-9_]{4,})/i);
                  return m ? m[1] : null;
                };
                // Join a single channel/invite, with smart handling of small
                // FLOOD_WAITs: sleep locally + retry once instead of pausing
                // the whole account. Returns "ok" | "stop" | "flood" | "skip".
                 const alreadyJoined = new Set<string>();
                 const attemptedThisRun = new Set<string>();
                 // Cross-run dedupe from persistent join_cache (all sources).
                 let pacing: PacingConfig;
                 try {
                   pacing = await getPacingConfig(supabase, userId);
                 } catch {
                   pacing = { min_delay_ms: 800, max_delay_ms: 1500, batch_size: 5, cache_ttl_hours: 720, lock_ttl_seconds: 90 };
                 }
                 // Phase 5b: widen pacing if this account has been floodwaited recently.
                 try {
                   const adaptive = await adaptivePacing(supabase, accountId, pacing);
                   if (adaptive.multiplier > 1.1) {
                     send("log", { accountId, level: "info", target: botLabel, message: `Adaptive pacing ${adaptive.multiplier.toFixed(2)}x (floods=${adaptive.floods}, failures=${adaptive.failures})` });
                   }
                   pacing = { ...pacing, min_delay_ms: adaptive.min_delay_ms, max_delay_ms: adaptive.max_delay_ms };
                 } catch { /* fall back to base pacing */ }
                 try {
                   const cache = await loadCacheForAccount(supabase, accountId);
                   for (const [k, status] of cache.entries()) {
                      if (!op.forceRejoin && (status === "joined" || status === "requested")) alreadyJoined.add(k);
                   }
                 } catch { /* dedupe is best-effort */ }
                const smartJoin = async (rawTarget: string): Promise<"ok" | "requested" | "stop" | "flood" | "skip" | "fail"> => {
                  if (stopRequested) return "stop";
                  const target = extractHandle(rawTarget);
                  const joinLogTarget = rawTarget;
                  if (!target) {
                    send("log", { accountId, level: "error", target: joinLogTarget, message: `Invalid Telegram channel link: ${rawTarget}` });
                    return "fail";
                  }
                  const key = target.toLowerCase();
                  if (alreadyJoined.has(key)) {
                    send("log", { accountId, level: "info", target: joinLogTarget, message: `Skip ${target} — already handled in this run` });
                    return "skip";
                  }
                  if (key === parsed.username.toLowerCase()) {
                    send("log", { accountId, level: "info", target: joinLogTarget, message: `Skip ${target} — this is the bot itself` });
                    return "skip";
                  }
                   attemptedThisRun.add(key);
                    if (op.forceRejoin) {
                      // Wipe any prior cache row so tryAcquireJoinLock doesn't
                      // short-circuit as "skipped_cached".
                      try {
                        await supabase
                          .from("join_cache")
                          .delete()
                          .eq("account_id", accountId)
                          .eq("target_key", normalizeTargetKey(rawTarget));
                      } catch { /* best-effort */ }
                    }
                   // Acquire per-(account, channel) lock — atomic across all workers.
                   const lock = await tryAcquireJoinLock(supabase, {
                     userId, accountId, target: rawTarget,
                      source: op.preJoinOnly ? "bot_flow_prejoin" : "bot_flow_required",
                     lockTtlSeconds: pacing.lock_ttl_seconds,
                   });
                   if (lock.outcome !== "acquired") {
                     alreadyJoined.add(key);
                     await logJoinAttempt(supabase, {
                        userId, accountId, target: rawTarget, source: op.preJoinOnly ? "bot_flow_prejoin" : "bot_flow_required",
                       result: lock.outcome === "skipped_cached" ? "skipped_cached" : "skipped_locked",
                       metadata: { reason: lock.status ?? null },
                     });
                      send("log", { accountId, level: "info", target: joinLogTarget, message: `Skip ${target} — ${lock.outcome === "skipped_cached" ? "already cached" : "in-flight elsewhere"}` });
                     return "skip";
                   }
                   const t0 = Date.now();
                    // Track which code-path the join actually used so operators
                    // can see it in structured logs / DB metadata.
                     let joinPath: "import_invite" | "import_username" | "peek_already" | "peek_username" | "peek_chat" | "peek_search_username" | "direct_username" | "none" = "none";
                    let joinErrorCode: string | null = null;
                    const extractErrCode = (s: string): string | null => {
                       return extractTelegramErrorCode(s);
                    };
                    const isTransient = (em: string) =>
                      /TIMEOUT|TIMED?OUT|NETWORK|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|fetch failed|socket hang up|INTERNAL|503|502|504|Server closed the connection|TransportError|MTProtoError|No workers running|workers running|JOIN_NOT_VERIFIED/i.test(em);
                    const reconnectForRetry = async (reason: string) => {
                      try {
                        send("log", { accountId, level: "info", target: joinLogTarget, message: `Reconnecting Telegram session after retryable error: ${reason}` });
                        await client?.disconnect?.().catch(() => {});
                        client = await openClientForAccount(supabase, accountId);
                        return true;
                      } catch (error) {
                        send("log", { accountId, level: "warn", target: joinLogTarget, message: `Reconnect failed: ${errorText(error)}` });
                        return false;
                      }
                    };
                    const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
                      let timer: ReturnType<typeof setTimeout> | undefined;
                      try {
                        return await Promise.race([
                          promise,
                          new Promise<T>((_, reject) => {
                            timer = setTimeout(() => reject(new Error(`JOIN_TIMEOUT_${Math.round(ms / 1000)}S`)), ms);
                          }),
                        ]);
                      } finally {
                        if (timer) clearTimeout(timer);
                      }
                    };
                    const attempt = async (): Promise<"ok" | "requested" | "flood" | "skip" | "transient" | "fail"> => {
                    try {
                       send("log", { accountId, level: "info", target: joinLogTarget, message: `Attempting join ${target}…` });
                       const result = await withTimeout(joinTelegramTargetVerified({
                         client,
                         Api,
                         target,
                         publicInviteFallback: op.publicInviteFallback !== false,
                          log: (level, message) => send("log", { accountId, level, target: joinLogTarget, message }),
                        }), 45_000);
                       joinPath = result.path;
                       joinErrorCode = result.errorCode;
                        send("log", { accountId, level: result.status === "requested" ? "info" : "success", target: joinLogTarget, message: `${result.message}${result.verified ? " · membership verified" : ""}` });
                       return result.status === "requested" ? "requested" : "ok";
                    } catch (e) {
                      const em = errorText(e);
                       joinErrorCode = joinErrorCode ?? extractErrCode(em);
                       if (/USER_ALREADY_PARTICIPANT/i.test(em)) {
                         send("log", { accountId, level: "success", target: joinLogTarget, message: `${target}: already a member` });
                         return "ok";
                       }
                       if (/INVITE_REQUEST_SENT|INVITE_REQUEST_ALREADY_SENT|REQUEST_SENT/i.test(em)) {
                         send("log", { accountId, level: "info", target: joinLogTarget, message: `${target}: join request sent, waiting for approval` });
                         return "requested";
                       }
                       if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|CHANNELS_TOO_MUCH|USER_BANNED_IN_CHANNEL|USER_RESTRICTED|CHANNEL_PRIVATE|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|PEER_ID_INVALID/i.test(em)) {
                         send("log", { accountId, level: "error", target: joinLogTarget, message: `Failed ${target}: ${em}` });
                         return "fail";
                      }
                      const secs = floodWaitSeconds(em);
                      if (secs !== null) {
                        if (secs <= 30) {
                           send("log", { accountId, level: "info", target: joinLogTarget, message: `Rate-limited, waiting ${secs}s…` });
                          await new Promise((r) => setTimeout(r, (secs + 1) * 1000));
                          return "flood"; // caller decides whether to retry
                        }
                        const p = await pauseAccountOnFlood(accountId, em);
                         send("log", { accountId, level: "warn", target: joinLogTarget, message: `FloodWait ${p ?? secs}s — account paused` });
                        return "flood";
                      }
                        if (isTransient(em)) {
                           send("log", { accountId, level: "info", target: joinLogTarget, message: `Retryable join issue (${target}): ${em}` });
                          return "transient";
                        }
                        send("log", { accountId, level: "error", target: joinLogTarget, message: `Failed ${target} (path=${joinPath}, code=${joinErrorCode ?? "?"}): ${em}` });
                       return "fail";
                    }
                  };
                   let out = await attempt();
                    // Exponential backoff for transient errors — up to 3 tries
                    // (1s, 2s, 4s ± jitter). Non-flood transient failures no
                    // longer permanently skip the target.
                    if (out === "transient") {
                      for (let i = 0; i < 3 && !stopRequested; i++) {
                        const backoff = Math.round((1000 * Math.pow(2, i)) * (0.85 + Math.random() * 0.3));
                        send("log", { accountId, level: "info", target: joinLogTarget, message: `Retry ${i + 1}/3 in ${Math.round(backoff / 1000)}s…` });
                        await reconnectForRetry(target);
                        await new Promise((r) => setTimeout(r, backoff));
                        if (stopRequested) return "stop";
                        out = await attempt();
                        if (out !== "transient") break;
                      }
                      if (out === "transient") {
                        send("log", { accountId, level: "error", target: joinLogTarget, message: `Failed ${target} — Telegram session stayed disconnected after retries` });
                        out = "fail";
                      }
                    }
                   // Strict single-attempt policy: one (account, channel) →
                   // exactly one request. On FLOOD/short-wait we do NOT retry
                   // (the local sleep inside attempt() has already elapsed),
                   // so we never hammer the same target twice from the same
                   // account in the same run. The join_cache + lock guarantees
                   // it also never re-runs across future runs.
                   if (out === "flood" && op.preJoinOnly) {
                      send("log", { accountId, level: "warn", target: joinLogTarget, message: `Failed ${target} — FloodWait stopped retry for this account` });
                   } else if (out === "flood") {
                     out = await attempt();
                       if (out === "transient") out = "fail";
                   }
                   const waitMs = Date.now() - t0;
                   const errLike = out === "flood" ? "FLOOD_WAIT" : null;
                   const fw = errLike ? floodWaitSeconds(errLike) : null;
                   const finalStatus: "joined" | "requested" | "failed" | "skipped" =
                      out === "flood" || out === "fail" ? "failed" : out === "requested" ? "requested" : out === "ok" ? "joined" : "skipped";
                   await finalizeJoinLock(supabase, {
                     accountId, target: rawTarget, status: finalStatus,
                     cacheTtlHours: pacing.cache_ttl_hours,
                      error: out === "flood" ? "FLOOD_WAIT" : out === "fail" ? (joinErrorCode ?? "JOIN_FAILED") : null,
                   });
                   await logJoinAttempt(supabase, {
                      userId, accountId, target: rawTarget, source: op.preJoinOnly ? "bot_flow_prejoin" : "bot_flow_required",
                      result: out === "flood" ? "flood" : out === "fail" ? "failed" : out === "requested" ? "requested" : out === "ok" ? "joined" : "skipped",
                     waitMs, floodWaitSeconds: fw,
                      metadata: {
                        normalized: normalizeTargetKey(rawTarget),
                        path: joinPath,
                        errorCode: joinErrorCode,
                        publicInviteFallback: op.publicInviteFallback !== false,
                      },
                   });
                   // Only mark as permanently handled if we actually joined
                   // or the target is unreachable/already-participant. Leave
                   // transient failures retryable in later rounds.
                    if (out === "ok" || out === "requested" || out === "skip") alreadyJoined.add(key);
                   // Human-like pacing between joins from configured pacing.
                   await new Promise((r) => setTimeout(r, jitteredDelayMs(pacing)));
                  return out;
                };

                // ── Pre-join user-supplied channels ─────────────────────
                if (op.preJoinChannels?.length) {
                  // Dedupe only within the pasted list (same link twice = one attempt).
                  // User-supplied pre-join links MUST always be attempted — do not
                  // filter by prior cache. Force a fresh attempt per target by
                  // wiping any stale join_cache row and removing the handle from
                  // the in-memory alreadyJoined set before calling smartJoin.
                  const seen = new Set<string>();
                  const uniquePre: string[] = [];
                  for (const raw of op.preJoinChannels) {
                    const h = extractHandle(raw);
                    if (!h) continue;
                    const k = h.toLowerCase();
                    if (seen.has(k)) continue;
                    seen.add(k);
                    uniquePre.push(raw);
                  }
                  send("log", { accountId, level: "info", target: botLabel, message: `Pre-joining ${uniquePre.length} channel(s) (of ${op.preJoinChannels.length})…` });
                  for (const raw of uniquePre) {
                    if (stopRequested) break;
                    // Always give user-supplied links a real attempt.
                    try {
                      await supabase
                        .from("join_cache")
                        .delete()
                        .eq("account_id", accountId)
                        .eq("target_key", normalizeTargetKey(raw));
                    } catch { /* best-effort */ }
                    const h = extractHandle(raw);
                    if (h) alreadyJoined.delete(h.toLowerCase());
                    const r = await smartJoin(raw);
                     if (r === "ok" || r === "requested") ok++;
                     if (r === "fail" || r === "flood") fail++;
                    if (r === "stop") break;
                  }
                 }
                 if (!op.preJoinOnly) {
                 try {
                   await doStartBot();
                  send("log", { accountId, level: "success", target: botLabel, message: startParam ? `Started with param "${startParam}"` : "Started" });
                  await logDb(accountId, botLabel, "success", startParam ? `Started with param "${startParam}"` : "Started");
                } catch (e) {
                  const em = errorText(e);
                  send("log", { accountId, level: "warn", target: botLabel, message: `StartBot: ${em}` });
                  await logDb(accountId, botLabel, "warn", `StartBot: ${em}`);
                }
                 }

                // ── Auto-join required channels ─────────────────────────
                // Many referral bots reply with "Please join these channels"
                // and a list of URL buttons / t.me links. Detect them, join
                // from this account, then re-fire /start so the bot re-checks.
                if (!op.preJoinOnly && op.autoJoinRequired !== false) {
                  const rounds = Math.max(1, Math.min(15, op.maxJoinRounds ?? 10));
                  const linkRe = /(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/(\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+|[A-Za-z0-9_]{4,})/gi;
                  // Track everything the bot has ever asked for on this account
                  // so the UI can show "N remaining" even across rounds.
                  const requiredSeen = new Set<string>();
                  const emitJoinProgress = (extra: Record<string, unknown> = {}) => {
                    const remaining = Array.from(requiredSeen).filter((k) => !alreadyJoined.has(k));
                    send("joinProgress", {
                      accountId,
                      total: requiredSeen.size,
                      joined: alreadyJoined.size,
                      remaining: remaining.length,
                      remainingList: remaining.slice(0, 25),
                      ...extra,
                    });
                  };
                  const emitJoinStop = (reason: string, details?: Record<string, unknown>) => {
                    const remaining = Array.from(requiredSeen).filter((k) => !alreadyJoined.has(k));
                    send("joinStop", {
                      accountId,
                      reason,
                      total: requiredSeen.size,
                      joined: alreadyJoined.size,
                      remaining: remaining.length,
                      remainingList: remaining.slice(0, 25),
                      ...(details ?? {}),
                    });
                    send("log", {
                      accountId,
                      level: reason === "all_joined" ? "success" : "warn",
                      target: botLabel,
                      message: `Auto-join stopped: ${reason}${remaining.length ? ` — ${remaining.length} still pending (${remaining.slice(0, 5).join(", ")}${remaining.length > 5 ? "…" : ""})` : ""}`,
                    });
                  };
                  let lastRoundCompleted = -1;
                   for (let round = 0; round < rounds; round++) {
                    if (stopRequested) { emitJoinStop("user_stopped", { round }); break; }
                    // Give the bot a brief moment to reply (short = fast).
                    await new Promise((r) => setTimeout(r, 500));
                    let recent: any[] = [];
                    try {
                      recent = await client.getMessages(botPeer, { limit: 5 }) as any[];
                    } catch (e) {
                      send("log", { accountId, level: "warn", target: botLabel, message: `Round ${round + 1}: fetch bot messages failed — ${errorText(e)}` });
                      recent = [];
                    }
                    const candidates: string[] = [];
                    let joinHintSeen = false;
                    for (const m of recent) {
                      const text = String(m?.message ?? m?.text ?? "");
                      if (/join|जॉइन|加入|подпис/i.test(text)) joinHintSeen = true;
                      let match: RegExpExecArray | null;
                      while ((match = linkRe.exec(text)) !== null) candidates.push(match[1]);
                      // Message entities: MessageEntityTextUrl (has .url),
                      // MessageEntityMention (@name in text — use offset/length),
                      // MessageEntityMentionName (userId). Bots often list
                      // required channels as clickable text mentions with no
                      // visible t.me link in the body.
                      const entities: any[] = m?.entities ?? [];
                      for (const ent of entities) {
                        const cls = String(ent?.className ?? "");
                        if (cls === "MessageEntityTextUrl" && typeof ent?.url === "string") {
                          if (/t(?:elegram)?\.me\//i.test(ent.url)) joinHintSeen = true;
                          const mm = ent.url.match(linkRe);
                          linkRe.lastIndex = 0;
                          if (mm) for (const hit of mm) {
                            const inner = hit.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me)\//i, "").replace(/^joinchat\//i, "+");
                            if (inner) candidates.push(inner);
                          }
                        } else if (cls === "MessageEntityMention" && typeof ent?.offset === "number" && typeof ent?.length === "number") {
                          const raw = text.substr(ent.offset, ent.length).replace(/^@/, "").trim();
                          if (raw) { candidates.push(raw); joinHintSeen = true; }
                        }
                      }
                      // Webpage previews attached to bot messages sometimes
                      // point to the required channel (t.me/xxx cards).
                      const wp = m?.media?.webpage;
                      const wpUrl: string | undefined = wp?.url ?? wp?.displayUrl;
                      if (wpUrl && /t(?:elegram)?\.me\//i.test(wpUrl)) {
                        joinHintSeen = true;
                        const mm = wpUrl.match(linkRe);
                        linkRe.lastIndex = 0;
                        if (mm) for (const hit of mm) {
                          const inner = hit.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me)\//i, "").replace(/^joinchat\//i, "+");
                          if (inner) candidates.push(inner);
                        }
                      }
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
                    const allCandidates = Array.from(new Set(candidates))
                      .filter((c) => c && c.toLowerCase() !== parsed.username.toLowerCase());
                    for (const c of allCandidates) requiredSeen.add(c.toLowerCase());
                    const targets = allCandidates.filter((c) => !alreadyJoined.has(c.toLowerCase()));
                    send("log", {
                      accountId,
                      level: "info",
                      target: botLabel,
                      message: `Round ${round + 1}/${rounds}: detected ${allCandidates.length} link(s), ${targets.length} new to join, joinHint=${joinHintSeen}`,
                    });
                    emitJoinProgress({ round: round + 1, detected: allCandidates.length });
                    if (!targets.length) {
                      // Nothing new detected. If the bot is still asking to
                      // join, keep nudging with /start; only stop when the
                      // bot no longer signals a join requirement.
                      if (joinHintSeen) {
                        try {
                          await doStartBot();
                          send("log", { accountId, level: "info", target: botLabel, message: `Round ${round + 1}: no new links, join hint still present — re-fired /start` });
                        } catch (e) {
                          send("log", { accountId, level: "warn", target: botLabel, message: `Round ${round + 1}: /start retry failed — ${errorText(e)}` });
                        }
                        lastRoundCompleted = round;
                        continue;
                      }
                      emitJoinStop("no_join_hint", { round: round + 1 });
                      break;
                    }
                    let joinedThisRound = 0;
                    let progressed = false;
                    let floodedThisRound = 0;
                    let skippedThisRound = 0;
                    // Serialize per-account joins with human pacing to avoid
                    // FLOOD_WAITs stacking; smartJoin handles small waits.
                    for (const t of targets) {
                      if (stopRequested) { emitJoinStop("user_stopped", { round: round + 1 }); break; }
                      const r = await smartJoin(t);
                       if (r === "ok") { ok++; joinedThisRound++; progressed = true; }
                       if (r === "fail") fail++;
                      if (r === "requested" || r === "skip") { progressed = true; skippedThisRound++; }
                       if (r === "requested") ok++;
                      if (r === "flood") floodedThisRound++;
                      if (r === "stop") { emitJoinStop("user_stopped", { round: round + 1 }); break; }
                      emitJoinProgress({ round: round + 1, target: t, lastResult: r });
                    }
                    if (stopRequested) break;
                    send("log", {
                      accountId,
                      level: joinedThisRound ? "success" : "info",
                      target: botLabel,
                      message: `Round ${round + 1} summary: joined=${joinedThisRound}, skipped=${skippedThisRound}, floods=${floodedThisRound}`,
                    });
                    lastRoundCompleted = round;
                    // Keep looping while the bot still asks for joins, even
                    // if this round only hit floods — retry after pacing.
                    if (!joinedThisRound && !progressed && !joinHintSeen) {
                      emitJoinStop("no_progress", { round: round + 1, floodedThisRound });
                      break;
                    }
                    // Re-fire /start so the bot re-verifies membership.
                    try {
                      await doStartBot();
                      send("log", { accountId, level: "success", target: botLabel, message: `Re-started after joining ${joinedThisRound} chat(s)` });
                    } catch (e) {
                      send("log", { accountId, level: "warn", target: botLabel, message: `Re-start: ${errorText(e)}` });
                    }
                  }
                  if (!stopRequested && lastRoundCompleted === rounds - 1) {
                    const remaining = Array.from(requiredSeen).filter((k) => !alreadyJoined.has(k));
                    if (remaining.length) emitJoinStop("max_rounds_reached", { rounds });
                    else emitJoinStop("all_joined", { rounds });
                  }
                }

                if (!op.preJoinOnly)
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
                       // Bot flow (chat with bot) is normally sequential —
                       // parallel runs can hit the same required invite at
                       // once and trigger FloodWait after ~5 joins. The user
                       // can opt in with `parallel: true` (or pre-join-only,
                       // where the per-(account, channel) join lock already
                       // guarantees exactly one request per pair).
                       ? ((body.op as any).preJoinOnly || (body.op as any).parallel)
                         ? await runWithConcurrency(body.accountIds, Math.max(body.concurrency, 1), (id) => stopRequested ? Promise.resolve({ ok: 0, fail: 0 }) : runBotFlowForAccount(id, body.op as any))
                         : await runWithConcurrency(body.accountIds, 1, (id) => stopRequested ? Promise.resolve({ ok: 0, fail: 0 }) : runBotFlowForAccount(id, body.op as any))
                      : await runWithConcurrency(body.accountIds, Math.max(body.concurrency, 1), (id) => stopRequested ? Promise.resolve({ ok: 0, fail: 0 }) : runOne(id));
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