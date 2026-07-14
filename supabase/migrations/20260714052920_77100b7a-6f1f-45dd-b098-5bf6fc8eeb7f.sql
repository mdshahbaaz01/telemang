
-- ============= FEATURE REQUESTS =============
CREATE TABLE public.feature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 140),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  category text NOT NULL DEFAULT 'feature' CHECK (category IN ('feature','bug','improvement')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','planned','in_progress','done','declined')),
  priority text NOT NULL DEFAULT 'med' CHECK (priority IN ('low','med','high')),
  owner_note text,
  votes_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_requests TO authenticated;
GRANT ALL ON public.feature_requests TO service_role;
ALTER TABLE public.feature_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fr_select_all_authenticated" ON public.feature_requests
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "fr_insert_own" ON public.feature_requests
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "fr_update_own_open" ON public.feature_requests
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND status = 'open')
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "fr_update_owner" ON public.feature_requests
  FOR UPDATE TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());
CREATE POLICY "fr_delete_own_open" ON public.feature_requests
  FOR DELETE TO authenticated USING (auth.uid() = user_id AND status = 'open');
CREATE POLICY "fr_delete_owner" ON public.feature_requests
  FOR DELETE TO authenticated USING (public.is_owner());

CREATE INDEX idx_fr_status ON public.feature_requests(status);
CREATE INDEX idx_fr_votes ON public.feature_requests(votes_count DESC);
CREATE INDEX idx_fr_created ON public.feature_requests(created_at DESC);

CREATE TRIGGER trg_fr_updated BEFORE UPDATE ON public.feature_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Votes
CREATE TABLE public.feature_request_votes (
  request_id uuid NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
GRANT SELECT, INSERT, DELETE ON public.feature_request_votes TO authenticated;
GRANT ALL ON public.feature_request_votes TO service_role;
ALTER TABLE public.feature_request_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "frv_select_own" ON public.feature_request_votes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "frv_insert_own" ON public.feature_request_votes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "frv_delete_own" ON public.feature_request_votes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Vote counters
CREATE OR REPLACE FUNCTION public.fr_bump_votes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.feature_requests SET votes_count = votes_count + 1 WHERE id = NEW.request_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.feature_requests SET votes_count = GREATEST(votes_count - 1, 0) WHERE id = OLD.request_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_frv_ins AFTER INSERT ON public.feature_request_votes
  FOR EACH ROW EXECUTE FUNCTION public.fr_bump_votes();
CREATE TRIGGER trg_frv_del AFTER DELETE ON public.feature_request_votes
  FOR EACH ROW EXECUTE FUNCTION public.fr_bump_votes();

-- ============= USER SESSIONS =============
CREATE TABLE public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_key text NOT NULL,
  user_agent text,
  ip_hash text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(user_id, session_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_sessions TO authenticated;
GRANT ALL ON public.user_sessions TO service_role;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "us_select_own_or_owner" ON public.user_sessions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "us_insert_own" ON public.user_sessions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "us_update_own" ON public.user_sessions
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "us_delete_own_or_owner" ON public.user_sessions
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_owner());

CREATE INDEX idx_us_user ON public.user_sessions(user_id, last_seen_at DESC);

-- ============= ONBOARDING STATE =============
ALTER TABLE public.user_admin_settings
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb;
