
-- Phase 5: Executor hardening — idempotency + adaptive pacing helpers

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key text PRIMARY KEY,
  user_id uuid NOT NULL,
  scope text NOT NULL,
  result jsonb,
  status text NOT NULL DEFAULT 'in_flight',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idempotency_keys_user_idx ON public.idempotency_keys(user_id, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON public.idempotency_keys(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys TO authenticated;
GRANT ALL ON public.idempotency_keys TO service_role;

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own idempotency keys"
  ON public.idempotency_keys FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Extend retention to also trim expired idempotency keys
CREATE OR REPLACE FUNCTION public.run_log_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb := '{}'::jsonb;
  n bigint;
BEGIN
  DELETE FROM public.task_logs           WHERE created_at < now() - interval '14 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('task_logs', n);

  DELETE FROM public.action_logs         WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('action_logs', n);

  DELETE FROM public.join_attempts       WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('join_attempts', n);

  DELETE FROM public.inline_button_clicks WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('inline_button_clicks', n);

  DELETE FROM public.notification_logs   WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('notification_logs', n);

  DELETE FROM public.captcha_solve_log   WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('captcha_solve_log', n);

  DELETE FROM public.bot_parse_results   WHERE created_at < now() - interval '60 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('bot_parse_results', n);

  DELETE FROM public.login_attempts      WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('login_attempts', n);

  DELETE FROM public.join_cache          WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('join_cache', n);

  DELETE FROM public.idempotency_keys    WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('idempotency_keys', n);

  RETURN r;
END;
$$;

-- Adaptive pacing snapshot: recent (5 min) flood/failure signal per account
CREATE OR REPLACE FUNCTION public.recent_account_health(_account_id uuid)
RETURNS TABLE(attempts bigint, floods bigint, failures bigint, max_flood_seconds int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint AS attempts,
    count(*) FILTER (WHERE result = 'flood')::bigint AS floods,
    count(*) FILTER (WHERE result = 'failed')::bigint AS failures,
    COALESCE(max(flood_wait_seconds), 0)::int AS max_flood_seconds
  FROM public.join_attempts
  WHERE account_id = _account_id
    AND created_at > now() - interval '5 minutes';
$$;

GRANT EXECUTE ON FUNCTION public.recent_account_health(uuid) TO authenticated, service_role;
