import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

const bodySchema = z.object({
  accountId: z.string().uuid(),
  sourcePeerKey: z.string().min(1),
  targetPeerKeys: z.array(z.string().min(1)).min(1).max(20),
  fromMsgId: z.number().int().min(1),
  toMsgId: z.number().int().min(1),
  dropAuthor: z.boolean().default(false),
  delayMs: z.number().int().min(0).max(60000).default(300),
  markRead: z.boolean().default(true),
  // Resume: skip IDs <= this value for the given target key
  resumeAfter: z.record(z.string(), z.number().int().min(0)).default({}),
  batchSize: z.number().int().min(1).max(100).default(100),
  maxRetries: z.number().int().min(0).max(10).default(3),
});

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseFlood(msg: string): number | null {
  const m = msg.match(/FLOOD_WAIT_?(\d+)/i) || msg.match(/FloodWait\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

export const Route = createFileRoute("/api/public/forward-range-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
        const token = authHeader.slice(7);
        const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });
        const { data: claims, error: claimsErr } = await supabase.auth.getClaims(token);
        if (claimsErr || !claims?.claims?.sub) return new Response("Unauthorized", { status: 401 });
        const userId = claims.claims.sub as string;

        const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
        const isAdmin = (roles ?? []).some((r) => r.role === "admin");
        if (!isAdmin) return new Response("Forbidden", { status: 403 });

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch (e) {
          return new Response(`Bad request: ${(e as Error).message}`, { status: 400 });
        }

        // Account ownership
        const { data: owned } = await supabase
          .from("telegram_accounts")
          .select("id, user_id")
          .eq("id", body.accountId)
          .maybeSingle();
        if (!owned || owned.user_id !== userId) {
          return new Response("Forbidden: account ownership", { status: 403 });
        }

        const abortSignal = request.signal;
        const lo = Math.min(body.fromMsgId, body.toMsgId);
        const hi = Math.max(body.fromMsgId, body.toMsgId);
        if (hi - lo > 5000) return new Response("Range too large (max 5000).", { status: 400 });

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              try { controller.enqueue(sseEncode(event, data)); } catch {}
            };
            let closed = false;
            const close = () => { if (!closed) { closed = true; try { controller.close(); } catch {} } };
            abortSignal.addEventListener("abort", () => { send("aborted", {}); close(); });

            try {
              const { openClientForAccount } = await import("@/lib/cleanup.server");
              const { Api } = await import("telegram");
              const { default: bigInt } = await import("big-integer");
              const { markPeerRead } = await import("@/lib/telegram-read-helper.server");

              const resolvePeer = async (key: string) => {
                if (key.startsWith("@")) return await client.getEntity(key.slice(1));
                const [kind, raw] = key.split(":");
                const id = bigInt(raw);
                const peer =
                  kind === "u" ? new Api.PeerUser({ userId: id }) :
                  kind === "c" ? new Api.PeerChannel({ channelId: id }) :
                  kind === "g" ? new Api.PeerChat({ chatId: id }) :
                  null;
                if (!peer) throw new Error(`Bad peer key: ${key}`);
                try { return await client.getEntity(peer); }
                catch {
                  await client.getDialogs({ limit: 500 }).catch(() => {});
                  return await client.getEntity(peer);
                }
              };

              send("log", { level: "info", message: "Connecting…" });
              const client = await openClientForAccount(supabase, body.accountId);

              try {
                const src = await resolvePeer(body.sourcePeerKey);
                send("log", { level: "info", message: `Resolved source. Fetching ${hi - lo + 1} IDs…` });

                // Discover valid IDs in the range
                const allIds: number[] = [];
                for (let i = lo; i <= hi; i++) allIds.push(i);
                const existing: number[] = [];
                for (let i = 0; i < allIds.length; i += 200) {
                  if (abortSignal.aborted) break;
                  const chunk = allIds.slice(i, i + 200);
                  try {
                    const res: any = await client.getMessages(src, { ids: chunk });
                    const arr = Array.isArray(res) ? res : [res];
                    for (const m of arr) {
                      if (m && !(m.className ?? "").includes("Empty") && m.id) existing.push(Number(m.id));
                    }
                  } catch (e) {
                    send("log", { level: "warn", message: `Fetch chunk failed: ${(e as Error).message}` });
                  }
                }
                existing.sort((a, b) => a - b);
                const missing = allIds.length - existing.length;
                send("plan", { total: allIds.length, existing: existing.length, missing, firstId: existing[0] ?? null, lastId: existing.at(-1) ?? null });

                if (body.markRead && existing.length) {
                  try { await markPeerRead(client, src, existing.at(-1)!, () => {}); } catch {}
                }

                if (!existing.length) {
                  send("end", { aborted: false });
                  return;
                }

                for (const targetKey of body.targetPeerKeys) {
                  if (abortSignal.aborted) break;
                  send("target-start", { targetKey });

                  let dst: any;
                  try {
                    dst = await resolvePeer(targetKey);
                  } catch (e) {
                    send("log", { level: "error", targetKey, message: `Resolve target failed: ${(e as Error).message}` });
                    send("target-done", { targetKey, ok: 0, fail: existing.length, lastMsgId: 0 });
                    continue;
                  }

                  const resumeAt = Number(body.resumeAfter[targetKey] ?? 0);
                  const pending = existing.filter((id) => id > resumeAt);
                  if (pending.length < existing.length) {
                    send("log", { level: "info", targetKey, message: `Resuming after msgId ${resumeAt} — ${pending.length} remaining.` });
                  }

                  let ok = 0;
                  let fail = 0;
                  let lastOkId = resumeAt;
                  const total = pending.length;

                  for (let i = 0; i < pending.length; ) {
                    if (abortSignal.aborted) break;
                    const batch = pending.slice(i, i + body.batchSize);
                    const randomId = batch.map(() => bigInt(Math.floor(Math.random() * 1e18)));
                    let attempt = 0;
                    let batchOk = false;
                    while (attempt <= body.maxRetries && !batchOk) {
                      if (abortSignal.aborted) break;
                      try {
                        await client.invoke(
                          new Api.messages.ForwardMessages({
                            fromPeer: src,
                            toPeer: dst,
                            id: batch,
                            randomId,
                            dropAuthor: body.dropAuthor,
                          }),
                        );
                        batchOk = true;
                      } catch (e) {
                        const em = (e as Error).message || String(e);
                        const fw = parseFlood(em);
                        if (fw) {
                          send("log", { level: "warn", targetKey, message: `FloodWait ${fw}s — sleeping (attempt ${attempt + 1}/${body.maxRetries + 1})` });
                          const waitMs = (fw + 1) * 1000;
                          const start = Date.now();
                          while (Date.now() - start < waitMs) {
                            if (abortSignal.aborted) break;
                            await new Promise((r) => setTimeout(r, 250));
                          }
                          attempt++;
                          continue;
                        }
                        // Non-flood: retry once then give up
                        if (attempt < body.maxRetries) {
                          send("log", { level: "warn", targetKey, message: `Batch failed (${em}) — retry ${attempt + 1}/${body.maxRetries}` });
                          await new Promise((r) => setTimeout(r, 1500));
                          attempt++;
                          continue;
                        }
                        fail += batch.length;
                        send("log", { level: "error", targetKey, message: `Batch ${batch[0]}..${batch[batch.length - 1]} failed: ${em}` });
                        break;
                      }
                    }
                    if (batchOk) {
                      ok += batch.length;
                      lastOkId = batch[batch.length - 1];
                      send("progress", {
                        targetKey,
                        ok,
                        fail,
                        total,
                        lastMsgId: lastOkId,
                        percent: Math.round(((ok + fail) / total) * 100),
                      });
                      send("log", {
                        level: "success",
                        targetKey,
                        message: `Forwarded ${batch[0]}..${batch[batch.length - 1]} (${batch.length})`,
                      });
                    }
                    i += batch.length;
                    if (body.delayMs > 0 && i < pending.length) {
                      await new Promise((r) => setTimeout(r, body.delayMs));
                    }
                  }

                  send("target-done", { targetKey, ok, fail, lastMsgId: lastOkId });
                }

                send("end", { aborted: abortSignal.aborted });
              } finally {
                await client.disconnect().catch(() => {});
              }
            } catch (e) {
              send("log", { level: "error", message: (e as Error).message || String(e) });
              send("end", { aborted: abortSignal.aborted, error: (e as Error).message });
            } finally {
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