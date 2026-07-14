
REVOKE EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_feature(uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_owner() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_role(uuid, boolean) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_role(uuid, app_role) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, integer, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_account_access(text, integer) FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.decide_account_request(uuid, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_feature(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_feature(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_role(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_set_user_settings(uuid, boolean, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_account_access(text, integer) TO authenticated;
