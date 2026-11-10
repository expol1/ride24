-- Renteon Aggregator credentials are kept in encrypted Supabase Vault.
-- This function never grants access to anon/authenticated callers.
-- Only service_role from a server-side Edge Function can retrieve them.
create or replace function public.renteon_aggregator_server_credentials()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_login text;
  v_password text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Unauthorized service role operation';
  end if;

  select decrypted_secret into v_login
    from vault.decrypted_secrets
   where name = 'ride24_renteon_aggregator_username'
   limit 1;

  select decrypted_secret into v_password
    from vault.decrypted_secrets
   where name = 'ride24_renteon_aggregator_password'
   limit 1;

  if v_login is null or v_login = '' or v_password is null or v_password = '' then
    raise exception 'Missing Renteon aggregator credentials in Vault';
  end if;

  return pg_catalog.jsonb_build_object(
    'username', v_login,
    'password', v_password
  );
end;
$function$;
revoke all on function public.renteon_aggregator_server_credentials() from public;
revoke all on function public.renteon_aggregator_server_credentials() from anon;
revoke all on function public.renteon_aggregator_server_credentials() from authenticated;
grant execute on function public.renteon_aggregator_server_credentials() to service_role;
