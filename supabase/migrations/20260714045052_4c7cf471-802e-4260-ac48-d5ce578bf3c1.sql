
DROP FUNCTION IF EXISTS public.decide_account_request(uuid, boolean, integer);
DROP FUNCTION IF EXISTS public.owner_set_role(uuid, public.app_role);
DROP FUNCTION IF EXISTS public.owner_set_feature(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.owner_set_user_settings(uuid, boolean, integer, text);
DROP FUNCTION IF EXISTS public.request_account_access(text, integer);

CREATE FUNCTION public.request_account_access(_message text, _requested_limit int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  UPDATE public.account_add_requests SET status='cancelled', updated_at=now()
   WHERE user_id=_uid AND status='pending';
  INSERT INTO public.account_add_requests(user_id, message, requested_limit, status)
  VALUES (_uid, _message, COALESCE(_requested_limit,1), 'pending')
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE FUNCTION public.decide_account_request(_id uuid, _approve boolean, _account_limit int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;

CREATE FUNCTION public.owner_set_role(_target uuid, _role public.app_role)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  IF _target = _uid AND _role <> 'owner' THEN RAISE EXCEPTION 'cannot demote yourself'; END IF;
  DELETE FROM public.user_roles WHERE user_id=_target;
  INSERT INTO public.user_roles(user_id, role) VALUES (_target, _role) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION public.owner_set_feature(_target uuid, _key text, _allowed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  INSERT INTO public.user_feature_permissions(user_id, feature_key, allowed, updated_by)
  VALUES (_target, _key, _allowed, _uid)
  ON CONFLICT (user_id, feature_key)
  DO UPDATE SET allowed=_allowed, updated_by=_uid, updated_at=now();
END $$;

CREATE FUNCTION public.owner_set_user_settings(_target uuid, _approved boolean, _account_limit int, _notes text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF NOT public.has_role(_uid,'owner') THEN RAISE EXCEPTION 'owner only'; END IF;
  INSERT INTO public.user_admin_settings(user_id, account_add_approved, account_limit, notes, updated_by)
  VALUES (_target, COALESCE(_approved,false), GREATEST(COALESCE(_account_limit,0),0), _notes, _uid)
  ON CONFLICT (user_id) DO UPDATE
    SET account_add_approved=COALESCE(_approved, public.user_admin_settings.account_add_approved),
        account_limit=GREATEST(COALESCE(_account_limit, public.user_admin_settings.account_limit),0),
        notes=COALESCE(_notes, public.user_admin_settings.notes),
        updated_by=_uid, updated_at=now();
END $$;

GRANT EXECUTE ON FUNCTION public.request_account_access(text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, int, text) TO authenticated;
