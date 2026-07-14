import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const kindSchema = z.string().trim().min(1).max(64);

export const getPickMemory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ kind: kindSchema }).parse(d))
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
  .inputValidator((d: unknown) =>
    z
      .object({
        kind: kindSchema,
        accountIds: z.array(z.string().uuid()).max(2000),
      })
      .parse(d),
  )
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