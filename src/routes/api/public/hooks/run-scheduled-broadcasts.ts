import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type AdminClient = SupabaseClient<Database>;
type ScheduleRow = {
  id: string;
  user_id: string;
  scheduled_at: string;
  payload: any;
};
type QueueItem = Database["public"]["Tables"]["scheduled_broadcast_items"]["Row"];

import { formatMessage as formatMessageBase } from "@/lib/message-format";
function formatMessage(message: string, format?: "plain" | "mono" | "quote" | "html") {
  const r = formatMessageBase(message, format);
  return { text: r.message, parseMode: r.parseMode };
}

async function resolveScheduledPeer(client: any, Api: any, chat: string, msgId = 1) {
  if (chat.startsWith("c/")) {
    const raw = chat.slice(2);
    const { default: bigInt } = await import("big-integer");
    try {
      return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
    } catch {
      return await client.getEntity(`https://t.me/c/${raw}/${msgId}`);
    }
  }
  return client.getEntity(chat.replace(/^@/, ""));
}

function buildQueueItems(row: ScheduleRow) {
  const payload = row.payload ?? {};
  const kind: "broadcast" | "reply" | "forward" | "edit" | "deleteMessages" =
    ["reply", "forward", "edit", "deleteMessages"].includes(payload.kind) ? payload.kind : "broadcast";
  // Every scheduled item fires at the exact scheduled second — no per-account
  // delay. All accounts broadcast simultaneously at the target time.
  const firesAt = new Date(row.scheduled_at).toISOString();
  const nextTime = (_accountId: string) => firesAt;

  const items: Database["public"]["Tables"]["scheduled_broadcast_items"]["Insert"][] = [];
  if (kind === "broadcast") {
    for (const r of Array.isArray(payload.rows) ? payload.rows : []) {
      for (const target of Array.isArray(r.targets) ? r.targets : []) {
        items.push({
          schedule_id: row.id,
          user_id: row.user_id,
          kind,
          account_id: r.accountId,
          target,
          scheduled_for: nextTime(r.accountId),
          payload: {
            message: r.message ?? "",
            attachment: r.attachment ?? null,
            attachments: Array.isArray(r.attachments) ? r.attachments : null,
            format: r.format ?? "plain",
          },
        });
      }
    }
  } else if (kind === "reply") {
    for (const r of Array.isArray(payload.rows) ? payload.rows : []) {
      items.push({
        schedule_id: row.id,
        user_id: row.user_id,
        kind,
        account_id: r.accountId,
        target: `${payload?.source?.chat ?? "?"}/${payload?.source?.msgId ?? "?"}`,
        scheduled_for: nextTime(r.accountId),
        payload: {
          source: payload.source,
          viaDiscussion: !!payload.viaDiscussion,
          message: r.message ?? "",
          attachment: r.attachment ?? null,
          format: r.format ?? "plain",
        },
      });
    }
  } else if (kind === "forward") {
    for (const accountId of Array.isArray(payload.accountIds) ? payload.accountIds : []) {
      for (const target of Array.isArray(payload.targets) ? payload.targets : []) {
        items.push({
          schedule_id: row.id,
          user_id: row.user_id,
          kind,
          account_id: accountId,
          target,
          scheduled_for: nextTime(accountId),
          payload: { source: payload.source },
        });
      }
    }
  } else if (kind === "edit") {
    for (const accountId of Array.isArray(payload.accountIds) ? payload.accountIds : []) {
      items.push({
        schedule_id: row.id,
        user_id: row.user_id,
        kind,
        account_id: accountId,
        target: `${payload?.source?.chat ?? "?"}/${payload?.source?.msgId ?? "?"}`,
        scheduled_for: nextTime(accountId),
        payload: { source: payload.source, message: payload.message ?? "", format: payload.format ?? "plain" },
      });
    }
  } else {
    for (const accountId of Array.isArray(payload.accountIds) ? payload.accountIds : []) {
      items.push({
        schedule_id: row.id,
        user_id: row.user_id,
        kind,
        account_id: accountId,
        target: payload.chat,
        scheduled_for: nextTime(accountId),
        payload: { chat: payload.chat, messageIds: payload.messageIds ?? [], revoke: payload.revoke !== false },
      });
    }
  }
  return items;
}

