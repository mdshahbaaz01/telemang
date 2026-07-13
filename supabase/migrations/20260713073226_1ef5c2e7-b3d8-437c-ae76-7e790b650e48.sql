-- Idempotent guard migration: safe to re-run.
-- 1) Re-assert index cleanup + additions from prior perf pass with IF [NOT] EXISTS.
DROP INDEX IF EXISTS public.idx_task_logs_task;
DROP INDEX IF EXISTS public.idx_action_logs_run;
DROP INDEX IF EXISTS public.idx_join_task_items_task_id;

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcast_items_user_processed
  ON public.scheduled_broadcast_items (user_id, processed_at DESC);

-- 2) Re-assert function grant lockdown idempotently.
DO $$
DECLARE
  fn text;
  sigs text[] := ARRAY[
    'public.has_role(uuid, public.app_role)',
    'public.is_admin()',
    'public.health_metrics(integer)',
    'public.recent_account_health(uuid)',
    'public.bootstrap_role_on_signup()',
    'public.run_log_retention()'
  ];
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skip missing function %', fn;
    END;
  END LOOP;

  -- Grant back only what the app actually needs
  BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated'; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated'; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.health_metrics(integer) TO authenticated'; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.recent_account_health(uuid) TO authenticated'; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.run_log_retention() TO service_role'; EXCEPTION WHEN undefined_function THEN NULL; END;
END $$;

-- 3) Reusable helper for future migrations: safe index drop by name.
CREATE OR REPLACE FUNCTION public.drop_index_if_exists(_schema text, _name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE format('DROP INDEX IF EXISTS %I.%I', _schema, _name);
END;
$$;

REVOKE ALL ON FUNCTION public.drop_index_if_exists(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drop_index_if_exists(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.drop_index_if_exists(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.drop_index_if_exists(text, text) TO service_role;

-- 4) Reusable helper: ensure a role has EXECUTE on a function only if the function exists.
CREATE OR REPLACE FUNCTION public.ensure_function_grant(_signature text, _role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', _signature, _role);
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'ensure_function_grant: function % missing, skipped', _signature;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_function_grant(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_function_grant(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_function_grant(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_function_grant(text, text) TO service_role;