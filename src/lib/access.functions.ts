import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Server-side admin guard. Throws 403-equivalent when caller is not admin.
 * Call inside a server fn handler after requireSupabaseAuth middleware.
 */
export async function assertAdminCtx(context: {
  supabase: ReturnType<typeof Object>;
  userId: string;
  // Loosely typed to avoid coupling to middleware internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & any) {
  const { data, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (error) throw new Error(error.message);
  const isAdmin = (data ?? []).some(
    (r: { role: string }) => r.role === "admin" || r.role === "owner",
  );
  if (!isAdmin) throw new Error("Forbidden: admin role required");
  return true;
}

/** Returns true for both admin and user roles (broadcast is open to all authenticated users). */
export const amIAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roles = (data ?? []).map((r) => r.role);
    return {
      isAdmin: roles.includes("admin") || roles.includes("owner"),
      isOwner: roles.includes("owner"),
    };
  });

/** Full access snapshot: role + feature permissions + account-add settings. */
export const myAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [rolesRes, featsRes, setRes, reqRes, acctRes] = await Promise.all([
      context.supabase.from("user_roles").select("role").eq("user_id", context.userId),
      context.supabase
        .from("user_feature_permissions")
        .select("feature_key, allowed")
        .eq("user_id", context.userId),
      context.supabase
        .from("user_admin_settings")
        .select("account_add_approved, account_limit, notes")
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("account_add_requests")
        .select("id, status, message, requested_limit, created_at, decided_at")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      context.supabase
        .from("telegram_accounts")
        .select("id", { count: "exact", head: true }),
    ]);
    const roles = (rolesRes.data ?? []).map((r) => r.role);
    const isOwner = roles.includes("owner");
    const isAdmin = isOwner || roles.includes("admin");
    const features: Record<string, boolean> = {};
    for (const f of featsRes.data ?? []) features[f.feature_key] = f.allowed;
    const settings = setRes.data ?? { account_add_approved: false, account_limit: 0, notes: null };
    return {
      userId: context.userId,
      isOwner,
      isAdmin,
      features,
      accountAddApproved: isOwner ? true : !!settings.account_add_approved,
      accountLimit: isOwner ? 999 : settings.account_limit ?? 0,
      accountCount: acctRes.count ?? 0,
      latestRequest: reqRes.data ?? null,
    };
  });

/** User creates a pending request to add Telegram accounts. */
export const requestAccountAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      message: z.string().max(500).optional(),
      requestedLimit: z.number().int().min(1).max(50).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rid, error } = await context.supabase.rpc("request_account_access", {
      _message: data.message ?? null,
      _requested_limit: data.requestedLimit ?? 1,
    });
    if (error) throw new Error(error.message);
    return { id: rid as string };
  });

/** User cancels their own pending request. */
export const cancelMyAccountRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("account_add_requests")
      .update({ status: "cancelled" })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { ok: true };
  });