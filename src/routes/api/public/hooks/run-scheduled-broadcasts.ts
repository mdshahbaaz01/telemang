import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
        if (!due?.length) return Response.json({ picked: 0 });

        // Claim rows atomically so a second worker tick doesn't double-dispatch.
        const claimed: typeof due = [];
        for (const row of due) {
          const { data: upd, error: uerr } = await admin
            .from("scheduled_broadcasts")
            .update({ status: "running", dispatched_at: new Date().toISOString() })
            .eq("id", row.id)
            .eq("status", "pending")
            .select("id")
            .maybeSingle();
          if (!uerr && upd) claimed.push(row);
        }

        const { executeBroadcast, executeReply, executeForward } = await import("@/lib/broadcast-executor.server");

        // Fire all claimed schedules concurrently. Each waits until its own
        // scheduled_at millisecond, then dispatches.
        await Promise.all(
          claimed.map(async (row) => {
            const target = new Date(row.scheduled_at as string).getTime();
            const delay = Math.max(0, target - Date.now());
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));

            const payload = row.payload as any;
            const kind: "broadcast" | "reply" | "forward" =
              payload?.kind === "reply" || payload?.kind === "forward" ? payload.kind : "broadcast";
            const minDelay = payload?.minDelay ?? 1;
            const maxDelay = payload?.maxDelay ?? 2;
            try {
              let res;
              if (kind === "reply") {
                res = await executeReply(admin, {
                  source: payload.source,
                  viaDiscussion: !!payload.viaDiscussion,
                  rows: payload.rows,
                  minDelay,
                  maxDelay,
                });
              } else if (kind === "forward") {
                res = await executeForward(admin, {
                  source: payload.source,
                  accountIds: payload.accountIds,
                  targets: payload.targets,
                  minDelay,
                  maxDelay,
                });
              } else {
                res = await executeBroadcast(admin, {
                  rows: payload.rows,
                  minDelay,
                  maxDelay,
                });
              }
              await admin
                .from("scheduled_broadcasts")
                .update({
                  status: res.fail === 0 ? "done" : res.ok === 0 ? "failed" : "done",
                  completed_at: new Date().toISOString(),
                  error: res.fail
                    ? res.logs.filter((l) => l.level === "error").slice(0, 5).map((l) => l.message).join(" | ")
                    : null,
                })
                .eq("id", row.id);
            } catch (e) {
              await admin
                .from("scheduled_broadcasts")
                .update({
                  status: "failed",
                  completed_at: new Date().toISOString(),
                  error: (e as Error).message,
                })
                .eq("id", row.id);
            }
          }),
        );

        return Response.json({ picked: claimed.length });
      },
    },
  },
});