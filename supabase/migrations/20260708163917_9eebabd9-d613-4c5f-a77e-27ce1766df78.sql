CREATE TABLE public.account_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_groups TO authenticated;
GRANT ALL ON public.account_groups TO service_role;
ALTER TABLE public.account_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own account groups" ON public.account_groups
  FOR ALL TO authenticated
  USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR has_role(auth.uid(), 'admin'));
CREATE TRIGGER set_account_groups_updated_at
  BEFORE UPDATE ON public.account_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.account_group_members (
  group_id uuid NOT NULL REFERENCES public.account_groups(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_group_members TO authenticated;
GRANT ALL ON public.account_group_members TO service_role;
ALTER TABLE public.account_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own group members" ON public.account_group_members
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.account_groups g
      WHERE g.id = account_group_members.group_id
        AND (g.user_id = auth.uid() OR has_role(auth.uid(), 'admin'))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.account_groups g
      WHERE g.id = account_group_members.group_id
        AND (g.user_id = auth.uid() OR has_role(auth.uid(), 'admin'))
    )
  );
CREATE INDEX idx_account_group_members_account ON public.account_group_members(account_id);

ALTER TABLE public.join_tasks
  ADD COLUMN IF NOT EXISTS auto_leave_after_days integer;