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
});

const bodySchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(50),
  minDelay: z.number().int().min(0).max(60).default(2),
  maxDelay: z.number().int().min(0).max(60).default(6),
  op: z.discriminatedUnion("kind", [reactSchema, forwardSchema, voteSchema]),
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

            // Resolve source peer & get message once per account (needed for react/vote/forward source)
            const resolveSource = async (client: any) => {
              const src = body.op.source;
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

            const runOne = async (accountId: string) => {
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
                const src = body.op.source;
                let sourcePeer: any;
                try {
                  sourcePeer = await resolveSource(client);
                } catch (e) {
                  const msg = `Resolve source failed: ${(e as Error).message}`;
                  send("log", { accountId, level: "error", message: msg });
                  await logDb(accountId, null, "error", msg);
                  return { ok: 0, fail: 1 };
                }

                if (body.op.kind === "react") {
                  try {
                    await client.invoke(
                      new Api.messages.SendReaction({
                        peer: sourcePeer,
                        msgId: src.msgId,
                        reaction: [
                          new Api.ReactionEmoji({ emoticon: body.op.emoji }),
                        ],
                      }),
                    );
                    ok++;
                    const m = `Reacted ${body.op.emoji}`;
                    send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
                  } catch (e) {
                    fail++;
                    const m = (e as Error).message || String(e);
                    send("log", { accountId, level: "error", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "error", m);
                  }
                } else if (body.op.kind === "vote") {
                  try {
                    const [msg] = await client.getMessages(sourcePeer, { ids: [src.msgId] });
                    if (!msg?.poll) throw new Error("Message is not a poll");
                    const pollObj = (msg.poll as { poll?: { answers?: Array<{ option: Uint8Array }> } }).poll;
                    const answers = pollObj?.answers ?? [];
                    const chosen = body.op.options
                      .map((i) => answers[i]?.option)
                      .filter((x): x is Uint8Array => !!x)
                      .map((x) => Buffer.from(x));
                    if (chosen.length === 0) throw new Error("No matching poll options");
                    await client.invoke(
                      new Api.messages.SendVote({
                        peer: sourcePeer,
                        msgId: src.msgId,
                        options: chosen,
                      }),
                    );
                    ok++;
                    const m = `Voted options ${body.op.options.join(",")}`;
                    send("log", { accountId, level: "success", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "success", m);
                  } catch (e) {
                    fail++;
                    const m = (e as Error).message || String(e);
                    send("log", { accountId, level: "error", target: `${src.chat}/${src.msgId}`, message: m });
                    await logDb(accountId, `${src.chat}/${src.msgId}`, "error", m);
                  }
                } else if (body.op.kind === "forward") {
                  for (const t of body.op.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await client.getEntity(
                        t.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, ""),
                      );
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

            let totalOk = 0;
            let totalFail = 0;
            try {
              const results = await Promise.all(
                body.accountIds.map((id) => runOne(id)),
              );
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