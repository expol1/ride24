-- Disable legacy browser-callable procedures that deleted financial history
-- and, in one case, suppressed errors while deleting auth.users directly.
-- New account removal is done only by admin-account-delete Edge Function with
-- service-role preflight and GoTrue Auth Admin API verification.
REVOKE ALL ON FUNCTION public.admin_hard_delete_user(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_partner(uuid)
  FROM PUBLIC, anon, authenticated;
