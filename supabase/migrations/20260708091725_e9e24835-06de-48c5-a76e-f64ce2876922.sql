ALTER TABLE public.telegram_accounts ADD COLUMN IF NOT EXISTS telegram_user_id BIGINT;
CREATE INDEX IF NOT EXISTS telegram_accounts_tg_user_id_idx ON public.telegram_accounts(telegram_user_id);