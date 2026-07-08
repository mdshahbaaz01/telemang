
-- Actions module: reactions, forwarder, poll voter
CREATE TABLE public.action_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('react','forward','vote')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','stopped','error')),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.action_runs TO authenticated;
GRANT ALL ON public.action_runs TO service_role;
ALTER TABLE public.action_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read all action_runs" ON public.action_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins can write action_runs" ON public.action_runs
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins can update action_runs" ON public.action_runs
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins can delete action_runs" ON public.action_runs
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.action_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.action_runs(id) ON DELETE CASCADE,
  account_id UUID,
  target TEXT,
  level TEXT NOT NULL CHECK (level IN ('info','success','warn','error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_action_logs_run ON public.action_logs(run_id, created_at);

GRANT SELECT, INSERT ON public.action_logs TO authenticated;
GRANT USAGE ON SEQUENCE public.action_logs_id_seq TO authenticated;
GRANT ALL ON public.action_logs TO service_role;
GRANT ALL ON SEQUENCE public.action_logs_id_seq TO service_role;
ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read action_logs" ON public.action_logs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins can insert action_logs" ON public.action_logs
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'));
