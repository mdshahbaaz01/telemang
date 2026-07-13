
CREATE OR REPLACE FUNCTION public.health_metrics(_window_minutes int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _since timestamptz := now() - make_interval(mins => greatest(_window_minutes, 1));
  _out jsonb;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT jsonb_build_object(
    'window_minutes', _window_minutes,
    'generated_at', now(),

    'actions', (
      SELECT jsonb_build_object(
        'total', count(*),
        'ok', count(*) FILTER (WHERE result IN ('joined','requested','already_participant','acquired')),
        'floods', count(*) FILTER (WHERE result = 'flood'),
        'failures', count(*) FILTER (WHERE result = 'failed'),
        'skipped', count(*) FILTER (WHERE result IN ('skipped','skipped_cached','skipped_locked')),
        'max_flood_seconds', COALESCE(max(flood_wait_seconds), 0),
        'avg_wait_ms', COALESCE(round(avg(wait_ms))::int, 0)
      )
      FROM public.join_attempts
      WHERE user_id = _uid AND created_at >= _since
    ),

    'per_account', (
      SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.total DESC), '[]'::jsonb)
      FROM (
        SELECT
          ja.account_id,
          COALESCE(ta.username, ta.first_name, ta.phone) AS account_label,
          count(*)::int AS total,
          count(*) FILTER (WHERE result = 'flood')::int AS floods,
          count(*) FILTER (WHERE result = 'failed')::int AS failures,
          COALESCE(max(flood_wait_seconds), 0)::int AS max_flood_seconds
        FROM public.join_attempts ja
        LEFT JOIN public.telegram_accounts ta ON ta.id = ja.account_id
        WHERE ja.user_id = _uid AND ja.created_at >= _since
        GROUP BY ja.account_id, ta.username, ta.first_name, ta.phone
        LIMIT 50
      ) t
    ),

    'tasks', (
      SELECT jsonb_build_object(
        'running', count(*) FILTER (WHERE status = 'running'),
        'queued', count(*) FILTER (WHERE status = 'queued'),
        'completed', count(*) FILTER (WHERE status = 'completed' AND updated_at >= _since),
        'failed', count(*) FILTER (WHERE status = 'failed' AND updated_at >= _since),
        'stale', count(*) FILTER (WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '5 minutes'))
      )
      FROM public.join_tasks WHERE user_id = _uid
    ),

    'broadcasts', (
      SELECT jsonb_build_object(
        'pending', count(*) FILTER (WHERE status = 'pending'),
        'dispatched', count(*) FILTER (WHERE status IN ('sent','done','processed') AND processed_at >= _since),
        'failed', count(*) FILTER (WHERE status = 'failed' AND (processed_at >= _since OR updated_at >= _since))
      )
      FROM public.scheduled_broadcast_items
      WHERE user_id = _uid
    ),

    'idempotency', (
      SELECT jsonb_build_object(
        'in_flight', count(*) FILTER (WHERE status = 'in_flight'),
        'done', count(*) FILTER (WHERE status = 'done' AND completed_at >= _since),
        'failed', count(*) FILTER (WHERE status = 'failed' AND completed_at >= _since)
      )
      FROM public.idempotency_keys
      WHERE user_id = _uid AND expires_at > now()
    ),

    'notifications', (
      SELECT jsonb_build_object(
        'sent', count(*) FILTER (WHERE status = 'sent'),
        'failed', count(*) FILTER (WHERE status = 'failed')
      )
      FROM public.notification_logs
      WHERE user_id = _uid AND created_at >= _since
    ),

    'accounts', (
      SELECT jsonb_build_object(
        'total', count(*),
        'active', count(*) FILTER (WHERE status = 'active'),
        'paused', count(*) FILTER (WHERE paused_until IS NOT NULL AND paused_until > now()),
        'error', count(*) FILTER (WHERE last_error IS NOT NULL)
      )
      FROM public.telegram_accounts WHERE user_id = _uid
    ),

    'recent_errors', (
      SELECT COALESCE(jsonb_agg(row_to_json(e) ORDER BY e.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT created_at, target, error, source
        FROM public.join_attempts
        WHERE user_id = _uid AND result IN ('failed','flood') AND created_at >= _since
        ORDER BY created_at DESC
        LIMIT 20
      ) e
    )
  ) INTO _out;

  RETURN _out;
END;
$$;
