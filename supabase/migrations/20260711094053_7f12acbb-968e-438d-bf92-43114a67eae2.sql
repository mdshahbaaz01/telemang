
ALTER TABLE public.telegram_accounts ADD COLUMN IF NOT EXISTS signature text;

CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL DEFAULT '',
  format text NOT NULL DEFAULT 'plain',
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_templates TO authenticated;
GRANT ALL ON public.message_templates TO service_role;
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own templates" ON public.message_templates;
CREATE POLICY "own templates" ON public.message_templates FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_user ON public.message_templates(user_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_msg_templates_updated ON public.message_templates;
CREATE TRIGGER trg_msg_templates_updated BEFORE UPDATE ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
