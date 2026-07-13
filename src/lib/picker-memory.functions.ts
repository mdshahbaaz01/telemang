import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getPickMemory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("account_pick_memory")
      .select("account_ids, updated_at")
      .eq("kind", data.kind)
      .maybeSingle();
    if (!row) return { accountIds: [] as string[], updatedAt: null as string | null };
    const ids = Array.isArray(row.account_ids) ? (row.account_ids as string[]) : [];
    if (ids.length === 0) return { accountIds: [], updatedAt: row.updated_at };
    // Drop accounts that no longer exist / are inactive
    const { data: alive } = await context.supabase
      .from("telegram_accounts")
      .select("id, status")
      .in("id", ids);
    const activeIds = (alive ?? [])
      .filter((a: any) => a.status !== "banned" && a.status !== "deleted")
      .map((a: any) => a.id as string);
    return { accountIds: activeIds, updatedAt: row.updated_at };
  });

export const setPickMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind: string; accountIds: string[] }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("account_pick_memory")
      .upsert(
        { user_id: context.userId, kind: data.kind, account_ids: data.accountIds as any, updated_at: new Date().toISOString() },
        { onConflict: "user_id,kind" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });