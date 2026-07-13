// Phase 5 — Unified Telegram executor primitives.
//
// Provides two building blocks used by tasks/broadcasts/joins to make
// retried operations safe and rate-limit-aware:
//
//   • withIdempotency(supabase, { key, scope, userId }, fn)
//       – First caller runs fn(); result is persisted keyed by `key`.
//       – Concurrent/duplicate callers get the cached result back and skip fn().
//       – Rows auto-expire after 24h and are trimmed by run_log_retention().
//
//   • adaptivePacing(supabase, accountId, basePacing)
//       – Widens the min/max delay window when the account has hit floods
//         or failures in the last 5 minutes (via recent_account_health RPC).
//       – Returns a PacingConfig you can hand straight to jitteredDelayMs().

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PACING, type PacingConfig } from "@/lib/join-cache.server";

export type IdempotencyOptions = {
  key: string;                // globally unique — include user/account/target
  scope: string;              // grouping tag, e.g. "broadcast", "join", "react"
  userId: string;
  ttlSeconds?: number;        // default 24h (also cleaned by cron)
};

export type IdempotencyOutcome<T> =
  | { cached: false; result: T }
  | { cached: true; result: T; status: string };

/**
 * Run `fn` at most once per `key`. Subsequent callers with the same key get
 * the stored result. Uses the primary-key insert as an atomic lock.
 */
export async function withIdempotency<T>(
  supabase: SupabaseClient,
  opts: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const ttl = Math.max(60, opts.ttlSeconds ?? 24 * 3600);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  // Attempt to claim the key.
  const { error: insertErr } = await supabase.from("idempotency_keys").insert({
    key: opts.key,
    user_id: opts.userId,
    scope: opts.scope,
    status: "in_flight",
    expires_at: expiresAt,
  });

  if (insertErr) {
    // Duplicate key — read existing row.
    const { data: existing } = await supabase
      .from("idempotency_keys")
      .select("status, result, expires_at")
      .eq("key", opts.key)
      .maybeSingle();

    if (existing && (!existing.expires_at || existing.expires_at > new Date().toISOString())) {
      if (existing.status === "done") {
        return { cached: true, result: existing.result as T, status: "done" };
      }
      // in_flight — return a cached-in-flight signal so caller can short-circuit
      return { cached: true, result: (existing.result ?? null) as T, status: existing.status };
    }
    // Expired row; overwrite it.
    await supabase
      .from("idempotency_keys")
      .update({ status: "in_flight", result: null, expires_at: expiresAt, completed_at: null })
      .eq("key", opts.key);
  }

  try {
    const result = await fn();
    await supabase
      .from("idempotency_keys")
      .update({
        status: "done",
        result: (result ?? null) as unknown as Record<string, unknown> | null,
        completed_at: new Date().toISOString(),
      })
      .eq("key", opts.key);
    return { cached: false, result };
  } catch (err) {
    // Mark failed but keep row briefly so retries within 60s dedupe.
    await supabase
      .from("idempotency_keys")
      .update({
        status: "failed",
        result: { error: err instanceof Error ? err.message : String(err) },
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
      })
      .eq("key", opts.key);
    throw err;
  }
}

/**
 * Fetch a per-account adaptive pacing window. If the account has been hit
 * with floods or errors in the last 5 minutes, delays grow (up to ~4x) so
 * subsequent ops back off automatically without user intervention.
 */
export async function adaptivePacing(
  supabase: SupabaseClient,
  accountId: string,
  basePacing: PacingConfig = DEFAULT_PACING,
): Promise<PacingConfig & { multiplier: number; floods: number; failures: number }> {
  let multiplier = 1;
  let floods = 0;
  let failures = 0;
  let maxFlood = 0;
  try {
    const { data } = await supabase.rpc("recent_account_health", { _account_id: accountId });
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      floods = Number(row.floods ?? 0);
      failures = Number(row.failures ?? 0);
      maxFlood = Number(row.max_flood_seconds ?? 0);
    }
  } catch {
    /* RPC missing or transient — fall back to base pacing */
  }

  // Simple additive model — every recent flood/failure adds pressure.
  const pressure = floods * 1.2 + failures * 0.5 + Math.min(maxFlood, 60) / 30;
  multiplier = Math.min(4, 1 + pressure);

  return {
    ...basePacing,
    min_delay_ms: Math.round(basePacing.min_delay_ms * multiplier),
    max_delay_ms: Math.round(basePacing.max_delay_ms * multiplier),
    multiplier,
    floods,
    failures,
  };
}

/** Build a stable idempotency key for common ops. */
export function idemKey(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase())
    .join(":");
}