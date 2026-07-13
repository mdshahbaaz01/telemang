import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Clone a join task: creates a fresh task with the same targets, delays, account.
export const cloneJoinTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ sourceTaskId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: src, error: srcErr } = await context.supabase
      .from("join_tasks")
      .select("id, name, account_id, min_delay, max_delay, group_id")
      .eq("id", data.sourceTaskId)
      .single();
    if (srcErr || !src) throw new Error(srcErr?.message ?? "Source task not found");
    const { data: items, error: itemsErr } = await context.supabase
      .from("join_task_items")
      .select("target, position")
      .eq("task_id", src.id);
    if (itemsErr) throw new Error(itemsErr.message);
    if (!items || items.length === 0) throw new Error("Source task has no targets");
    const { data: task, error } = await context.supabase
      .from("join_tasks")
      .insert({
        user_id: context.userId,
        account_id: src.account_id,
        name: `${src.name} (repeat)`,
        status: "idle",
        min_delay: src.min_delay,
        max_delay: src.max_delay,
        group_id: src.group_id,
        source_task_id: src.id,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const clonedItems = items.map((it: any) => ({
      task_id: task.id,
      user_id: context.userId,
      target: it.target,
      position: it.position ?? 0,
    }));
    const { error: iErr } = await context.supabase.from("join_task_items").insert(clonedItems);
    if (iErr) throw new Error(iErr.message);
    return { taskId: task.id as string };
  });

// Clone a scheduled broadcast at a new time (or +1 hour by default).
export const cloneScheduledBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      sourceId: z.string().uuid(),
      scheduledAt: z.string().datetime({ offset: true }).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: src, error } = await context.supabase
      .from("scheduled_broadcasts")
      .select("label, payload")
      .eq("id", data.sourceId)
      .single();
    if (error || !src) throw new Error(error?.message ?? "Source not found");
    const when = data.scheduledAt
      ? new Date(data.scheduledAt)
      : new Date(Date.now() + 60 * 60_000);
    if (when.getTime() < Date.now() + 5_000) throw new Error("Schedule at least 5 seconds in the future");
    const { data: row, error: iErr } = await context.supabase
      .from("scheduled_broadcasts")
      .insert({
        user_id: context.userId,
        scheduled_at: when.toISOString(),
        label: src.label ? `${src.label} (repeat)` : null,
        payload: src.payload,
        status: "pending",
        source_id: data.sourceId,
      } as any)
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);
    return { id: row.id as string };
  });