REVOKE SELECT (owner_note) ON public.feature_requests FROM authenticated;
GRANT SELECT (owner_note) ON public.feature_requests TO service_role;

DROP POLICY IF EXISTS "Owners can create notification logs" ON public.notification_logs;
CREATE POLICY "Owners or self can create notification logs"
ON public.notification_logs
FOR INSERT
TO authenticated
WITH CHECK (public.is_owner() OR auth.uid() = user_id);