CREATE TABLE public.broadcast_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_filename text,
  format text NOT NULL DEFAULT 'plain',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcast_mappings TO authenticated;
GRANT ALL ON public.broadcast_mappings TO service_role;
ALTER TABLE public.broadcast_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own broadcast mappings" ON public.broadcast_mappings FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_broadcast_mappings_updated BEFORE UPDATE ON public.broadcast_mappings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_broadcast_mappings_user ON public.broadcast_mappings(user_id, created_at DESC);