// Phase 6 — Observability: structured runtime metrics for the signed-in user.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type HealthMetrics = {
  window_minutes: number;
  generated_at: string;
  actions: { total: number; ok: number; floods: number; failures: number; skipped: number; max_flood_seconds: number; avg_wait_ms: number };
  per_account: Array<{ account_id: string; account_label: string | null; total: number; floods: number; failures: number; max_flood_seconds: number }>;
  tasks: { running: number; queued: number; completed: number; failed: number; stale: number };
  broadcasts: { pending: number; dispatched: number; failed: number };
  idempotency: { in_flight: number; done: number; failed: number };
  notifications: { sent: number; failed: number };
  accounts: { total: number; active: number; paused: number; error: number };
  recent_errors: Array<{ created_at: string; target: string | null; error: string | null; source: string | null }>;
};

export const getHealthMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { windowMinutes?: number } | undefined) => ({
    windowMinutes: Math.max(1, Math.min(24 * 60, input?.windowMinutes ?? 60)),
  }))
  .handler(async ({ data, context }) => {
    const { data: metrics, error } = await context.supabase.rpc("health_metrics", {
      _window_minutes: data.windowMinutes,
    });
    if (error) throw new Error(error.message);
    return metrics as HealthMetrics;
  });