DROP TRIGGER IF EXISTS fr_guard_requester_updates_trg ON public.feature_requests;
CREATE TRIGGER fr_guard_requester_updates_trg
  BEFORE UPDATE ON public.feature_requests
  FOR EACH ROW EXECUTE FUNCTION public.fr_guard_requester_updates();

REVOKE EXECUTE ON FUNCTION public.fr_guard_requester_updates() FROM PUBLIC, anon, authenticated;