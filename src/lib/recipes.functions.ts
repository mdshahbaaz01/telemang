import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const stepSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum([
    "react",
    "vote",
    "reply",
    "broadcast",
    "edit",
    "deleteMessages",
    "forward",
    "wait",
  ]),
  // Free-form op payload (validated by the executing endpoint).
  op: z.record(z.string(), z.unknown()).default({}),
  minDelay: z.number().int().min(0).max(3600).default(1),
  maxDelay: z.number().int().min(0).max(3600).default(3),
  // Extra pause after this step completes (in seconds).
  waitAfter: z.number().int().min(0).max(3600).default(0),
  accountIds: z.array(z.string().uuid()).max(200).default([]),
  concurrency: z.number().int().min(1).max(20).default(5),
  note: z.string().max(200).default(""),
});

export type RecipeStep = z.infer<typeof stepSchema>;

export const listRecipes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("action_recipes")
      .select("id, name, description, steps, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      steps: (r.steps as unknown as RecipeStep[]) ?? [],
      updatedAt: r.updated_at as string,
    }));
  });

export const saveRecipe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      name: z.string().min(1).max(120),
      description: z.string().max(500).default(""),
      steps: z.array(stepSchema).max(50).default([]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.id) {
      const { error } = await context.supabase
        .from("action_recipes")
        .update({
          name: data.name,
          description: data.description,
          steps: data.steps as never,
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("action_recipes")
      .insert({
        user_id: context.userId,
        name: data.name,
        description: data.description,
        steps: data.steps as never,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "insert failed");
    return { id: row.id as string };
  });

export const deleteRecipe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("action_recipes")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
