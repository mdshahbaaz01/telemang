import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const attachmentSchema = z.object({
  path: z.string().min(1).max(500),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200).optional(),
});

const rowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  attachment: attachmentSchema.optional(),
});

const createSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  label: z.string().max(120).optional(),
  rows: z.array(rowSchema).min(1).max(200),
  minDelay: z.number().int().min(0).max(60).default(1),
  maxDelay: z.number().int().min(0).max(60).default(2),
});

export const createScheduledBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const when = new Date(data.scheduledAt);
    if (Number.isNaN(when.getTime())) throw new Error("Invalid time");
    if (when.getTime() < Date.now() + 5_000) {
      throw new Error("Schedule at least 5 seconds in the future");
    }
    const payload = {
      rows: data.rows,
      minDelay: data.minDelay,
      maxDelay: data.maxDelay,
    };
    const { data: row, error } = await context.supabase
      .from("scheduled_broadcasts")
      .insert({
        user_id: context.userId,
        scheduled_at: when.toISOString(),
        label: data.label ?? null,
        payload: JSON.parse(JSON.stringify(payload)),
        status: "pending",
      })
      .select("id, scheduled_at")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string, scheduledAt: row.scheduled_at as string };
  });

export const listScheduledBroadcasts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("scheduled_broadcasts")
      .select("id, scheduled_at, label, status, dispatched_at, completed_at, error, payload, created_at")
      .order("scheduled_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      scheduledAt: r.scheduled_at as string,
      label: (r.label as string | null) ?? null,
      status: r.status as string,
      dispatchedAt: (r.dispatched_at as string | null) ?? null,
      completedAt: (r.completed_at as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      rowCount: Array.isArray((r.payload as any)?.rows) ? (r.payload as any).rows.length : 0,
      createdAt: r.created_at as string,
    }));
  });

export const cancelScheduledBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("scheduled_broadcasts")
      .update({ status: "cancelled" })
      .eq("id", data.id)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { ok: true };
  });