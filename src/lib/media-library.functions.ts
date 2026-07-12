import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("media_library")
      .select("id, name, path, filename, mime_type, size_bytes, tags, is_voice, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      path: r.path as string,
      filename: r.filename as string,
      mimeType: (r.mime_type as string | null) ?? undefined,
      sizeBytes: (r.size_bytes as number | null) ?? undefined,
      tags: (r.tags as string[]) ?? [],
      isVoice: !!r.is_voice,
      createdAt: r.created_at as string,
    }));
  });

export const saveMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      name: z.string().min(1).max(200),
      path: z.string().min(1).max(500),
      filename: z.string().min(1).max(200),
      mimeType: z.string().max(200).optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).default([]),
      isVoice: z.boolean().default(false),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("media_library")
      .insert({
        user_id: context.userId,
        name: data.name,
        path: data.path,
        filename: data.filename,
        mime_type: data.mimeType ?? null,
        size_bytes: data.sizeBytes ?? null,
        tags: data.tags,
        is_voice: data.isVoice,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "insert failed");
    return { id: row.id as string };
  });

export const updateMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(200).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.tags !== undefined) patch.tags = data.tags;
    const { error } = await context.supabase
      .from("media_library")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("media_library")
      .select("path")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (row?.path) {
      await context.supabase.storage.from("action-attachments").remove([row.path as string]);
    }
    const { error } = await context.supabase
      .from("media_library")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
