ALTER TABLE public.bot_parse_rules ADD COLUMN IF NOT EXISTS classification text;
ALTER TABLE public.bot_parse_results ADD COLUMN IF NOT EXISTS classification text;
CREATE INDEX IF NOT EXISTS idx_bot_parse_results_bot_class ON public.bot_parse_results (bot_username, classification, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_parse_rules_user_bot ON public.bot_parse_rules (user_id, bot_username);