
-- Promote uffo7099@gmail.com to owner
DO $$
DECLARE _uid uuid;
BEGIN
  SELECT id INTO _uid FROM auth.users WHERE lower(email) = 'uffo7099@gmail.com' LIMIT 1;
  IF _uid IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (_uid, 'owner')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, role) VALUES (_uid, 'admin')
      ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- is_owner helper
CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(auth.uid(), 'owner')
$$;
REVOKE EXECUTE ON FUNCTION public.is_owner() FROM public;
GRANT EXECUTE ON FUNCTION public.is_owner() TO authenticated, service_role;

-- user_admin_settings: per-user limits + approval status
CREATE TABLE IF NOT EXISTS public.user_admin_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_add_approved boolean NOT NULL DEFAULT false,
  account_limit int NOT NULL DEFAULT 0,
  notes text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.user_admin_settings TO authenticated;
GRANT ALL ON public.user_admin_settings TO service_role;
ALTER TABLE public.user_admin_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self read" ON public.user_admin_settings FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_owner());
CREATE POLICY "owner write" ON public.user_admin_settings FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());
CREATE TRIGGER trg_uas_updated BEFORE UPDATE ON public.user_admin_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-seed default owner as approved with high limit
INSERT INTO public.user_admin_settings (user_id, account_add_approved, account_limit)
SELECT id, true, 999 FROM auth.users WHERE lower(email) = 'uffo7099@gmail.com'
ON CONFLICT (user_id) DO UPDATE SET account_add_approved = true, account_limit = 999;

-- account_add_requests
CREATE TABLE IF NOT EXISTS public.account_add_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
  message text,
  requested_limit int,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aar_user ON public.account_add_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_aar_status ON public.account_add_requests(status);
GRANT SELECT, INSERT, UPDATE ON public.account_add_requests TO authenticated;
GRANT ALL ON public.account_add_requests TO service_role;
ALTER TABLE public.account_add_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self read own" ON public.account_add_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_owner());
CREATE POLICY "self insert" ON public.account_add_requests FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "self cancel own pending" ON public.account_add_requests FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid() AND status IN ('pending','cancelled'));
CREATE POLICY "owner all" ON public.account_add_requests FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());
CREATE TRIGGER trg_aar_updated BEFORE UPDATE ON public.account_add_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- user_feature_permissions: per-user feature toggles (deny-by-presence-of-false)
CREATE TABLE IF NOT EXISTS public.user_feature_permissions (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);
CREATE INDEX IF NOT EXISTS idx_ufp_user ON public.user_feature_permissions(user_id);
GRANT SELECT ON public.user_feature_permissions TO authenticated;
GRANT ALL ON public.user_feature_permissions TO service_role;
ALTER TABLE public.user_feature_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self read" ON public.user_feature_permissions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_owner());
CREATE POLICY "owner write" ON public.user_feature_permissions FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());
CREATE TRIGGER trg_ufp_updated BEFORE UPDATE ON public.user_feature_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- has_feature: owner=true always; else default true unless explicit row says false
CREATE OR REPLACE FUNCTION public.has_feature(_user_id uuid, _feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.has_role(_user_id, 'owner') THEN true
    ELSE COALESCE(
      (SELECT allowed FROM public.user_feature_permissions
        WHERE user_id = _user_id AND feature_key = _feature LIMIT 1),
      true)
  END
$$;
REVOKE EXECUTE ON FUNCTION public.has_feature(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.has_feature(uuid, text) TO authenticated, service_role;

-- request_account_access RPC: caller creates a pending request
CREATE OR REPLACE FUNCTION public.request_account_access(_message text, _requested_limit int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.account_add_requests WHERE user_id = _uid AND status = 'pending') THEN
    RAISE EXCEPTION 'A request is already pending';
  END IF;
  INSERT INTO public.account_add_requests (user_id, message, requested_limit)
    VALUES (_uid, _message, GREATEST(COALESCE(_requested_limit,1),1))
    RETURNING id INTO _id;
  RETURN _id;
END $$;
REVOKE EXECUTE ON FUNCTION public.request_account_access(text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.request_account_access(text, int) TO authenticated;

-- owner: decide a request
CREATE OR REPLACE FUNCTION public.decide_account_request(_id uuid, _approve boolean, _limit int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _target uuid;
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  SELECT user_id INTO _target FROM public.account_add_requests WHERE id = _id FOR UPDATE;
  IF _target IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  UPDATE public.account_add_requests
    SET status = CASE WHEN _approve THEN 'approved' ELSE 'denied' END,
        decided_by = _uid, decided_at = now()
    WHERE id = _id;
  IF _approve THEN
    INSERT INTO public.user_admin_settings (user_id, account_add_approved, account_limit, updated_by)
      VALUES (_target, true, GREATEST(COALESCE(_limit,1),1), _uid)
      ON CONFLICT (user_id) DO UPDATE
        SET account_add_approved = true,
            account_limit = GREATEST(COALESCE(_limit, public.user_admin_settings.account_limit),1),
            updated_by = _uid;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, int) FROM public;
GRANT EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, int) TO authenticated;

-- owner: set role admin/user (owner cannot be changed except by owner; cannot demote self)
CREATE OR REPLACE FUNCTION public.owner_set_role(_target uuid, _make_admin boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  IF public.has_role(_target, 'owner') THEN RAISE EXCEPTION 'cannot change owner role'; END IF;
  IF _make_admin THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (_target, 'admin') ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.user_roles WHERE user_id = _target AND role = 'admin';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.owner_set_role(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.owner_set_role(uuid, boolean) TO authenticated;

-- owner: set feature permission
CREATE OR REPLACE FUNCTION public.owner_set_feature(_target uuid, _feature text, _allowed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  INSERT INTO public.user_feature_permissions (user_id, feature_key, allowed, updated_by)
    VALUES (_target, _feature, _allowed, auth.uid())
    ON CONFLICT (user_id, feature_key) DO UPDATE
      SET allowed = _allowed, updated_by = auth.uid();
END $$;
REVOKE EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) TO authenticated;

-- owner: set account limit / approval directly
CREATE OR REPLACE FUNCTION public.owner_set_user_settings(_target uuid, _approved boolean, _limit int, _notes text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  INSERT INTO public.user_admin_settings (user_id, account_add_approved, account_limit, notes, updated_by)
    VALUES (_target, COALESCE(_approved,false), GREATEST(COALESCE(_limit,0),0), _notes, auth.uid())
    ON CONFLICT (user_id) DO UPDATE
      SET account_add_approved = COALESCE(_approved, public.user_admin_settings.account_add_approved),
          account_limit = GREATEST(COALESCE(_limit, public.user_admin_settings.account_limit),0),
          notes = COALESCE(_notes, public.user_admin_settings.notes),
          updated_by = auth.uid();
END $$;
REVOKE EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, int, text) FROM public;
GRANT EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, int, text) TO authenticated;
