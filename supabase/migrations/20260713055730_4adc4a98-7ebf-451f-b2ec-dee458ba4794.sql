
-- Presets
CREATE TABLE public.action_presets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_action_presets_user_kind ON public.action_presets(user_id, kind);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.action_presets TO authenticated;
GRANT ALL ON public.action_presets TO service_role;
ALTER TABLE public.action_presets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own presets" ON public.action_presets FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER set_action_presets_updated BEFORE UPDATE ON public.action_presets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Favorites
CREATE TABLE public.user_favorites (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id TEXT,
  label TEXT NOT NULL,
  href TEXT,
  icon TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_favorites_user ON public.user_favorites(user_id, sort_order);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_favorites TO authenticated;
GRANT ALL ON public.user_favorites TO service_role;
ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own favorites" ON public.user_favorites FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Account picker memory
CREATE TABLE public.account_pick_memory (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_pick_memory TO authenticated;
GRANT ALL ON public.account_pick_memory TO service_role;
ALTER TABLE public.account_pick_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pick memory" ON public.account_pick_memory FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER set_account_pick_memory_updated BEFORE UPDATE ON public.account_pick_memory FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Checkpoints for auto-resume
ALTER TABLE public.join_tasks
  ADD COLUMN IF NOT EXISTS progress_cursor INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_checkpoint JSONB,
  ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_task_id UUID;

ALTER TABLE public.scheduled_broadcasts
  ADD COLUMN IF NOT EXISTS progress_cursor INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_checkpoint JSONB,
  ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_count INT NOT NULL DEFAULT 0;
