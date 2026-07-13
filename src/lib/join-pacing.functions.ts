import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getJoinPacing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getPacingConfig, DEFAULT_PACING } = await import("./join-cache.server");
    const cfg = await getPacingConfig(context.supabase, context.userId);
    return { config: cfg, defaults: DEFAULT_PACING };
  });

export const updateJoinPacing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        min_delay_ms: z.coerce.number().int().min(0).max(60000),
        max_delay_ms: z.coerce.number().int().min(0).max(60000),
        batch_size: z.coerce.number().int().min(1).max(20),
        cache_ttl_hours: z.coerce.number().int().min(1).max(24 * 365),
        lock_ttl_seconds: z.coerce.number().int().min(5).max(3600),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const payload = { user_id: context.userId, ...data };
    const { error } = await context.supabase
      .from("join_pacing_config")
      .upsert(payload, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listJoinAttempts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        accountId: z.string().uuid().optional(),
        result: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("join_attempts")
      .select("id, account_id, target, source, result, wait_ms, flood_wait_seconds, error, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.accountId) q = q.eq("account_id", data.accountId);
    if (data.result) q = q.eq("result", data.result);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const clearJoinAttempts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("join_attempts")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listJoinCache = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("join_cache")
      .select("id, account_id, target_key, status, source, locked_at, expires_at, attempts, last_error, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.accountId) q = q.eq("account_id", data.accountId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const clearJoinCacheEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_cache")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });