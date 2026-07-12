ALTER TABLE public.scheduled_broadcasts
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES public.scheduled_broadcasts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_source_id ON public.scheduled_broadcasts(source_id);