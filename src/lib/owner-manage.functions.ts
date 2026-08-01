import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertOwner(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.userId)
    .eq("role", "owner")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: owner only");
}

function logTiming(op: string, marks: Record<string, number>, extra: Record<string, unknown> = {}) {
  const entries = Object.entries(marks);
  const total = entries.length ? entries[entries.length - 1][1] - entries[0][1] : 0;
  const steps: Record<string, number> = {};
  for (let i = 1; i < entries.length; i++) {
    steps[entries[i][0]] = Math.round(entries[i][1] - entries[i - 1][1]);
  }
  console.log(JSON.stringify({
    kind: "owner_toggle_timing",
    op,
    total_ms: Math.round(total),
    steps_ms: steps,
    ...extra,
  }));
}

/** Sidebar/feature keys — must match app-sidebar item ids. */
export const FEATURE_KEYS = [
  "dashboard","cleanup","actions","broadcast","bot-flow","alerts","buttons",
  "bulk-mix","profile-updater","search","workspace","bulk-plus","bot-parser",
  "referrals","analytics","recipes","media","watchlists","stealth","captcha",
  "join-pacing","join-integrity","health",
  "feedback","security",
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export const ownerListAccessOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertOwner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: list }, rolesRes, setsRes, featRes, acctRes] = await Promise.all([
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 }),
      supabaseAdmin.from("user_roles").select("user_id, role"),
      supabaseAdmin.from("user_admin_settings").select("*"),
      supabaseAdmin.from("user_feature_permissions").select("user_id, feature_key, allowed"),
      supabaseAdmin.from("telegram_accounts").select("user_id"),
    ]);
    const roleMap = new Map<string, string[]>();
    for (const r of rolesRes.data ?? []) {
      const a = roleMap.get(r.user_id) ?? []; a.push(r.role); roleMap.set(r.user_id, a);
    }
    const setMap = new Map<string, any>();
    for (const s of setsRes.data ?? []) setMap.set(s.user_id, s);
    const featMap = new Map<string, Record<string, boolean>>();
    for (const f of featRes.data ?? []) {
      const m = featMap.get(f.user_id) ?? {};
      m[f.feature_key] = f.allowed;
      featMap.set(f.user_id, m);
    }
    const countMap = new Map<string, number>();
    for (const a of acctRes.data ?? []) {
      countMap.set(a.user_id, (countMap.get(a.user_id) ?? 0) + 1);
    }
    return (list?.users ?? []).map((u) => {
      const roles = roleMap.get(u.id) ?? [];
      const s = setMap.get(u.id);
      return {
        id: u.id,
        email: u.email ?? "",
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        roles,
        isOwner: roles.includes("owner"),
        isAdmin: roles.includes("admin") || roles.includes("owner"),
        accountAddApproved: !!s?.account_add_approved,
        accountLimit: s?.account_limit ?? 0,
        notes: s?.notes ?? null,
        accountCount: countMap.get(u.id) ?? 0,
        features: featMap.get(u.id) ?? {},
      };
    });
  });

export const ownerListRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertOwner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("account_add_requests")
      .select("id, user_id, status, message, requested_limit, created_at, decided_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const ids = Array.from(new Set((data ?? []).map((r) => r.user_id)));
    const emails = new Map<string, string>();
    if (ids.length) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
      for (const u of list?.users ?? []) if (u.email) emails.set(u.id, u.email);
    }
    return (data ?? []).map((r) => ({ ...r, email: emails.get(r.user_id) ?? "" }));
  });

export const ownerDecideRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      approve: z.boolean(),
      accountLimit: z.number().int().min(1).max(50).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const { error } = await context.supabase.rpc("decide_account_request", {
      _id: data.id,
      _approve: data.approve,
      _account_limit: data.accountLimit ?? 1,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const ownerSetRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      userId: z.string().uuid(),
      role: z.enum(["user", "admin", "owner"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const t0 = performance.now();
    await assertOwner(context);
    const t1 = performance.now();
    const { error } = await context.supabase.rpc("owner_set_role", {
      _target: data.userId,
      _role: data.role,
    });
    const t2 = performance.now();
    logTiming("ownerSetRole", { start: t0, assertOwner: t1, rpc: t2 },
      { userId: data.userId, role: data.role, ok: !error });
    if (error) throw new Error(error.message);
    return { ok: true, timing_ms: Math.round(t2 - t0) };
  });

export const ownerSetFeature = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      userId: z.string().uuid(),
      key: z.string().min(1).max(64),
      allowed: z.boolean(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const t0 = performance.now();
    await assertOwner(context);
    const t1 = performance.now();
    const { error } = await context.supabase.rpc("owner_set_feature", {
      _target: data.userId,
      _key: data.key,
      _allowed: data.allowed,
    });
    const t2 = performance.now();
    logTiming("ownerSetFeature", { start: t0, assertOwner: t1, rpc: t2 },
      { userId: data.userId, key: data.key, allowed: data.allowed, ok: !error });
    if (error) throw new Error(error.message);
    return { ok: true, timing_ms: Math.round(t2 - t0) };
  });

export const ownerSetUserSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      userId: z.string().uuid(),
      approved: z.boolean().optional(),
      accountLimit: z.number().int().min(0).max(50).optional(),
      notes: z.string().max(500).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const t0 = performance.now();
    await assertOwner(context);
    const t1 = performance.now();
    const { error } = await context.supabase.rpc("owner_set_user_settings", {
      _target: data.userId,
      _approved: (data.approved ?? null) as unknown as boolean,
      _account_limit: (data.accountLimit ?? null) as unknown as number,
      _notes: (data.notes ?? null) as unknown as string,
    });
    const t2 = performance.now();
    logTiming("ownerSetUserSettings", { start: t0, assertOwner: t1, rpc: t2 },
      { userId: data.userId, ok: !error });
    if (error) throw new Error(error.message);
    return { ok: true, timing_ms: Math.round(t2 - t0) };
  });
