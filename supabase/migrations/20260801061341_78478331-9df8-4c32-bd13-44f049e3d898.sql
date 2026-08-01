CREATE TABLE public.forward_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_peer_key text NOT NULL,
  source_label text,
  target_peer_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  mode text NOT NULL DEFAULT 'forward',
  drop_author boolean NOT NULL DEFAULT false,
  include_keywords text,
  exclude_keywords text,
  media_only boolean NOT NULL DEFAULT false,
  delay_ms integer NOT NULL DEFAULT 400,
  enabled boolean NOT NULL DEFAULT true,
  last_msg_id bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_error text,
  forwarded_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_rules_mode_chk CHECK (mode IN ('forward','copy'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.forward_rules TO authenticated;
GRANT ALL ON public.forward_rules TO service_role;
ALTER TABLE public.forward_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forward_rules_own" ON public.forward_rules FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_forward_rules_enabled ON public.forward_rules (enabled, last_run_at);
CREATE INDEX idx_forward_rules_user ON public.forward_rules (user_id);

CREATE TRIGGER forward_rules_set_updated_at
  BEFORE UPDATE ON public.forward_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.forward_rule_events (
  id bigserial PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES public.forward_rules(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  msg_id bigint,
  target_peer_key text,
  status text NOT NULL,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, DELETE ON public.forward_rule_events TO authenticated;
GRANT ALL ON public.forward_rule_events TO service_role;
ALTER TABLE public.forward_rule_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forward_rule_events_select_own" ON public.forward_rule_events FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "forward_rule_events_delete_own" ON public.forward_rule_events FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_forward_rule_events_rule ON public.forward_rule_events (rule_id, created_at DESC);