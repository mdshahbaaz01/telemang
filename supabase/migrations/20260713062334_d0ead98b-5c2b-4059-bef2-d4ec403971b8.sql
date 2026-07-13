
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

  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.run_log_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_log_retention() TO service_role;
