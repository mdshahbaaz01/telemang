// Persistent per-account/per-channel join cache with in-flight lock + TTL,
// plus structured attempt logging and pacing config.
// Used by both bot-flow (actions-stream) and join tasks (tasks.functions).

import type { SupabaseClient } from "@supabase/supabase-js";

export type JoinSource = "bot_flow_prejoin" | "bot_flow_required" | "join_task" | "batch_join" | string;
export type JoinResult =
  | "acquired"
  | "skipped_cached"
  | "skipped_locked"
  | "joined"
  | "requested"
  | "already_participant"
  | "flood"
  | "failed";

export type PacingConfig = {
  min_delay_ms: number;
  max_delay_ms: number;
  batch_size: number;
  cache_ttl_hours: number;
  lock_ttl_seconds: number;
};

export const DEFAULT_PACING: PacingConfig = {
  min_delay_ms: 800,
  max_delay_ms: 1500,
  batch_size: 5,
  cache_ttl_hours: 720,
  lock_ttl_seconds: 90,
};

/** Normalize any Telegram target (@user, t.me/x, +invite, joinchat/x) to a stable cache key. */
export function normalizeTargetKey(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me)\//i, "")
    .replace(/^joinchat\//i, "+");
}

export async function getPacingConfig(
  supabase: SupabaseClient,
  userId: string,
): Promise<PacingConfig> {
  const { data } = await supabase
    .from("join_pacing_config")
    .select("min_delay_ms, max_delay_ms, batch_size, cache_ttl_hours, lock_ttl_seconds")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return DEFAULT_PACING;
  return {
    min_delay_ms: data.min_delay_ms ?? DEFAULT_PACING.min_delay_ms,
    max_delay_ms: Math.max(data.max_delay_ms ?? DEFAULT_PACING.max_delay_ms, data.min_delay_ms ?? DEFAULT_PACING.min_delay_ms),
    batch_size: data.batch_size ?? DEFAULT_PACING.batch_size,
    cache_ttl_hours: data.cache_ttl_hours ?? DEFAULT_PACING.cache_ttl_hours,
    lock_ttl_seconds: data.lock_ttl_seconds ?? DEFAULT_PACING.lock_ttl_seconds,
  };
}

/**
 * Load every non-expired cached target for an account into a Map<key, status>.
 * Callers use this to seed their in-memory dedupe set at the start of a run.
 */
export async function loadCacheForAccount(
  supabase: SupabaseClient,
  accountId: string,
): Promise<Map<string, string>> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("join_cache")
    .select("target_key, status, expires_at")
    .eq("account_id", accountId)
    .in("status", ["joined", "requested", "in_flight", "failed", "skipped"]);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ target_key: string; status: string; expires_at: string | null }>) {
    if (r.expires_at && r.expires_at < nowIso) continue;
    out.set(r.target_key, r.status);
  }
  return out;
}

/**
 * Try to atomically acquire the per-(account, channel) join lock.
 *
 * Returns:
 *   - "acquired" — caller may proceed with the join attempt
 *   - "skipped_cached" — already joined/requested (or terminal-cached) — skip
 *   - "skipped_locked" — another worker currently holds the lock — skip
 */
