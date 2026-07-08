ALTER TABLE public.scheduled_broadcasts
  ADD COLUMN IF NOT EXISTS total_items integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processed_items integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.scheduled_broadcast_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.scheduled_broadcasts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  account_id uuid NOT NULL,
  target text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  scheduled_for timestamptz NOT NULL,
  locked_at timestamptz,
  processed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.scheduled_broadcast_items TO authenticated;
GRANT ALL ON public.scheduled_broadcast_items TO service_role;

ALTER TABLE public.scheduled_broadcast_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read their scheduled delivery items"
ON public.scheduled_broadcast_items
FOR SELECT
TO authenticated
USING ((auth.uid() = user_id) OR has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcast_items_due
ON public.scheduled_broadcast_items (status, scheduled_for, schedule_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcast_items_schedule
ON public.scheduled_broadcast_items (schedule_id);

DROP TRIGGER IF EXISTS set_scheduled_broadcast_items_updated_at ON public.scheduled_broadcast_items;
CREATE TRIGGER set_scheduled_broadcast_items_updated_at
BEFORE UPDATE ON public.scheduled_broadcast_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_broadcasts TO authenticated;
GRANT ALL ON public.scheduled_broadcasts TO service_role;