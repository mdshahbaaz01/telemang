
REVOKE ALL ON FUNCTION public.run_log_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_log_retention() TO service_role;
