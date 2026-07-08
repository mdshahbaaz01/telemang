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
  emoji: z.string().min(1).max(20),
  customEmojiId: z.string().regex(/^\d+$/).optional(),
  retake: z.boolean().optional(),
});

const forwardSchema = z.object({
  kind: z.literal("forward"),
  source: msgRefSchema,
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
});

const voteSchema = z.object({
  kind: z.literal("vote"),
  source: msgRefSchema,
  options: z.array(z.number().int().min(0).max(20)).min(1).max(10),
  retake: z.boolean().optional(),
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

export const Route = createFileRoute("/api/public/actions-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
        const { data: claims, error: claimsErr } =
          await supabase.auth.getClaims(token);
        if (claimsErr || !claims?.claims?.sub) {
          return new Response("Unauthorized", { status: 401 });
        }
        const userId = claims.claims.sub as string;

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
            params: JSON.parse(JSON.stringify(body.op)),
          })
          .select("id")
          .single();
        if (runErr || !runRow) {
          return new Response(runErr?.message ?? "run insert failed", {
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
              await supabase
                .from("action_logs")
                .insert({ run_id: runId, account_id: accountId, target, level, message });
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
                // Private channel numeric id
                const raw = src.chat.slice(2);
                const { default: bigInt } = await import("big-integer");
                // Try full channel resolution — accessHash unknown, so fetch via getEntity is safer
                peer = await client.getEntity(bigInt(raw));
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
                return await client.getEntity(bigInt(raw));
              }
              return await client.getEntity(cleaned);
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
                const msg = `Connect failed: ${(e as Error).message}`;
                send("log", { accountId, level: "error", message: msg });
                await logDb(accountId, null, "error", msg);
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
                      const em = (e as Error).message || String(e);
                      const floodMatch = em.match(/FLOOD_WAIT_?(\d+)/i);
                      if (floodMatch) {
                        const secs = Number(floodMatch[1]);
                        const pausedUntil = new Date(Date.now() + secs * 1000).toISOString();
                        await supabase
                          .from("telegram_accounts")
                          .update({ paused_until: pausedUntil, last_error: em })
                          .eq("id", accountId);
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

            const runBroadcastRow = async (row: { accountId: string; message: string; targets: string[]; attachment?: { path: string; filename: string; mimeType?: string } }) => {
              const accountId = row.accountId;
              send("log", { accountId, level: "info", message: "Connecting…" });
              let client;
              try {
                client = await openClientForAccount(supabase, accountId);
              } catch (e) {
                const msg = `Connect failed: ${(e as Error).message}`;
                send("log", { accountId, level: "error", message: msg });
                await logDb(accountId, null, "error", msg);
                return { ok: 0, fail: 1 };
              }
              let ok = 0;
              let fail = 0;
              let attData: { buf: Buffer; filename: string; mimeType?: string } | null = null;
              if (row.attachment) {
                try {
                  attData = await loadAttachment(row.attachment);
                } catch (e) {
                  const em = (e as Error).message;
                  send("log", { accountId, level: "error", message: em });
                  await logDb(accountId, null, "error", em);
                  await client.disconnect().catch(() => {});
                  send("done", { accountId, ok: 0, fail: row.targets.length });
                  return { ok: 0, fail: row.targets.length };
                }
              }
              try {
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
                    const em = (e as Error).message || String(e);
                    const floodMatch = em.match(/FLOOD_WAIT_?(\d+)/i);
                    if (floodMatch) {
                      const secs = Number(floodMatch[1]);
                      const pausedUntil = new Date(Date.now() + secs * 1000).toISOString();
                      await supabase
                        .from("telegram_accounts")
                        .update({ paused_until: pausedUntil, last_error: em })
                        .eq("id", accountId);
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
              } finally {
                await client.disconnect().catch(() => {});
                send("done", { accountId, ok, fail });
              }
              return { ok, fail };
            };

            const runReplyRow = async (
              row: { accountId: string; message: string },
              src: { chat: string; msgId: number },
              viaDiscussion: boolean,
            ) => {
              const accountId = row.accountId;
              send("log", { accountId, level: "info", message: "Connecting…" });
              let client;
              try {
                client = await openClientForAccount(supabase, accountId);
              } catch (e) {
                const msg = `Connect failed: ${(e as Error).message}`;
                send("log", { accountId, level: "error", message: msg });
                await logDb(accountId, null, "error", msg);
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
                  const rootMsg = disc?.messages?.[0];
                  if (!rootMsg) throw new Error("No discussion group linked to this channel");
                  // Resolve discussion group peer from the returned chats
                  const chats = (disc?.chats ?? []) as any[];
                  const discChat = chats[0];
                  if (!discChat) throw new Error("Discussion chat missing");
                  replyPeer = await client.getEntity(discChat);
                  replyToId = rootMsg.id;
                  topMsgId = rootMsg.id;
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
                await client.sendMessage(replyPeer, {
                  message: row.message,
                  replyTo: new Api.InputReplyToMessage({
                    replyToMsgId: replyToId,
                    ...(topMsgId ? { topMsgId } : {}),
                  }) as any,
                });
                ok++;
                const label = viaDiscussion ? "Commented" : "Replied";
                const m = `${label} on ${src.chat}/${src.msgId}`;
                send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
              } catch (e) {
                fail++;
                const em = (e as Error).message || String(e);
                const floodMatch = em.match(/FLOOD_WAIT_?(\d+)/i);
                if (floodMatch) {
                  const secs = Number(floodMatch[1]);
                  const pausedUntil = new Date(Date.now() + secs * 1000).toISOString();
                  await supabase
                    .from("telegram_accounts")
                    .update({ paused_until: pausedUntil, last_error: em })
                    .eq("id", accountId);
                  send("log", { accountId, level: "warn", message: `FloodWait ${secs}s — account paused` });
                  await logDb(accountId, null, "warn", `FloodWait ${secs}s`);
                } else {
                  send("log", { accountId, level: "error", message: em });
                  await logDb(accountId, null, "error", em);
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
              const results =
                body.op.kind === "broadcast"
                  ? await Promise.all(body.op.rows.map((r) => runBroadcastRow(r)))
                  : body.op.kind === "reply"
                    ? await Promise.all(
                        body.op.rows.map((r) =>
                          runReplyRow(r, (body.op as any).source, !!(body.op as any).viaDiscussion),
                        ),
                      )
                    : await Promise.all(body.accountIds.map((id) => runOne(id)));
              for (const r of results) {
                totalOk += r.ok;
                totalFail += r.fail;
              }
            } catch (e) {
              send("log", { level: "error", message: (e as Error).message });
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
      },
    },
  },
});