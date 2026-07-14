import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const kindSchema = z.string().trim().min(1).max(64);
const nameSchema = z.string().trim().min(1).max(120);
const payloadSchema = z.unknown().refine(
  (v) => {
    try {
      return JSON.stringify(v ?? null).length <= 100_000;
    } catch {
      return false;
    }
  },
  { message: "payload too large" },
);

export const listPresets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ kind: kindSchema.optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase.from("action_presets").select("*").order("updated_at", { ascending: false });
    if (data.kind) q = q.eq("kind", data.kind);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const savePreset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        kind: kindSchema,
        name: nameSchema,
        payload: payloadSchema,
      })
      .parse(d),
  )
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
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("action_presets").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });