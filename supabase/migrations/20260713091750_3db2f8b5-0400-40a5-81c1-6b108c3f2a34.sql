CREATE TABLE public.password_reset_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_requests_email_hash_created_at_idx
  ON public.password_reset_requests (email_hash, created_at DESC);

GRANT ALL ON public.password_reset_requests TO service_role;

ALTER TABLE public.password_reset_requests ENABLE ROW LEVEL SECURITY;

-- No policies: only service_role (server admin client) reads/writes this table.

CREATE OR REPLACE FUNCTION public.check_password_reset_rate_limit(
  _email_hash text,
  _min_interval_seconds int DEFAULT 60,
  _hourly_cap int DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _last timestamptz;
  _hourly_count int;
  _wait int := 0;
BEGIN
  SELECT max(created_at) INTO _last
  FROM public.password_reset_requests
  WHERE email_hash = _email_hash;

  SELECT count(*) INTO _hourly_count
  FROM public.password_reset_requests
  WHERE email_hash = _email_hash
    AND created_at > now() - interval '1 hour';

  IF _last IS NOT NULL THEN
    _wait := greatest(0, _min_interval_seconds - extract(epoch FROM (now() - _last))::int);
  END IF;

  IF _hourly_count >= _hourly_cap THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'hourly_cap',
      'retry_after_seconds', greatest(_wait, 60),
      'hourly_count', _hourly_count
    );
  END IF;

  IF _wait > 0 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'retry_after_seconds', _wait,
      'hourly_count', _hourly_count
    );
  END IF;

  INSERT INTO public.password_reset_requests (email_hash) VALUES (_email_hash);

  RETURN jsonb_build_object(
    'allowed', true,
    'retry_after_seconds', _min_interval_seconds,
    'hourly_count', _hourly_count + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_password_reset_rate_limit(text, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.check_password_reset_rate_limit(text, int, int) TO service_role;