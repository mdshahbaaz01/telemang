import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

const bodySchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(200),
  targets: z.array(z.string().min(1)).min(1).max(200),
  perAccountDelayMs: z.number().int().min(0).max(60_000).default(1500),
  parallelAccounts: z.number().int().min(1).max(20).default(5),
});

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function textOf(e: unknown) {
  return String((e as any)?.errorMessage || (e as any)?.message || e || "");
}

type Diag = { code: string; hint: string };

function diagnose(msg: string): Diag {
  const m = msg.toUpperCase();
  if (/INVITE_REQUEST_SENT|INVITE_REQUEST_ALREADY_SENT|REQUEST_SENT/.test(m))
    return { code: "REQUEST_SENT", hint: "Join request delivered to channel admins. Await approval." };
  if (/USER_ALREADY_PARTICIPANT/.test(m))
    return { code: "ALREADY_MEMBER", hint: "This account is already a member of the chat." };
  if (/INVITE_HASH_EXPIRED/.test(m))
    return { code: "INVITE_EXPIRED", hint: "The invite link has expired. Ask the owner for a fresh link." };
  if (/INVITE_HASH_INVALID|INVITE_HASH_EMPTY/.test(m))
    return { code: "INVITE_INVALID", hint: "Invite hash is malformed. Copy the full t.me/+... URL." };
  if (/USERNAME_NOT_OCCUPIED/.test(m))
    return { code: "USERNAME_UNKNOWN", hint: "No public @username exists. Use the +invite link instead." };
  if (/USERNAME_INVALID/.test(m))
    return { code: "USERNAME_INVALID", hint: "Username format is invalid." };
  if (/CHANNELS_TOO_MUCH/.test(m))
    return { code: "CHANNELS_TOO_MUCH", hint: "Account is in max 500 channels/groups. Leave some before joining more." };
  if (/INVITE_REQUEST_ALREADY_SENT/.test(m))
    return { code: "REQUEST_PENDING", hint: "A prior join request from this account is still pending." };
  if (/USER_BANNED_IN_CHANNEL|BANNED/.test(m))
    return { code: "BANNED", hint: "This account is banned from this channel." };
  if (/CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE/.test(m))
    return { code: "NO_ACCESS", hint: "Account cannot access this chat (private or admin-only)." };
  const flood = m.match(/FLOOD(?:_WAIT|WAIT)_?(\d+)/);
  if (flood) return { code: `FLOOD_WAIT_${flood[1]}`, hint: `Telegram rate limit: wait ${flood[1]}s before retrying with this account.` };
  if (/PEER_FLOOD/.test(m))
    return { code: "PEER_FLOOD", hint: "Account is temporarily limited for spammy activity. Slow down or use a warmer account." };
  if (/AUTH_KEY|SESSION_REVOKED|SESSION_PASSWORD_NEEDED|UNAUTHORIZED/.test(m))
    return { code: "SESSION_INVALID", hint: "This account session is invalid or logged out. Re-login the account." };
  return { code: "ERROR", hint: msg.slice(0, 240) };
}

function isApprovalLink(raw: string): boolean {
  const t = raw.trim().replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "");
  return /^\+/.test(t) || /^joinchat\//i.test(t);
}

export const Route = createFileRoute("/api/public/join-requests-stream")({
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
        const isAdmin = (roles ?? []).some((r) => r.role === "admin" || r.role === "owner");
        if (!isAdmin) return new Response("Forbidden", { status: 403 });

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch (e) {
          return new Response(`Bad request: ${(e as Error).message}`, { status: 400 });
        }

        const abortSignal = request.signal;

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
              const { joinTelegramTargetVerified } = await import("@/lib/telegram-join-helper.server");
              const Api = (await import("telegram")).Api;

              send("plan", { accounts: body.accountIds.length, targets: body.targets.length });

              const queue = [...body.accountIds];
              const workers = Math.min(body.parallelAccounts, queue.length);
              const runAccount = async (accountId: string) => {
                let client: any;
                try {
                  client = await openClientForAccount(supabase, accountId, { requireOwnerId: userId });
                } catch (e) {
                  const diag = diagnose(textOf(e));
                  for (const target of body.targets) {
                    if (abortSignal.aborted) return;
                    send("update", {
                      accountId, target,
                      status: "failed", code: diag.code, hint: diag.hint,
                      approval: isApprovalLink(target),
                      message: textOf(e),
                    });
                  }
                  return;
                }
                try {
                  for (const target of body.targets) {
                    if (abortSignal.aborted) return;
                    send("update", { accountId, target, status: "pending", code: null, hint: "Sending…", approval: isApprovalLink(target) });
                    try {
                      const res = await joinTelegramTargetVerified({ client, Api, target, publicInviteFallback: true });
                      const status =
                        res.status === "joined" ? "accepted" :
                        res.status === "already" ? "already" :
                        "requested";
                      const diag = res.errorCode ? diagnose(res.errorCode) : { code: status.toUpperCase(), hint: res.message };
                      send("update", {
                        accountId, target, status,
                        code: res.errorCode || diag.code,
                        hint: res.note || diag.hint || res.message,
                        approval: isApprovalLink(target),
                        canonical: res.canonicalTarget,
                        path: res.path,
                      });
                    } catch (e) {
                      const msg = textOf(e);
                      const diag = diagnose(msg);
                      send("update", {
                        accountId, target,
                        status: "failed",
                        code: diag.code, hint: diag.hint,
                        approval: isApprovalLink(target),
                        message: msg,
                      });
                    }
                    if (body.perAccountDelayMs > 0) {
                      const start = Date.now();
                      while (Date.now() - start < body.perAccountDelayMs) {
                        if (abortSignal.aborted) return;
                        await new Promise((r) => setTimeout(r, 200));
                      }
                    }
                  }
                } finally {
                  try { await client.disconnect(); } catch {}
                }
              };

              const pullNext = async (): Promise<void> => {
                while (!abortSignal.aborted) {
                  const next = queue.shift();
                  if (!next) return;
                  await runAccount(next);
                }
              };
              await Promise.all(Array.from({ length: workers }, () => pullNext()));
              send("end", { aborted: abortSignal.aborted });
            } catch (e) {
              send("end", { aborted: abortSignal.aborted, error: textOf(e) });
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