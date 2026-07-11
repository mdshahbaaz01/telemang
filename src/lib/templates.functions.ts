import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const attachmentSchema = z.object({
  path: z.string().min(1).max(500),
  filename: z.string().min(1).max(200),
  mimeType: z.string().max(200).optional(),
  isVoice: z.boolean().optional(),
});

const formatSchema = z.enum(["plain", "mono", "quote", "html"]);

export const listTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("message_templates")
      .select("id, name, body, format, attachments, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      body: r.body as string,
      format: r.format as "plain" | "mono" | "quote" | "html",
      attachments: (r.attachments ?? []) as Array<z.infer<typeof attachmentSchema>>,
      updatedAt: r.updated_at as string,
    }));
  });

export const saveTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(120),
        body: z.string().max(4096).default(""),
        format: formatSchema.default("plain"),
        attachments: z.array(attachmentSchema).max(10).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.id) {
      const { error } = await context.supabase
        .from("message_templates")
        .update({ name: data.name, body: data.body, format: data.format, attachments: data.attachments as any })
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("message_templates")
      .insert({
        user_id: context.userId,
        name: data.name,
        body: data.body,
        format: data.format,
        attachments: data.attachments as any,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "insert failed");
    return { id: row.id as string };
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("message_templates")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });