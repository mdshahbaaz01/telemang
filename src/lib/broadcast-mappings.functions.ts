import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const itemSchema = z.object({
  message: z.string().max(4096).default(""),
  target: z.string().min(1).max(200),
  accountId: z.string().uuid().optional().nullable(),
});

const saveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceFilename: z.string().max(200).optional().nullable(),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
  items: z.array(itemSchema).min(1).max(2000),
});

export type BroadcastMappingItem = z.infer<typeof itemSchema>;

export const saveBroadcastMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("broadcast_mappings")
      .insert({
        user_id: context.userId,
        name: data.name,
        source_filename: data.sourceFilename ?? null,
        format: data.format,
        items: JSON.parse(JSON.stringify(data.items)),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

export const listBroadcastMappings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("broadcast_mappings")
      .select("id, name, source_filename, format, items, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      sourceFilename: (r.source_filename as string | null) ?? null,
      format: (r.format as string) ?? "plain",
      items: (Array.isArray(r.items) ? r.items : []) as BroadcastMappingItem[],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  });

export const updateBroadcastMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        format: z.enum(["plain", "mono", "quote", "html"]).optional(),
        items: z.array(itemSchema).min(1).max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: { name?: string; format?: string; items?: any } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.format !== undefined) patch.format = data.format;
    if (data.items !== undefined) patch.items = JSON.parse(JSON.stringify(data.items));
    if (!Object.keys(patch).length) return { ok: true };
    const { error } = await context.supabase
      .from("broadcast_mappings")
      .update(patch)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteBroadcastMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("broadcast_mappings")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });