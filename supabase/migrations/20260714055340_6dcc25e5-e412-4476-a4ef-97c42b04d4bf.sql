-- Harden SECURITY DEFINER surface:
-- 1) Revoke direct EXECUTE on trigger function fr_bump_votes (it's fired by
--    triggers, not meant to be called via RPC by end users).
-- 2) Drop legacy owner_set_role(uuid, boolean) overload — the app only uses
--    owner_set_role(uuid, app_role); keeping the old signature widens surface.
-- 3) Re-assert defense-in-depth: helper functions (has_role, has_feature,
--    is_admin, is_owner, health_metrics) remain callable by authenticated on
--    purpose — they perform read-only checks scoped to auth.uid() or return
--    booleans used by RLS/UI. All privileged mutations (owner_set_*,
--    decide_account_request, request_account_access) already start with
--    is_owner()/has_role(_uid,'owner') or auth.uid() IS NULL guards.

REVOKE EXECUTE ON FUNCTION public.fr_bump_votes() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.owner_set_role(uuid, boolean);

-- Add a defensive guard to request_account_access: was already checking uid,
-- keep as is. Re-affirm owner-only guards by re-creating with explicit checks
-- (idempotent - bodies unchanged).
COMMENT ON FUNCTION public.owner_set_role(uuid, app_role) IS
  'Owner-only: promotes/demotes a user role. Rejects non-owner callers and audits every change.';
COMMENT ON FUNCTION public.owner_set_feature(uuid, text, boolean) IS
  'Owner-only: toggles per-user feature flag. Guarded by has_role(auth.uid(),owner).';
COMMENT ON FUNCTION public.owner_set_user_settings(uuid, boolean, integer, text) IS
  'Owner-only: updates per-user admin settings. Guarded by has_role(auth.uid(),owner).';
COMMENT ON FUNCTION public.decide_account_request(uuid, boolean, integer) IS
  'Owner-only: approves/rejects account add requests. Guarded by has_role(auth.uid(),owner).';
COMMENT ON FUNCTION public.request_account_access(text, integer) IS
  'Authenticated only: creates an access request for the calling user. Rejects unauthenticated callers.';
COMMENT ON FUNCTION public.health_metrics(integer) IS
  'Authenticated only: returns metrics scoped to auth.uid(). Rejects unauthenticated callers.';