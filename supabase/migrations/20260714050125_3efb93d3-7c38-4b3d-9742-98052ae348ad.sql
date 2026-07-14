
-- Restrict cross-user access to owner only. Admins can now only touch their own data.

-- telegram_accounts
DROP POLICY IF EXISTS "admins all telegram_accounts" ON public.telegram_accounts;
CREATE POLICY "owner all telegram_accounts" ON public.telegram_accounts
  FOR ALL USING (public.is_owner()) WITH CHECK (public.is_owner());

-- join_tasks
DROP POLICY IF EXISTS "admins all join_tasks" ON public.join_tasks;
CREATE POLICY "owner all join_tasks" ON public.join_tasks
  FOR ALL USING (public.is_owner()) WITH CHECK (public.is_owner());

-- join_task_items
DROP POLICY IF EXISTS "admins all join_task_items" ON public.join_task_items;
CREATE POLICY "owner all join_task_items" ON public.join_task_items
  FOR ALL USING (public.is_owner()) WITH CHECK (public.is_owner());

-- task_logs
DROP POLICY IF EXISTS "admins all task_logs" ON public.task_logs;
CREATE POLICY "owner all task_logs" ON public.task_logs
  FOR ALL USING (public.is_owner()) WITH CHECK (public.is_owner());

-- login_attempts
DROP POLICY IF EXISTS "admins all login_attempts" ON public.login_attempts;
CREATE POLICY "owner all login_attempts" ON public.login_attempts
  FOR ALL USING (public.is_owner()) WITH CHECK (public.is_owner());

-- account_groups (had admin OR — restrict to owner OR)
DROP POLICY IF EXISTS "Own account groups" ON public.account_groups;
CREATE POLICY "Own account groups" ON public.account_groups
  FOR ALL USING (auth.uid() = user_id OR public.is_owner())
  WITH CHECK (auth.uid() = user_id OR public.is_owner());

-- account_group_members
DROP POLICY IF EXISTS "Own group members" ON public.account_group_members;
CREATE POLICY "Own group members" ON public.account_group_members
  FOR ALL USING (EXISTS (
    SELECT 1 FROM public.account_groups g
    WHERE g.id = account_group_members.group_id
      AND (g.user_id = auth.uid() OR public.is_owner())
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM public.account_groups g
    WHERE g.id = account_group_members.group_id
      AND (g.user_id = auth.uid() OR public.is_owner())
  ));

-- bot_parse_results / bot_parse_rules
DROP POLICY IF EXISTS "own results select" ON public.bot_parse_results;
DROP POLICY IF EXISTS "own results delete" ON public.bot_parse_results;
CREATE POLICY "own results select" ON public.bot_parse_results
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own results delete" ON public.bot_parse_results
  FOR DELETE USING (auth.uid() = user_id OR public.is_owner());

DROP POLICY IF EXISTS "own rules select" ON public.bot_parse_rules;
DROP POLICY IF EXISTS "own rules delete" ON public.bot_parse_rules;
CREATE POLICY "own rules select" ON public.bot_parse_rules
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own rules delete" ON public.bot_parse_rules
  FOR DELETE USING (auth.uid() = user_id OR public.is_owner());

-- notifications
DROP POLICY IF EXISTS "Owners can read notification logs" ON public.notification_logs;
CREATE POLICY "Owners can read notification logs" ON public.notification_logs
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());

DROP POLICY IF EXISTS "Owners manage notification settings" ON public.notification_settings;
CREATE POLICY "Owners manage notification settings" ON public.notification_settings
  FOR ALL USING (auth.uid() = user_id OR public.is_owner())
  WITH CHECK (auth.uid() = user_id OR public.is_owner());

-- referrals
DROP POLICY IF EXISTS "own refjoins select" ON public.referral_joins;
DROP POLICY IF EXISTS "own refjoins delete" ON public.referral_joins;
CREATE POLICY "own refjoins select" ON public.referral_joins
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own refjoins delete" ON public.referral_joins
  FOR DELETE USING (auth.uid() = user_id OR public.is_owner());

DROP POLICY IF EXISTS "own reflinks select" ON public.referral_links;
DROP POLICY IF EXISTS "own reflinks delete" ON public.referral_links;
CREATE POLICY "own reflinks select" ON public.referral_links
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own reflinks delete" ON public.referral_links
  FOR DELETE USING (auth.uid() = user_id OR public.is_owner());

-- scheduled broadcasts
DROP POLICY IF EXISTS "Owners manage own schedules" ON public.scheduled_broadcasts;
CREATE POLICY "Owners manage own schedules" ON public.scheduled_broadcasts
  FOR ALL USING (auth.uid() = user_id OR public.is_owner())
  WITH CHECK (auth.uid() = user_id OR public.is_owner());

DROP POLICY IF EXISTS "Owners can read their scheduled delivery items" ON public.scheduled_broadcast_items;
CREATE POLICY "Owners can read their scheduled delivery items" ON public.scheduled_broadcast_items
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());

-- action_runs (admin-only policies → owner-only + own-user)
DROP POLICY IF EXISTS "Admins can read all action_runs" ON public.action_runs;
DROP POLICY IF EXISTS "Admins can write action_runs" ON public.action_runs;
DROP POLICY IF EXISTS "Admins can update action_runs" ON public.action_runs;
DROP POLICY IF EXISTS "Admins can delete action_runs" ON public.action_runs;
CREATE POLICY "own or owner select action_runs" ON public.action_runs
  FOR SELECT USING (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own or owner insert action_runs" ON public.action_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own or owner update action_runs" ON public.action_runs
  FOR UPDATE USING (auth.uid() = user_id OR public.is_owner())
  WITH CHECK (auth.uid() = user_id OR public.is_owner());
CREATE POLICY "own or owner delete action_runs" ON public.action_runs
  FOR DELETE USING (auth.uid() = user_id OR public.is_owner());

-- action_logs (no user_id — scope through run_id)
DROP POLICY IF EXISTS "Admins can read action_logs" ON public.action_logs;
DROP POLICY IF EXISTS "Admins can insert action_logs" ON public.action_logs;
CREATE POLICY "own or owner select action_logs" ON public.action_logs
  FOR SELECT USING (
    public.is_owner() OR EXISTS (
      SELECT 1 FROM public.action_runs r
      WHERE r.id = action_logs.run_id AND r.user_id = auth.uid()
    )
  );
CREATE POLICY "own or owner insert action_logs" ON public.action_logs
  FOR INSERT WITH CHECK (
    public.is_owner() OR EXISTS (
      SELECT 1 FROM public.action_runs r
      WHERE r.id = action_logs.run_id AND r.user_id = auth.uid()
    )
  );

-- inline_button_clicks (already has own-user policies; replace admin read with owner)
DROP POLICY IF EXISTS "Admins can read inline_button_clicks" ON public.inline_button_clicks;
CREATE POLICY "Owner can read all inline_button_clicks" ON public.inline_button_clicks
  FOR SELECT USING (public.is_owner());

-- user_roles: admins listing/managing all roles → owner only
DROP POLICY IF EXISTS "admins read all roles" ON public.user_roles;
DROP POLICY IF EXISTS "admins insert roles" ON public.user_roles;
DROP POLICY IF EXISTS "admins delete roles" ON public.user_roles;
CREATE POLICY "owner read all roles" ON public.user_roles
  FOR SELECT USING (public.is_owner());
CREATE POLICY "owner insert roles" ON public.user_roles
  FOR INSERT WITH CHECK (public.is_owner());
CREATE POLICY "owner delete roles" ON public.user_roles
  FOR DELETE USING (public.is_owner());
