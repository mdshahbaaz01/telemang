-- 1. Revoke EXECUTE on owner-only SECURITY DEFINER functions from public/authenticated.
-- Owner logic is administered from server functions using the service role,
-- not from the Data API, so signed-in users don't need EXECUTE.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'owner_set_role',
        'owner_set_feature',
        'owner_set_user_settings',
        'decide_account_request',
        'request_account_access'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated;', fn.proname, fn.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role;', fn.proname, fn.args);
  END LOOP;
END $$;

-- 2. Feature Requests: prevent requesters from mutating status / priority / owner_note.
CREATE OR REPLACE FUNCTION public.fr_guard_requester_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Owners bypass the guard.
  IF public.has_role(auth.uid(), 'owner') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.owner_note IS DISTINCT FROM OLD.owner_note
  THEN
    RAISE EXCEPTION 'requesters cannot modify status, priority, or owner_note'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fr_guard_requester_updates ON public.feature_requests;
CREATE TRIGGER trg_fr_guard_requester_updates
BEFORE UPDATE ON public.feature_requests
FOR EACH ROW
EXECUTE FUNCTION public.fr_guard_requester_updates();