
CREATE OR REPLACE FUNCTION public.recent_account_health(_account_id uuid)
RETURNS TABLE(attempts bigint, floods bigint, failures bigint, max_flood_seconds int)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE result = 'flood')::bigint,
    count(*) FILTER (WHERE result = 'failed')::bigint,
    COALESCE(max(flood_wait_seconds), 0)::int
  FROM public.join_attempts
  WHERE account_id = _account_id
    AND created_at > now() - interval '5 minutes';
$$;