export async function tryAcquireJoinLock(
  supabase: SupabaseClient,
  args: {
    userId: string;
    accountId: string;
    target: string;
    source: JoinSource;
    lockTtlSeconds: number;
  },
): Promise<{ outcome: "acquired" | "skipped_cached" | "skipped_locked"; status?: string }> {
  const key = normalizeTargetKey(args.target);
  const now = new Date();
  const lockUntil = new Date(now.getTime() + args.lockTtlSeconds * 1000).toISOString();

  // Check current row first.
  const { data: existing } = await supabase
    .from("join_cache")
    .select("id, status, locked_at, expires_at, attempts")
    .eq("account_id", args.accountId)
    .eq("target_key", key)
    .maybeSingle();

  const nowIso = now.toISOString();
  if (existing) {
    const notExpired = !existing.expires_at || existing.expires_at > nowIso;
    if (notExpired && (existing.status === "joined" || existing.status === "requested")) {
      return { outcome: "skipped_cached", status: existing.status };
    }
    if (existing.status === "in_flight") {
      const lockValid = existing.locked_at && new Date(existing.locked_at).getTime() + args.lockTtlSeconds * 1000 > now.getTime();
      if (lockValid) return { outcome: "skipped_locked", status: "in_flight" };
    }
    // Take over the row (stale in-flight or previously failed/skipped).
    const { error: uerr } = await supabase
      .from("join_cache")
      .update({
        status: "in_flight",
        source: args.source,
        locked_at: nowIso,
        expires_at: lockUntil,
        attempts: (existing.attempts ?? 0) + 1,
        last_error: null,
      })
      .eq("id", existing.id);
    if (uerr) return { outcome: "skipped_locked", status: "conflict" };
    return { outcome: "acquired" };
  }

  // Insert fresh in_flight row; unique(account_id, target_key) makes this atomic.
  const { error: ierr } = await supabase.from("join_cache").insert({
    user_id: args.userId,
    account_id: args.accountId,
    target_key: key,
    status: "in_flight",
    source: args.source,
    locked_at: nowIso,
    expires_at: lockUntil,
    attempts: 1,
  });
  if (ierr) {
    // Race: someone inserted between our select and insert. Treat as locked.
    return { outcome: "skipped_locked", status: "race" };
  }
  return { outcome: "acquired" };
}

/** Finalize the lock with a terminal status. */
export async function finalizeJoinLock(
  supabase: SupabaseClient,
  args: {
    accountId: string;
    target: string;
    status: "joined" | "requested" | "failed" | "skipped";
    cacheTtlHours: number;
    error?: string | null;
  },
) {
  const key = normalizeTargetKey(args.target);
  const expiresAt =
    args.status === "joined" || args.status === "requested"
      ? new Date(Date.now() + args.cacheTtlHours * 3600 * 1000).toISOString()
      : new Date(Date.now() + Math.min(args.cacheTtlHours, 24) * 3600 * 1000).toISOString();
  await supabase
    .from("join_cache")
    .update({
      status: args.status,
      last_error: args.error ?? null,
      locked_at: null,
      expires_at: expiresAt,
    })
    .eq("account_id", args.accountId)
    .eq("target_key", key);
}

/** Release a lock without a terminal decision (e.g. crashed attempt) so retries aren't blocked. */
export async function releaseJoinLock(
  supabase: SupabaseClient,
  args: { accountId: string; target: string; error?: string | null },
) {
  const key = normalizeTargetKey(args.target);
  await supabase
    .from("join_cache")
    .update({
      status: "failed",
      last_error: args.error ?? "released",
      locked_at: null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    })
    .eq("account_id", args.accountId)
    .eq("target_key", key)
    .eq("status", "in_flight");
}

/** Insert a structured log entry for a join attempt. */
export async function logJoinAttempt(
  supabase: SupabaseClient,
  args: {
    userId: string;
    accountId: string | null;
    target: string;
    source: JoinSource;
    result: JoinResult;
    waitMs?: number | null;
    floodWaitSeconds?: number | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  await supabase.from("join_attempts").insert({
    user_id: args.userId,
    account_id: args.accountId,
    target: normalizeTargetKey(args.target),
    source: args.source,
    result: args.result,
    wait_ms: args.waitMs ?? null,
    flood_wait_seconds: args.floodWaitSeconds ?? null,
    error: args.error ?? null,
    metadata: (args.metadata ?? null) as unknown as Record<string, unknown> | null,
  });
}

/** Sleep for a random interval within the pacing window. */
export function jitteredDelayMs(cfg: PacingConfig): number {
  const lo = Math.max(0, cfg.min_delay_ms);
  const hi = Math.max(lo, cfg.max_delay_ms);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}