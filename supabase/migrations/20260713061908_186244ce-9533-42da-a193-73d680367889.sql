
CREATE INDEX IF NOT EXISTS idx_join_task_items_task_id ON public.join_task_items(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_created ON public.task_logs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_run_created ON public.action_logs(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_join_tasks_created ON public.join_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_join_attempts_acc_target_created ON public.join_attempts(account_id, target, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inline_button_clicks_created ON public.inline_button_clicks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_parse_results_captured ON public.bot_parse_results(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcast_items_schedule ON public.scheduled_broadcast_items(schedule_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcast_items_due ON public.scheduled_broadcast_items(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_referral_joins_link_joined ON public.referral_joins(referral_link_id, joined_at DESC);
