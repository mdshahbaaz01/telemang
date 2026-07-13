
-- Persistent per-account/per-channel join cache with in-flight lock + TTL.
CREATE TABLE public.join_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_flight','joined','requested','failed','skipped')),
  source TEXT,
  locked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  last_error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, target_key)
);
CREATE INDEX idx_join_cache_user ON public.join_cache(user_id);
CREATE INDEX idx_join_cache_expires ON public.join_cache(expires_at) WHERE expires_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_cache TO authenticated;
GRANT ALL ON public.join_cache TO service_role;
ALTER TABLE public.join_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own join cache" ON public.join_cache
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Structured attempt log for FloodWait diagnostics.
CREATE TABLE public.join_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  source TEXT NOT NULL,
  result TEXT NOT NULL,
  wait_ms INT,
  flood_wait_seconds INT,
  error TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_join_attempts_user_time ON public.join_attempts(user_id, created_at DESC);
CREATE INDEX idx_join_attempts_account_time ON public.join_attempts(account_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON public.join_attempts TO authenticated;
GRANT ALL ON public.join_attempts TO service_role;
ALTER TABLE public.join_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own join attempts" ON public.join_attempts
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own join attempts" ON public.join_attempts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own join attempts" ON public.join_attempts
  FOR DELETE USING (auth.uid() = user_id);

-- Per-user pacing configuration.
CREATE TABLE public.join_pacing_config (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  min_delay_ms INT NOT NULL DEFAULT 800,
  max_delay_ms INT NOT NULL DEFAULT 1500,
  batch_size INT NOT NULL DEFAULT 5,
  cache_ttl_hours INT NOT NULL DEFAULT 720,
  lock_ttl_seconds INT NOT NULL DEFAULT 90,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_pacing_config TO authenticated;
GRANT ALL ON public.join_pacing_config TO service_role;
ALTER TABLE public.join_pacing_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own pacing" ON public.join_pacing_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_join_cache_updated BEFORE UPDATE ON public.join_cache
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_join_pacing_updated BEFORE UPDATE ON public.join_pacing_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
