-- Optional automatic, time-dependent charges for LOCAL partner quotes.
-- No rows are created or switched on by this migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.partner_time_fees (
    id uuid primary key default gen_random_uuid(),
    partner_id uuid not null references public.partners(id) on delete cascade,
    location_id uuid references public.partner_locations(id) on delete restrict,
    applies_to text not null check (applies_to in ('pickup','return','either')),
    starts_at time without time zone not null,
    ends_at time without time zone not null,
    amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
    once_per_booking boolean not null default true,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    constraint partner_time_fees_window_nonzero check (starts_at <> ends_at)
);
create index partner_time_fees_partner_idx on public.partner_time_fees(partner_id,active);

-- A location-specific fee must point to this same partner, not another partner.
create function public.validate_partner_time_fee_location()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
    if new.location_id is not null and not exists (
        select 1 from public.partner_locations l
        where l.id = new.location_id and l.partner_id = new.partner_id
          and l.active = true and coalesce(l.is_api_managed,false) = false
    ) then
        raise exception 'TIME_FEE_LOCATION_NOT_OWNED';
    end if;
    return new;
end;
$$;
revoke all on function public.validate_partner_time_fee_location() from public, anon, authenticated;
create trigger validate_partner_time_fee_location_before_write
before insert or update on public.partner_time_fees
for each row execute function public.validate_partner_time_fee_location();

alter table public.partner_time_fees enable row level security;
revoke all on public.partner_time_fees from public, anon, authenticated;
grant select, insert, update, delete on public.partner_time_fees to authenticated;
grant all on public.partner_time_fees to service_role;
create policy partner_time_fees_owner_select on public.partner_time_fees for select to authenticated
using (exists (select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy partner_time_fees_owner_insert on public.partner_time_fees for insert to authenticated
with check (exists (select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy partner_time_fees_owner_update on public.partner_time_fees for update to authenticated
using (exists (select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'))
with check (exists (select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy partner_time_fees_owner_delete on public.partner_time_fees for delete to authenticated
using (exists (select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));

commit;
