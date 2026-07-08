import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const attachmentSchema = z.object({
  path: z.string().min(1).max(500),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200).optional(),
});

const msgRefSchema = z.object({
  chat: z.string().min(1).max(120),
  msgId: z.number().int().positive(),
});

const broadcastRowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  attachment: attachmentSchema.optional(),
});

const replyRowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  attachment: attachmentSchema.optional(),
}).refine((r) => r.message.length > 0 || !!r.attachment, {
  message: "Row needs a message or attachment",
});

const opSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("broadcast"),
    rows: z.array(broadcastRowSchema).min(1).max(200),
  }),
  z.object({
    kind: z.literal("reply"),
    source: msgRefSchema,
    viaDiscussion: z.boolean().default(false),
    rows: z.array(replyRowSchema).min(1).max(200),
  }),
  z.object({
    kind: z.literal("forward"),
    source: msgRefSchema,
    accountIds: z.array(z.string().uuid()).min(1).max(200),
    targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  }),
]);

const createSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  label: z.string().max(120).optional(),
  op: opSchema,
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
      ...data.op,
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
    return (data ?? []).map((r) => {
      const payload = (r.payload as any) ?? {};
      const kind: "broadcast" | "reply" | "forward" =
        payload.kind === "reply" || payload.kind === "forward" ? payload.kind : "broadcast";
      let summary = "";
      if (kind === "broadcast") {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const targets = rows.reduce((n: number, row: any) => n + (Array.isArray(row.targets) ? row.targets.length : 0), 0);
        summary = `${rows.length} row(s) · ${targets} target(s)`;
      } else if (kind === "reply") {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        summary = `${rows.length} ${payload.viaDiscussion ? "comment" : "reply"}(s) · ${payload?.source?.chat ?? "?"}/${payload?.source?.msgId ?? "?"}`;
      } else {
        const accIds = Array.isArray(payload.accountIds) ? payload.accountIds.length : 0;
        const tgts = Array.isArray(payload.targets) ? payload.targets.length : 0;
        summary = `${accIds} account(s) → ${tgts} target(s)`;
      }
      return {
        id: r.id as string,
        scheduledAt: r.scheduled_at as string,
        label: (r.label as string | null) ?? null,
        status: r.status as string,
        kind,
        summary,
        dispatchedAt: (r.dispatched_at as string | null) ?? null,
        completedAt: (r.completed_at as string | null) ?? null,
        error: (r.error as string | null) ?? null,
        rowCount: Array.isArray(payload.rows) ? payload.rows.length : 0,
        createdAt: r.created_at as string,
      };
    });
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