CREATE TABLE public.join_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_key text NOT NULL,
  chat_id text,
  chat_type text,
  title text,
  username text,
  requires_approval boolean NOT NULL DEFAULT false,
  is_public boolean NOT NULL DEFAULT false,
  discussion_chat_id text,
  migrated_from_chat_id text,
  drift jsonb,
  drift_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_fingerprints TO authenticated;
GRANT ALL ON public.join_fingerprints TO service_role;
ALTER TABLE public.join_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own join fingerprints" ON public.join_fingerprints FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.join_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  target_key text NOT NULL,
  chat_id text,
  chat_type text,
  status text NOT NULL DEFAULT 'joined',
  method text,
  error_code text,
  checks integer NOT NULL DEFAULT 0,
  verify_after timestamptz,
  verified_at timestamptz,
  last_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_id, target_key)
);
CREATE INDEX idx_join_memberships_sweep ON public.join_memberships (user_id, status, verify_after);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_memberships TO authenticated;
GRANT ALL ON public.join_memberships TO service_role;
ALTER TABLE public.join_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own join memberships" ON public.join_memberships FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE TRIGGER trg_join_memberships_updated_at BEFORE UPDATE ON public.join_memberships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.join_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  target_key text NOT NULL,
  reason text NOT NULL,
  error_code text,
  permanent boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_id, target_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_blocklist TO authenticated;
GRANT ALL ON public.join_blocklist TO service_role;
ALTER TABLE public.join_blocklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own join blocklist" ON public.join_blocklist FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());