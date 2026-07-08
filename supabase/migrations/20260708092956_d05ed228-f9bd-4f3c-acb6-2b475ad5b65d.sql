CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.scheduled_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  label TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_broadcasts_due_idx ON public.scheduled_broadcasts (status, scheduled_at);
CREATE INDEX scheduled_broadcasts_user_idx ON public.scheduled_broadcasts (user_id, scheduled_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_broadcasts TO authenticated;
GRANT ALL ON public.scheduled_broadcasts TO service_role;

ALTER TABLE public.scheduled_broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage own schedules"
  ON public.scheduled_broadcasts FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER scheduled_broadcasts_set_updated_at
  BEFORE UPDATE ON public.scheduled_broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();