async function finalizeSchedule(admin: AdminClient, scheduleId: string) {
  const { data: schedule } = await admin
    .from("scheduled_broadcasts")
    .select("user_id, payload")
    .eq("id", scheduleId)
    .maybeSingle();
  const { data: items, error } = await admin
    .from("scheduled_broadcast_items")
    .select("status, error")
    .eq("schedule_id", scheduleId);
  if (error || !items) return;
  const processed = items.filter((i) => i.status === "done" || i.status === "failed").length;
  const active = items.some((i) => i.status === "pending" || i.status === "processing");
  if (active) {
    await admin.from("scheduled_broadcasts").update({ processed_items: processed }).eq("id", scheduleId);
    return;
  }
  const failed = items.filter((i) => i.status === "failed");
  const status = failed.length === items.length ? "failed" : "done";
  const errorText = failed.length ? failed.slice(0, 5).map((i) => i.error).filter(Boolean).join(" | ") : null;
  await admin
    .from("scheduled_broadcasts")
    .update({
      status,
      processed_items: processed,
      completed_at: new Date().toISOString(),
      error: errorText,
    })
    .eq("id", scheduleId);
  if (schedule?.user_id) {
    const kind = (schedule.payload as any)?.kind ?? "broadcast";
    const { notifyUser } = await import("@/lib/notifications.server");
    await notifyUser(
      admin,
      schedule.user_id,
      failed.length ? "failure" : "success",
      failed.length ? "Scheduled action finished with failures" : "Scheduled action completed",
      `${kind}: ${processed - failed.length} delivered, ${failed.length} failed${errorText ? ` — ${errorText}` : ""}`,
    ).catch(() => undefined);
    if (failed.length) {
      const { notifyOwner } = await import("@/lib/notifications.server");
      await notifyOwner(
        admin,
        schedule.user_id,
        "job_failure",
        "Scheduled job failed",
        `${kind}: ${failed.length}/${processed} failed${errorText ? ` — ${errorText}` : ""}`,
      ).catch(() => undefined);
    }
  }
}

