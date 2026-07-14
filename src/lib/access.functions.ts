import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
  const isAdmin = (data ?? []).some((r: { role: string }) => r.role === "admin");
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
    return { isAdmin: (data ?? []).some((r) => r.role === "admin") };
  });