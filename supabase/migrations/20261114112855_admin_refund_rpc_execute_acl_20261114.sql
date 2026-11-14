-- Applies only to the admin manual-refund settlement RPC.
-- Deny all anonymous requests; preserve logged-in admin calls (the function validates profiles.role='admin').
revoke execute on function public.admin_mark_refund_done(uuid) from public,anon;
grant execute on function public.admin_mark_refund_done(uuid) to authenticated,service_role;
