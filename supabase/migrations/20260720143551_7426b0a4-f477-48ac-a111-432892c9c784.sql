
-- 1) Revoke EXECUTE on trigger function from anon/authenticated/public.
REVOKE ALL ON FUNCTION public.fr_guard_requester_updates() FROM PUBLIC, anon, authenticated;

-- 2) Fix fr_update_own_open policy: drop the self-referential WITH CHECK.
-- The existing fr_guard_requester_updates BEFORE UPDATE trigger already
-- prevents requesters from changing status/priority/owner_note/user_id.
DROP POLICY IF EXISTS fr_update_own_open ON public.feature_requests;
CREATE POLICY fr_update_own_open ON public.feature_requests
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND status = 'open')
  WITH CHECK (auth.uid() = user_id AND status = 'open');
