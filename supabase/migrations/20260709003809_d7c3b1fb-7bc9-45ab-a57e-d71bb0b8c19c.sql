ALTER TABLE public.join_tasks ADD COLUMN IF NOT EXISTS auto_leave_after_days integer;

ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS alert_on_ban boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alert_on_peer_flood boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alert_on_job_failure boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS daily_summary_ist_time text,
  ADD COLUMN IF NOT EXISTS daily_summary_last_sent_date date;

ALTER TABLE public.join_task_items ADD COLUMN IF NOT EXISTS leave_after timestamptz;
ALTER TABLE public.join_task_items ADD COLUMN IF NOT EXISTS left_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_join_task_items_leave_after ON public.join_task_items (leave_after) WHERE leave_after IS NOT NULL AND left_at IS NULL;