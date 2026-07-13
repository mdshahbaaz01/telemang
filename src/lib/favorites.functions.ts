import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listFavorites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_favorites")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const addFavorite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind: string; ref_id?: string; label: string; href?: string; icon?: string }) => d)
  .handler(async ({ data, context }) => {
    const { count } = await context.supabase
      .from("user_favorites")
      .select("*", { count: "exact", head: true });
    if ((count ?? 0) >= 8) throw new Error("Max 8 favorites");
    const { data: row, error } = await context.supabase
      .from("user_favorites")
      .insert({
        user_id: context.userId,
        kind: data.kind,
        ref_id: data.ref_id ?? null,
        label: data.label,
        href: data.href ?? null,
        icon: data.icon ?? null,
        sort_order: count ?? 0,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const removeFavorite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("user_favorites").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const reorderFavorites = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { orderedIds: string[] }) => d)
  .handler(async ({ data, context }) => {
    await Promise.all(
      data.orderedIds.map((id, i) =>
        context.supabase.from("user_favorites").update({ sort_order: i }).eq("id", id),
      ),
    );
    return { ok: true };
  });