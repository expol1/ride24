-- Caravel sandbox certification reference cache. Private Postgres, NOT Storage.
-- Necessary because existing storage.objects policy permits authenticated INSERT
-- outside certain buckets. This table has RLS and grants only service_role.
-- No Ride24 bookings, Stripe, AVIA, user, or partner tables are changed.
create table if not exists public.caravel_sbx_reference_snapshots (
  session_id uuid not null,
  supplier_id text not null check (supplier_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (session_id,supplier_id)
);

alter table public.caravel_sbx_reference_snapshots enable row level security;
revoke all on public.caravel_sbx_reference_snapshots from public,anon,authenticated;
grant select,insert,update,delete on public.caravel_sbx_reference_snapshots to service_role;

create or replace function public.caravel_sbx_reference_load(
  p_session_id uuid,p_supplier_id text
) returns jsonb
language sql stable security invoker set search_path=''
as $$
  select snapshot
  from public.caravel_sbx_reference_snapshots
  where session_id=p_session_id and supplier_id=p_supplier_id
    and p_supplier_id ~ '^[A-Za-z0-9_-]{1,128}$'
$$;

create or replace function public.caravel_sbx_reference_save(
  p_session_id uuid,p_supplier_id text,p_snapshot jsonb
) returns boolean
language plpgsql security invoker set search_path=''
as $$
declare kind text;
begin
  if p_session_id is null or p_supplier_id is null or
    p_supplier_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_snapshot is null or
    jsonb_typeof(p_snapshot)<>'object' or
    pg_catalog.octet_length(p_snapshot::text)>1048576 or
    (select count(*) from pg_catalog.jsonb_object_keys(p_snapshot) as k(key)
      where k.key not in ('locations','vehicles','protections','extras'))<>0
  then raise exception 'CARAVEL_REFERENCE_BAD_SNAPSHOT'; end if;
  foreach kind in array array['locations','vehicles','protections','extras'] loop
    if jsonb_typeof(p_snapshot->kind)<>'array' or jsonb_array_length(p_snapshot->kind)>300
    then raise exception 'CARAVEL_REFERENCE_BAD_CATALOGUE'; end if;
  end loop;
  insert into public.caravel_sbx_reference_snapshots(session_id,supplier_id,snapshot)
    values (p_session_id,p_supplier_id,p_snapshot)
    on conflict(session_id,supplier_id) do update
       set snapshot=excluded.snapshot,updated_at=clock_timestamp();
  return true;
end;
$$;

create or replace function public.caravel_sbx_reference_clear(
  p_session_id uuid,p_supplier_id text
) returns boolean
language plpgsql security invoker set search_path=''
as $$
begin
  if p_session_id is null or p_supplier_id is null or
     p_supplier_id !~ '^[A-Za-z0-9_-]{1,128}$'
  then raise exception 'CARAVEL_REFERENCE_BAD_SCOPE'; end if;
  delete from public.caravel_sbx_reference_snapshots
  where session_id=p_session_id and supplier_id=p_supplier_id;
  return found;
end;
$$;

revoke all on function public.caravel_sbx_reference_load(uuid,text) from public,anon,authenticated;
revoke all on function public.caravel_sbx_reference_save(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.caravel_sbx_reference_clear(uuid,text) from public,anon,authenticated;
grant execute on function public.caravel_sbx_reference_load(uuid,text) to service_role;
grant execute on function public.caravel_sbx_reference_save(uuid,text,jsonb) to service_role;
grant execute on function public.caravel_sbx_reference_clear(uuid,text) to service_role;
