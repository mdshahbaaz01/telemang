-- Drop redundant indexes (identical or covered by a superset composite)
DROP INDEX IF EXISTS public.idx_task_logs_task;
DROP INDEX IF EXISTS public.idx_action_logs_run;
DROP INDEX IF EXISTS public.idx_join_task_items_task_id;

-- Add missing user-scoped index for /health and scheduled broadcast queries
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcast_items_user_processed
  ON public.scheduled_broadcast_items (user_id, processed_at DESC);

-- Tighten SECURITY DEFINER RPC exposure via the Data API.
-- bootstrap_role_on_signup is an auth trigger — should never be callable via REST.
REVOKE ALL ON FUNCTION public.bootstrap_role_on_signup() FROM PUBLIC, anon, authenticated;

-- has_role / is_admin are used inside RLS policies; policies invoke them
-- regardless of grants, but callers should not be able to probe arbitrary
-- (user_id, role) pairs from the client. Revoke public/anon, keep authenticated.
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;

-- health_metrics / recent_account_health are for signed-in users only.
REVOKE ALL ON FUNCTION public.health_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.health_metrics(integer) TO authenticated;

REVOKE ALL ON FUNCTION public.recent_account_health(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recent_account_health(uuid) TO authenticated;

-- run_log_retention is called by the retention cron with the service role only.
REVOKE ALL ON FUNCTION public.run_log_retention() FROM PUBLIC, anon, authenticated;