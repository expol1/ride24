create function public.caravel_webhook_keys() returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(decrypted_secret order by name), array[]::text[])
  from vault.decrypted_secrets
  where name in ('caravel_production_webhook_current', 'caravel_production_webhook_previous');
$$;
revoke all on function public.caravel_webhook_keys() from public, anon, authenticated;
grant execute on function public.caravel_webhook_keys() to service_role;
