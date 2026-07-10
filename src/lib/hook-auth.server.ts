import { timingSafeEqual } from "crypto";

/**
 * Verify that an incoming cron/webhook request presents a valid shared
 * secret. Accepts either the dedicated `CRON_SECRET` or the Supabase
 * `SERVICE_ROLE_KEY` (so existing pg_cron jobs that send the service-role
 * apikey continue to work). Uses a constant-time comparison.
 *
 * Returns `null` on success, or a `Response` (401) to return immediately.
 */
export function verifyHookAuth(request: Request): Response | null {
  const presented =
    request.headers.get("apikey") ??
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  if (!presented) return new Response("Unauthorized", { status: 401 });

  const candidates = [
    process.env.CRON_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  const presentedBuf = Buffer.from(presented);
  for (const expected of candidates) {
    const expectedBuf = Buffer.from(expected);
    if (presentedBuf.length !== expectedBuf.length) continue;
    try {
      if (timingSafeEqual(presentedBuf, expectedBuf)) return null;
    } catch {
      // length mismatch — keep trying
    }
  }
  return new Response("Unauthorized", { status: 401 });
}