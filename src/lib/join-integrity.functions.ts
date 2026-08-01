import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getJoinIntegrity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [fingerprints, memberships, blocklist] = await Promise.all([
      supabase
        .from("join_fingerprints")
        .select("id, target_key, chat_id, chat_type, title, username, requires_approval, is_public, discussion_chat_id, drift, drift_at, last_seen_at")
        .eq("user_id", userId)
        .order("last_seen_at", { ascending: false })
        .limit(200),
      supabase
        .from("join_memberships")
        .select("id, account_id, target_key, chat_id, chat_type, status, method, error_code, checks, verify_after, verified_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(300),
      supabase
        .from("join_blocklist")
        .select("id, account_id, target_key, reason, error_code, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const { data: accounts } = await supabase
      .from("telegram_accounts")
      .select("id, username, first_name, phone")
      .eq("user_id", userId);

    return {
      fingerprints: fingerprints.data ?? [],
      memberships: memberships.data ?? [],
      blocklist: blocklist.data ?? [],
      accounts: (accounts ?? []).map((a) => ({
        id: a.id,
        label: a.username ? `@${a.username}` : a.first_name || a.phone,
      })),
    };
  });

export const runJoinSweepNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { runJoinVerifySweep } = await import("./join-sweep.server");
    return runJoinVerifySweep(context.supabase as any, { userId: context.userId, limit: 60 });
  });

export const unblockJoinTarget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_blocklist")
      .delete()
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearJoinFingerprint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_fingerprints")
      .delete()
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const retryDroppedMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_memberships")
      .update({ checks: 0, verify_after: new Date().toISOString() })
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });