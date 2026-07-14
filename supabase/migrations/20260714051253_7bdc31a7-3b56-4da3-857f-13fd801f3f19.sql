
-- ============ Owner audit log ============
CREATE TABLE IF NOT EXISTS public.owner_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  target_user_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.owner_audit_log TO authenticated;
GRANT ALL ON public.owner_audit_log TO service_role;

ALTER TABLE public.owner_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner reads audit" ON public.owner_audit_log;
CREATE POLICY "owner reads audit" ON public.owner_audit_log
  FOR SELECT TO authenticated
  USING (public.is_owner());

CREATE INDEX IF NOT EXISTS owner_audit_log_created_at_idx
  ON public.owner_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS owner_audit_log_target_idx
  ON public.owner_audit_log (target_user_id, created_at DESC);

-- ============ Rewrite owner functions to write audit rows ============
CREATE OR REPLACE FUNCTION public.owner_set_role(_target uuid, _role app_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid(); _before jsonb;
BEGIN
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  IF _target = _uid AND _role <> 'owner' THEN RAISE EXCEPTION 'cannot demote yourself'; END IF;
  SELECT COALESCE(jsonb_agg(role), '[]'::jsonb) INTO _before
    FROM public.user_roles WHERE user_id = _target;
  DELETE FROM public.user_roles WHERE user_id=_target;
  INSERT INTO public.user_roles(user_id, role) VALUES (_target, _role) ON CONFLICT DO NOTHING;
  INSERT INTO public.owner_audit_log(actor_id, target_user_id, action, details)
  VALUES (_uid, _target, 'set_role',
    jsonb_build_object('before', _before, 'after', _role::text));
END $function$;

CREATE OR REPLACE FUNCTION public.owner_set_role(_target uuid, _make_admin boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  IF public.has_role(_target, 'owner') THEN RAISE EXCEPTION 'cannot change owner role'; END IF;
  IF _make_admin THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (_target, 'admin') ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.user_roles WHERE user_id = _target AND role = 'admin';
  END IF;
  INSERT INTO public.owner_audit_log(actor_id, target_user_id, action, details)
  VALUES (_uid, _target, CASE WHEN _make_admin THEN 'grant_admin' ELSE 'revoke_admin' END, '{}'::jsonb);
END $function$;

CREATE OR REPLACE FUNCTION public.owner_set_feature(_target uuid, _key text, _allowed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid(); _prev boolean;
BEGIN
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  SELECT allowed INTO _prev FROM public.user_feature_permissions
    WHERE user_id=_target AND feature_key=_key;
  INSERT INTO public.user_feature_permissions(user_id, feature_key, allowed, updated_by)
  VALUES (_target, _key, _allowed, _uid)
  ON CONFLICT (user_id, feature_key)
  DO UPDATE SET allowed=_allowed, updated_by=_uid, updated_at=now();
  INSERT INTO public.owner_audit_log(actor_id, target_user_id, action, details)
  VALUES (_uid, _target, 'set_feature',
    jsonb_build_object('key', _key, 'before', _prev, 'after', _allowed));
END $function$;

CREATE OR REPLACE FUNCTION public.owner_set_user_settings(_target uuid, _approved boolean, _account_limit integer, _notes text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid(); _before jsonb;
BEGIN
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  SELECT to_jsonb(s) INTO _before FROM public.user_admin_settings s WHERE user_id=_target;
  INSERT INTO public.user_admin_settings(user_id, account_add_approved, account_limit, notes, updated_by)
  VALUES (_target, COALESCE(_approved,false), GREATEST(COALESCE(_account_limit,0),0), _notes, _uid)
  ON CONFLICT (user_id) DO UPDATE
    SET account_add_approved=COALESCE(_approved, public.user_admin_settings.account_add_approved),
        account_limit=GREATEST(COALESCE(_account_limit, public.user_admin_settings.account_limit),0),
        notes=COALESCE(_notes, public.user_admin_settings.notes),
        updated_by=_uid, updated_at=now();
  INSERT INTO public.owner_audit_log(actor_id, target_user_id, action, details)
  VALUES (_uid, _target, 'set_user_settings',
    jsonb_build_object('before', _before,
      'after', jsonb_build_object('approved', _approved, 'limit', _account_limit, 'notes', _notes)));
END $function$;

CREATE OR REPLACE FUNCTION public.decide_account_request(_id uuid, _approve boolean, _account_limit integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid; _target uuid;
BEGIN
  _uid := auth.uid();
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  SELECT user_id INTO _target FROM public.account_add_requests WHERE id=_id;
  IF _target IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  UPDATE public.account_add_requests
     SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
         decided_by=_uid, decided_at=now(), updated_at=now()
   WHERE id=_id;
  IF _approve THEN
    INSERT INTO public.user_admin_settings(user_id, account_add_approved, account_limit, updated_by)
    VALUES (_target, true, GREATEST(COALESCE(_account_limit,1),1), _uid)
    ON CONFLICT (user_id) DO UPDATE
      SET account_add_approved=true,
          account_limit=GREATEST(COALESCE(_account_limit, public.user_admin_settings.account_limit),1),
          updated_by=_uid, updated_at=now();
  END IF;
  INSERT INTO public.owner_audit_log(actor_id, target_user_id, action, details)
  VALUES (_uid, _target,
    CASE WHEN _approve THEN 'approve_account_request' ELSE 'reject_account_request' END,
    jsonb_build_object('request_id', _id, 'limit', _account_limit));
END $function$;

-- Re-grant execute to authenticated (was revoked to anon earlier)
REVOKE EXECUTE ON FUNCTION public.owner_set_role(uuid, boolean) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_role(uuid, app_role) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, integer, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_set_role(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, integer) TO authenticated;

-- ============ Lock signup bootstrap ============
-- Owner already provisioned. Prevent any future signup from acquiring admin
-- through the "if no admin exists" branch (defense in depth).
CREATE OR REPLACE FUNCTION public.bootstrap_role_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Every new signup becomes a plain 'user'. Owner/admin promotion is manual
  -- via owner_set_role() only.
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $function$;
