import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

async function assertAdmin(ctx: {
  supabase: SupabaseClient<Database>;
  userId: string;
}) {
  const { data, error } = await ctx.supabase.rpc("is_admin");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

async function assertOwner(ctx: {
  supabase: SupabaseClient<Database>;
  userId: string;
}) {
  const { data, error } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "owner",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: owner only");
}

export const ownerListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Owner-only: this endpoint uses the service-role client to enumerate
    // every user's email, sign-in history and roles. Do NOT downgrade to
    // admin — that would leak PII to any admin-tier user.
    await assertOwner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (error) throw new Error(error.message);
    const { data: roleRows, error: rerr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role");
    if (rerr) throw new Error(rerr.message);
    const roleMap = new Map<string, string[]>();
    for (const r of roleRows ?? []) {
      const arr = roleMap.get(r.user_id) ?? [];
      arr.push(r.role);
      roleMap.set(r.user_id, arr);
    }
    return list.users.map((u) => ({
      id: u.id,
      email: u.email ?? "",
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      confirmed: !!u.email_confirmed_at,
      roles: roleMap.get(u.id) ?? [],
    }));
  });

export const ownerToggleAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      userId: z.string().uuid(),
      makeAdmin: z.boolean(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Only the owner can grant/revoke admin.
    await assertOwner(context);
    if (!data.makeAdmin && data.userId === context.userId) {
      throw new Error("You cannot demote yourself");
    }
    if (data.makeAdmin) {
      const { error } = await context.supabase
        .from("user_roles")
        .insert({ user_id: data.userId, role: "admin" });
      if (error && !error.message.includes("duplicate")) throw new Error(error.message);
    } else {
      const { error } = await context.supabase
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .eq("role", "admin");
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const ownerListAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { data, error } = await context.supabase
      .from("telegram_accounts")
      .select(
        "id, phone, first_name, last_name, username, status, paused_until, last_error, created_at, updated_at, user_id",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const ownerSetAccountStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      enabled: z.boolean(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { error } = await context.supabase
      .from("telegram_accounts")
      .update({
        status: data.enabled ? "active" : "disabled",
        paused_until: null,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const ownerListLogins = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { data, error } = await context.supabase
      .from("login_attempts")
      .select("id, phone, api_id, stage, created_at, user_id")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// Owner-only: wipe every history/log/task/broadcast table to keep the app
// snappy. Never touches telegram_accounts, groups, roles, permissions, or
// user settings.
export const ownerClearAllData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ confirm: z.literal("CLEAR ALL DATA") }).parse(d),
  )
  .handler(async ({ context }) => {
    await assertOwner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Tables preserved: telegram_accounts, account_groups, account_group_members,
    // account_add_requests, account_pick_memory, user_roles, user_admin_settings,
    // user_feature_permissions, notification_settings, password_reset_requests,
    // feature_requests, feature_request_votes, join_pacing_config.
    const tables = [
      "task_logs",
      "join_task_items",
      "join_tasks",
      "join_attempts",
      "join_cache",
      "action_logs",
      "action_runs",
      "action_presets",
      "action_recipes",
      "bot_parse_results",
      "bot_parse_rules",
      "captcha_solve_log",
      "captcha_solvers",
      "idempotency_keys",
      "inline_button_clicks",
      "login_attempts",
      "media_library",
      "message_templates",
      "notification_logs",
      "owner_audit_log",
      "referral_joins",
      "referral_links",
      "scheduled_broadcast_items",
      "scheduled_broadcasts",
      "user_favorites",
      "user_sessions",
      "watchlists",
    ] as const;
    const results: { table: string; ok: boolean; error?: string }[] = [];
    for (const t of tables) {
      const { error } = await supabaseAdmin
        .from(t)
        .delete()
        .not("id", "is", null);
      if (error) results.push({ table: t, ok: false, error: error.message });
      else results.push({ table: t, ok: true });
    }
    return {
      ok: true,
      cleared: results.filter((r) => r.ok).map((r) => r.table),
      failed: results.filter((r) => !r.ok),
    };
  });
