DROP POLICY IF EXISTS fr_update_own_open ON public.feature_requests;

CREATE POLICY fr_update_own_open ON public.feature_requests
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id AND status = 'open')
WITH CHECK (
  auth.uid() = user_id
  AND status = 'open'
  AND status IS NOT DISTINCT FROM (SELECT status FROM public.feature_requests WHERE id = feature_requests.id)
  AND priority IS NOT DISTINCT FROM (SELECT priority FROM public.feature_requests WHERE id = feature_requests.id)
  AND owner_note IS NOT DISTINCT FROM (SELECT owner_note FROM public.feature_requests WHERE id = feature_requests.id)
  AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM public.feature_requests WHERE id = feature_requests.id)
);