async function executeQueueItem(admin: AdminClient, item: QueueItem) {
  const { executeBroadcast, executeReply, executeForward } = await import("@/lib/broadcast-executor.server");
  const payload = (item.payload ?? {}) as any;
  if (item.kind === "reply") {
    return executeReply(admin, {
      source: payload.source,
      viaDiscussion: !!payload.viaDiscussion,
      minDelay: 0,
      maxDelay: 0,
      rows: [{ accountId: item.account_id, message: payload.message ?? "", attachment: payload.attachment ?? undefined, format: payload.format ?? "plain" }],
    });
  }
  if (item.kind === "forward") {
    return executeForward(admin, {
      source: payload.source,
      minDelay: 0,
      maxDelay: 0,
      accountIds: [item.account_id],
      targets: item.target ? [item.target] : [],
    });
  }
  if (item.kind === "edit" || item.kind === "deleteMessages") {
    const { openClientForAccount } = await import("@/lib/cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(admin, item.account_id);
    try {
      if (item.kind === "edit") {
        const source = payload.source;
        const peer = await resolveScheduledPeer(client, Api, source.chat, source.msgId);
        const formatted = formatMessage(payload.message ?? "", payload.format ?? "plain");
        await client.editMessage(peer, {
          message: source.msgId,
          text: formatted.text,
          parseMode: formatted.parseMode,
        });
        return { ok: 1, fail: 0, logs: [{ accountId: item.account_id, target: item.target, level: "success", message: `Edited ${item.target}` }] };
      }
      const peer = await resolveScheduledPeer(client, Api, payload.chat, payload.messageIds?.[0] ?? 1);
      const ids = Array.isArray(payload.messageIds) ? payload.messageIds : [];
      await client.deleteMessages(peer, ids, { revoke: payload.revoke !== false });
      return { ok: ids.length, fail: 0, logs: [{ accountId: item.account_id, target: item.target, level: "success", message: `Deleted ${ids.length} message(s)` }] };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
  return executeBroadcast(admin, {
    minDelay: 0,
    maxDelay: 0,
    rows: [{
      accountId: item.account_id,
      message: payload.message ?? "",
      targets: item.target ? [item.target] : [],
      attachment: payload.attachment ?? undefined,
      attachments: Array.isArray(payload.attachments) && payload.attachments.length ? payload.attachments : undefined,
      format: payload.format ?? "plain",
    }],
  });
}

/**
 * Called every minute by pg_cron. Picks up any pending scheduled broadcasts
 * due within the next ~90 seconds and fires each one at the exact millisecond
 * of its scheduled_at (setTimeout precision, ±<1s in practice).
 */
export const Route = createFileRoute("/api/public/hooks/run-scheduled-broadcasts")({
  server: {
    handlers: {
      POST: async () => {
        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const admin = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });

        // ── Stale item watchdog ───────────────────────────────────────────
        // A timed-out request can leave a small batch locked. Re-open it for
        // the next cron tick instead of failing the entire scheduled action.
        const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
        await admin
          .from("scheduled_broadcast_items")
          .update({
            status: "pending",
            locked_at: null,
            error: "Previous worker timed out; automatically continued on the next tick.",
          })
          .eq("status", "processing")
          .lt("locked_at", staleCutoff);

        await admin
          .from("scheduled_broadcasts")
          .update({
            status: "pending",
            dispatched_at: null,
            error: "Previous worker timed out; automatically queued again.",
          })
          .eq("status", "running")
          .eq("total_items", 0)
          .lt("dispatched_at", staleCutoff);

        const now = Date.now();
        const horizon = new Date(now + 90_000).toISOString();
        const { data: due, error } = await admin
          .from("scheduled_broadcasts")
          .select("id, user_id, scheduled_at, payload")
          .eq("status", "pending")
          .lte("scheduled_at", horizon)
          .order("scheduled_at", { ascending: true })
          .limit(20);
        if (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }

        const claimed: ScheduleRow[] = [];
        for (const row of due ?? []) {
          const { data: upd, error: uerr } = await admin
            .from("scheduled_broadcasts")
            .update({ status: "running", dispatched_at: new Date().toISOString() })
            .eq("id", row.id)
            .eq("status", "pending")
            .select("id")
            .maybeSingle();
          if (!uerr && upd) claimed.push(row as ScheduleRow);
        }

        for (const row of claimed) {
          const items = buildQueueItems(row);
          if (!items.length) {
            await admin
              .from("scheduled_broadcasts")
              .update({
                status: "failed",
                completed_at: new Date().toISOString(),
                error: "No delivery items found in the scheduled payload.",
              })
              .eq("id", row.id);
            continue;
          }
          const { error: insertErr } = await admin.from("scheduled_broadcast_items").insert(items);
          if (insertErr) {
            await admin
              .from("scheduled_broadcasts")
              .update({ status: "failed", completed_at: new Date().toISOString(), error: insertErr.message })
              .eq("id", row.id);
            continue;
          }
          await admin
            .from("scheduled_broadcasts")
            .update({ total_items: items.length, processed_items: 0 })
            .eq("id", row.id);
        }

        // Pick up every item whose scheduled_for falls inside this tick's
        // window. We fire them in parallel below, so a large batch (e.g. 29
        // accounts starting at the same minute) all go out within the tick
        // instead of being sliced across 4-5 minutes.
        const processingHorizon = new Date(Date.now() + 55_000).toISOString();
        const { data: pendingItems, error: itemErr } = await admin
          .from("scheduled_broadcast_items")
          .select("*")
          .eq("status", "pending")
          .lte("scheduled_for", processingHorizon)
          .order("scheduled_for", { ascending: true })
          .limit(100);
        if (itemErr) return Response.json({ error: itemErr.message }, { status: 500 });

        const touchedSchedules = new Set<string>(claimed.map((r) => r.id));
        await Promise.all(
          (pendingItems ?? []).map(async (item) => {
            const { data: locked } = await admin
              .from("scheduled_broadcast_items")
              .update({ status: "processing", locked_at: new Date().toISOString(), attempt_count: item.attempt_count + 1 })
              .eq("id", item.id)
              .eq("status", "pending")
              .select("*")
              .maybeSingle();
            if (!locked) return;
            touchedSchedules.add(locked.schedule_id);
            const wait = Math.max(0, new Date(locked.scheduled_for).getTime() - Date.now());
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            try {
              const res = await executeQueueItem(admin, locked as QueueItem);
              const failed = res.fail > 0 || res.ok === 0;
              await admin
                .from("scheduled_broadcast_items")
                .update({
                  status: failed ? "failed" : "done",
                  processed_at: new Date().toISOString(),
                  locked_at: null,
                  error: failed ? res.logs.filter((l) => l.level === "error").slice(0, 3).map((l) => l.message).join(" | ") || "Delivery failed" : null,
                })
                .eq("id", locked.id);
            } catch (e) {
              await admin
                .from("scheduled_broadcast_items")
                .update({
                  status: "failed",
                  processed_at: new Date().toISOString(),
                  locked_at: null,
                  error: (e as Error).message,
                })
                .eq("id", locked.id);
            }
          }),
        );

        for (const scheduleId of touchedSchedules) {
          await finalizeSchedule(admin, scheduleId);
        }

        return Response.json({ picked: claimed.length, processed: pendingItems?.length ?? 0 });
      },
    },
  },
});