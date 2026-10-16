-- Additive schema for server-authoritative pricing. Charging remains disabled.
-- No backfill and no feature activation in this schema change.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table public.partner_locations add column return_fee_amount numeric(12,2) not null default 0
  check (return_fee_amount >= 0 and return_fee_amount <= 1000000);
alter table public.bookings add column pricing_items_snapshot jsonb;
create table public.booking_feature_flags (
  id boolean primary key default true check (id),
  priced_extras_enabled boolean not null default false
);
insert into public.booking_feature_flags(id) values (true);
alter table public.booking_feature_flags enable row level security;
revoke all on public.booking_feature_flags from public, anon, authenticated;
grant all on public.booking_feature_flags to service_role;

create table public.partner_extras (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  code text not null check(code in ('child_seat','booster_seat','gps','additional_driver','custom')),
  name_en text not null check(length(btrim(name_en)) between 1 and 120 and name_en !~ '[<>[:cntrl:]]'),
  name_pl text check(name_pl is null or (length(btrim(name_pl)) between 1 and 120 and name_pl !~ '[<>[:cntrl:]]')),
  amount numeric(12,2) not null default 0 check(amount >= 0 and amount <= 1000000),
  billing text not null default 'rental' check(billing in ('rental','day')),
  max_quantity integer not null default 1 check(max_quantity between 1 and 10),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check(code <> 'additional_driver' or max_quantity = 1)
);
create index partner_extras_partner_idx on public.partner_extras(partner_id);
create unique index partner_extras_standard_active_idx on public.partner_extras(partner_id,code)
  where active and code <> 'custom';
alter table public.partner_extras enable row level security;
revoke all on public.partner_extras from public, anon, authenticated;
grant select, insert, update on public.partner_extras to authenticated;
grant all on public.partner_extras to service_role;
create policy partner_extras_read on public.partner_extras for select to authenticated
  using (exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy partner_extras_insert on public.partner_extras for insert to authenticated
  with check (exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy partner_extras_update on public.partner_extras for update to authenticated
  using (exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'))
  with check (exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));

create function public.guard_booking_items_snapshot() returns trigger language plpgsql security invoker
set search_path = pg_catalog as $$
begin
  if current_user in ('anon','authenticated') then
    if TG_OP='INSERT' then
      if NEW.pricing_items_snapshot is not null then raise exception 'PRICING_SNAPSHOT_READ_ONLY'; end if;
    elsif NEW.pricing_items_snapshot is distinct from OLD.pricing_items_snapshot then
      raise exception 'PRICING_SNAPSHOT_READ_ONLY';
    end if;
  end if;
  return NEW;
end;
$$;
revoke all on function public.guard_booking_items_snapshot() from public, anon, authenticated;
create trigger booking_items_snapshot_guard before insert or update on public.bookings
  for each row execute function public.guard_booking_items_snapshot();
commit;
