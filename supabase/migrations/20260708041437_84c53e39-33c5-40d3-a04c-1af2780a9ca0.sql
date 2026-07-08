
CREATE TABLE public.telegram_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  api_id INTEGER NOT NULL,
  api_hash_enc TEXT NOT NULL,
  session_enc TEXT,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  paused_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_accounts TO authenticated;
GRANT ALL ON public.telegram_accounts TO service_role;
ALTER TABLE public.telegram_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own accounts" ON public.telegram_accounts FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  api_id INTEGER NOT NULL,
  api_hash_enc TEXT NOT NULL,
  phone_code_hash TEXT,
  session_enc TEXT,
  stage TEXT NOT NULL DEFAULT 'code_sent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.login_attempts TO authenticated;
GRANT ALL ON public.login_attempts TO service_role;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own attempts" ON public.login_attempts FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.join_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  min_delay INTEGER NOT NULL DEFAULT 15,
  max_delay INTEGER NOT NULL DEFAULT 45,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_tasks TO authenticated;
GRANT ALL ON public.join_tasks TO service_role;
ALTER TABLE public.join_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own tasks" ON public.join_tasks FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.join_task_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.join_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  processed_at TIMESTAMPTZ,
  position INTEGER NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.join_task_items TO authenticated;
GRANT ALL ON public.join_task_items TO service_role;
ALTER TABLE public.join_task_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own task items" ON public.join_task_items FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_task_items_task ON public.join_task_items(task_id, position);

CREATE TABLE public.task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.join_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_logs TO authenticated;
GRANT ALL ON public.task_logs TO service_role;
ALTER TABLE public.task_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own logs" ON public.task_logs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_task_logs_task ON public.task_logs(task_id, created_at DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE public.task_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.join_task_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.join_tasks;
