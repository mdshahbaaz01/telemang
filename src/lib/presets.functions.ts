import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listPresets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind?: string }) => d ?? {})
  .handler(async ({ data, context }) => {
    let q = context.supabase.from("action_presets").select("*").order("updated_at", { ascending: false });
    if (data.kind) q = q.eq("kind", data.kind);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const savePreset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string; kind: string; name: string; payload: unknown }) => d)
  .handler(async ({ data, context }) => {
    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("action_presets")
        .update({ name: data.name, payload: data.payload as any })
        .eq("id", data.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return row;
    }
    const { data: row, error } = await context.supabase
      .from("action_presets")
      .insert({ user_id: context.userId, kind: data.kind, name: data.name, payload: data.payload as any })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deletePreset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("action_presets").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });