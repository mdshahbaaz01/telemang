import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const attachmentSchema = z.object({
  path: z.string().min(1).max(500),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200).optional(),
  isVoice: z.boolean().optional(),
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
  attachments: z.array(attachmentSchema).max(10).optional(),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
});

const replyRowSchema = z.object({
  accountId: z.string().uuid(),
  message: z.string().max(4096).default(""),
  attachment: attachmentSchema.optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
}).refine((r) => r.message.length > 0 || !!r.attachment || (r.attachments?.length ?? 0) > 0, {
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
    dropAuthor: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("edit"),
    source: msgRefSchema,
    accountIds: z.array(z.string().uuid()).min(1).max(200),
    message: z.string().min(1).max(4096),
    format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
  }),
  z.object({
    kind: z.literal("deleteMessages"),
    accountIds: z.array(z.string().uuid()).min(1).max(200),
    chat: z.string().min(1).max(200),
    messageIds: z.array(z.number().int().positive()).min(1).max(100),
    revoke: z.boolean().default(true),
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
      .select("id, scheduled_at, label, status, dispatched_at, completed_at, error, payload, created_at, total_items, processed_items, source_id")
      .order("scheduled_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const sourceIds = Array.from(
      new Set(rows.map((r) => (r as any).source_id).filter(Boolean) as string[]),
    );
    const sourceMap = new Map<string, { label: string | null; scheduledAt: string }>();
    if (sourceIds.length) {
      const { data: srcs } = await context.supabase
        .from("scheduled_broadcasts")
        .select("id, label, scheduled_at")
        .in("id", sourceIds);
      for (const s of srcs ?? []) {
        sourceMap.set(s.id as string, {
          label: (s.label as string | null) ?? null,
          scheduledAt: s.scheduled_at as string,
        });
      }
    }
    return rows.map((r) => {
      const payload = (r.payload as any) ?? {};
      const kind: "broadcast" | "reply" | "forward" | "edit" | "deleteMessages" =
        ["reply", "forward", "edit", "deleteMessages"].includes(payload.kind) ? payload.kind : "broadcast";
      let summary = "";
      if (kind === "broadcast") {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const targets = rows.reduce((n: number, row: any) => n + (Array.isArray(row.targets) ? row.targets.length : 0), 0);
        summary = `${rows.length} row(s) · ${targets} target(s)`;
      } else if (kind === "reply") {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        summary = `${rows.length} ${payload.viaDiscussion ? "comment" : "reply"}(s) · ${payload?.source?.chat ?? "?"}/${payload?.source?.msgId ?? "?"}`;
      } else if (kind === "forward") {
        const accIds = Array.isArray(payload.accountIds) ? payload.accountIds.length : 0;
        const tgts = Array.isArray(payload.targets) ? payload.targets.length : 0;
        summary = `${accIds} account(s) → ${tgts} target(s)`;
      } else if (kind === "edit") {
        const accIds = Array.isArray(payload.accountIds) ? payload.accountIds.length : 0;
        summary = `${accIds} account(s) · edit ${payload?.source?.chat ?? "?"}/${payload?.source?.msgId ?? "?"}`;
      } else {
        const accIds = Array.isArray(payload.accountIds) ? payload.accountIds.length : 0;
        const ids = Array.isArray(payload.messageIds) ? payload.messageIds.length : 0;
        summary = `${accIds} account(s) · delete ${ids} message(s)`;
      }
      const srcId = ((r as any).source_id as string | null) ?? null;
      const src = srcId ? sourceMap.get(srcId) ?? null : null;
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
        totalItems: Number((r as any).total_items ?? 0),
        processedItems: Number((r as any).processed_items ?? 0),
        createdAt: r.created_at as string,
        payload: payload as any,
        minDelay: Number(payload.minDelay ?? 1),
        maxDelay: Number(payload.maxDelay ?? 2),
        sourceId: srcId,
        sourceLabel: src?.label ?? null,
        sourceScheduledAt: src?.scheduledAt ?? null,
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

export const rescheduleBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      scheduledAt: z.string().datetime({ offset: true }),
      label: z.string().max(120).optional(),
      op: opSchema.optional(),
      minDelay: z.number().int().min(0).max(60).optional(),
      maxDelay: z.number().int().min(0).max(60).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const when = new Date(data.scheduledAt);
    if (Number.isNaN(when.getTime())) throw new Error("Invalid time");
    if (when.getTime() < Date.now() + 5_000) {
      throw new Error("Schedule at least 5 seconds in the future");
    }
    const { data: src, error: sErr } = await context.supabase
      .from("scheduled_broadcasts")
      .select("payload, label")
      .eq("id", data.id)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!src) throw new Error("Source schedule not found");
    const srcPayload = (src.payload as any) ?? {};
    const newPayload = data.op
      ? {
          ...data.op,
          minDelay: data.minDelay ?? Number(srcPayload.minDelay ?? 1),
          maxDelay: data.maxDelay ?? Number(srcPayload.maxDelay ?? 2),
        }
      : {
          ...srcPayload,
          ...(data.minDelay !== undefined ? { minDelay: data.minDelay } : {}),
          ...(data.maxDelay !== undefined ? { maxDelay: data.maxDelay } : {}),
        };
    const { data: row, error } = await context.supabase
      .from("scheduled_broadcasts")
      .insert({
        user_id: context.userId,
        scheduled_at: when.toISOString(),
        label: data.label ?? (src.label as string | null) ?? null,
        payload: JSON.parse(JSON.stringify(newPayload)),
        status: "pending",
        source_id: data.id,
      })
      .select("id, scheduled_at")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string, scheduledAt: row.scheduled_at as string };
  });

export const clearScheduledHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Delete finished/cancelled/failed schedules; keep pending & running.
    const { data: rows, error: selErr } = await context.supabase
      .from("scheduled_broadcasts")
      .select("id, status");
    if (selErr) throw new Error(selErr.message);
    const ids = (rows ?? [])
      .filter((r) => r.status !== "pending" && r.status !== "running")
      .map((r) => r.id as string);
    if (!ids.length) return { deleted: 0 };
    const { error: delErr } = await context.supabase
      .from("scheduled_broadcasts")
      .delete()
      .in("id", ids);
    if (delErr) throw new Error(delErr.message);
    return { deleted: ids.length };
  });

export const deleteScheduledBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Refuse to delete a running schedule to avoid orphaning in-flight work.
    const { data: row, error: selErr } = await context.supabase
      .from("scheduled_broadcasts")
      .select("status")
      .eq("id", data.id)
      .maybeSingle();
    if (selErr) throw new Error(selErr.message);
    if (!row) return { ok: true };
    if (row.status === "running") {
      throw new Error("Cannot delete a running schedule. Wait for it to finish.");
    }
    const { error } = await context.supabase
      .from("scheduled_broadcasts")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getScheduleReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: schedule, error: sErr } = await context.supabase
      .from("scheduled_broadcasts")
      .select("id, scheduled_at, dispatched_at, completed_at, status, label, payload")
      .eq("id", data.id)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!schedule) throw new Error("Schedule not found");

    const { data: items, error: iErr } = await context.supabase
      .from("scheduled_broadcast_items")
      .select("id, account_id, target, scheduled_for, processed_at, status, error, attempt_count, kind")
      .eq("schedule_id", data.id)
      .order("scheduled_for", { ascending: true })
      .limit(1000);
    if (iErr) throw new Error(iErr.message);

    const accountIds = Array.from(new Set((items ?? []).map((i) => i.account_id))).filter(Boolean);
    const accountMap = new Map<string, { label: string; phone: string | null }>();
    if (accountIds.length) {
      const { data: accs } = await context.supabase
        .from("telegram_accounts")
        .select("id, first_name, last_name, username, phone")
        .in("id", accountIds);
      for (const a of accs ?? []) {
        const label =
          [a.first_name, a.last_name].filter(Boolean).join(" ").trim() ||
          (a.username ? `@${a.username}` : null) ||
          a.phone ||
          a.id;
        accountMap.set(a.id as string, { label, phone: (a.phone as string | null) ?? null });
      }
    }

    return {
      schedule: {
        id: schedule.id as string,
        scheduledAt: schedule.scheduled_at as string,
        dispatchedAt: (schedule.dispatched_at as string | null) ?? null,
        completedAt: (schedule.completed_at as string | null) ?? null,
        status: schedule.status as string,
        label: (schedule.label as string | null) ?? null,
      },
      items: (items ?? []).map((i) => {
        const acc = accountMap.get(i.account_id as string);
        const scheduledFor = i.scheduled_for as string;
        const processedAt = (i.processed_at as string | null) ?? null;
        const deltaMs = processedAt
          ? new Date(processedAt).getTime() - new Date(scheduledFor).getTime()
          : null;
        return {
          id: i.id as string,
          accountId: i.account_id as string,
          accountLabel: acc?.label ?? (i.account_id as string),
          accountPhone: acc?.phone ?? null,
          target: (i.target as string | null) ?? null,
          kind: i.kind as string,
          scheduledFor,
          processedAt,
          deltaMs,
          status: i.status as string,
          error: (i.error as string | null) ?? null,
          attemptCount: Number(i.attempt_count ?? 0),
        };
      }),
    };
  });
