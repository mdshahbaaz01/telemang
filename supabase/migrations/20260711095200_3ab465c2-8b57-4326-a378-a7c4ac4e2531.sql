-- 1) bot_parse_rules
CREATE TABLE public.bot_parse_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  bot_username text NOT NULL,
  regex text NOT NULL,
  field_name text NOT NULL,
  unit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_parse_rules TO authenticated;
GRANT ALL ON public.bot_parse_rules TO service_role;
ALTER TABLE public.bot_parse_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rules select" ON public.bot_parse_rules FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "own rules insert" ON public.bot_parse_rules FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own rules update" ON public.bot_parse_rules FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own rules delete" ON public.bot_parse_rules FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_bot_parse_rules_updated BEFORE UPDATE ON public.bot_parse_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_bot_parse_rules_user ON public.bot_parse_rules(user_id);

-- 2) bot_parse_results
CREATE TABLE public.bot_parse_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.bot_parse_rules(id) ON DELETE SET NULL,
  account_id uuid NOT NULL,
  bot_username text NOT NULL,
  field_name text NOT NULL,
  raw_text text,
  value_numeric numeric,
  value_text text,
  captured_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_parse_results TO authenticated;
GRANT ALL ON public.bot_parse_results TO service_role;
ALTER TABLE public.bot_parse_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own results select" ON public.bot_parse_results FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "own results insert" ON public.bot_parse_results FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own results delete" ON public.bot_parse_results FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE INDEX idx_bot_parse_results_user_captured ON public.bot_parse_results(user_id, captured_at DESC);
CREATE INDEX idx_bot_parse_results_account_field ON public.bot_parse_results(account_id, field_name, captured_at DESC);

-- 3) referral_links
CREATE TABLE public.referral_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_username text NOT NULL,
  base_link text NOT NULL,
  my_ref_code text,
  note text,
  balance_field text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_links TO authenticated;
GRANT ALL ON public.referral_links TO service_role;
ALTER TABLE public.referral_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reflinks select" ON public.referral_links FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "own reflinks insert" ON public.referral_links FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own reflinks update" ON public.referral_links FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own reflinks delete" ON public.referral_links FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_referral_links_updated BEFORE UPDATE ON public.referral_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_referral_links_user ON public.referral_links(user_id);

-- 4) referral_joins
CREATE TABLE public.referral_joins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referral_link_id uuid NOT NULL REFERENCES public.referral_links(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  joined_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  last_balance_numeric numeric,
  last_balance_text text,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (referral_link_id, account_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_joins TO authenticated;
GRANT ALL ON public.referral_joins TO service_role;
ALTER TABLE public.referral_joins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own refjoins select" ON public.referral_joins FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "own refjoins insert" ON public.referral_joins FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own refjoins update" ON public.referral_joins FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own refjoins delete" ON public.referral_joins FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_referral_joins_updated BEFORE UPDATE ON public.referral_joins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_referral_joins_link ON public.referral_joins(referral_link_id);
CREATE INDEX idx_referral_joins_user ON public.referral_joins(user_id);