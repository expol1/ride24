-- Add conditional, mandatory booking surcharges and explicit closed time windows.
-- Additive only. No partner rows are migrated by this schema change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.partner_time_fees
  add column requires_approval boolean not null default false;

create table public.partner_time_blocks (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  location_id uuid references public.partner_locations(id) on delete restrict,
  applies_to text not null check (applies_to in ('pickup','return','either')),
  starts_at time without time zone not null,
  ends_at time without time zone not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint partner_time_blocks_window_nonzero check (starts_at<>ends_at)
);
create index partner_time_blocks_partner_idx on public.partner_time_blocks(partner_id,active);
create unique index partner_time_blocks_active_window_unique on public.partner_time_blocks
  (partner_id, location_id, applies_to, starts_at, ends_at) nulls not distinct where active;
create trigger validate_partner_time_block_location_before_write
before insert or update on public.partner_time_blocks for each row
execute function public.validate_partner_time_fee_location();

create table public.partner_conditional_fees (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  kind text not null check (kind in ('location_either','cross_city')),
  location_id uuid references public.partner_locations(id) on delete restrict,
  city_scope text[],
  name_pl text not null check (length(btrim(name_pl)) between 1 and 120 and name_pl !~ '[<>[:cntrl:]]'),
  name_en text not null check (length(btrim(name_en)) between 1 and 120 and name_en !~ '[<>[:cntrl:]]'),
  amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint partner_conditional_fee_configuration check (
    (kind='location_either' and location_id is not null and city_scope is null)
    or (kind='cross_city' and location_id is null and array_length(city_scope,1) between 2 and 12)
  )
);
create index partner_conditional_fees_partner_idx on public.partner_conditional_fees(partner_id,active);
create unique index partner_conditional_fees_location_unique on public.partner_conditional_fees(partner_id,location_id)
  where active and kind='location_either';
create trigger validate_partner_conditional_fee_location_before_write
before insert or update on public.partner_conditional_fees for each row
execute function public.validate_partner_time_fee_location();

-- Live private rollback records; mandatory charges are never deleted on cutover.
create table public.partner_fee_migration_audit (
 id uuid primary key default gen_random_uuid(),
 source_extra_id uuid not null unique,
 original_extra jsonb not null,
 target_type text not null check (target_type in ('time','conditional')),
 migrated_at timestamptz not null default now()
);

alter table public.partner_time_blocks enable row level security;
alter table public.partner_conditional_fees enable row level security;
alter table public.partner_fee_migration_audit enable row level security;
revoke all on public.partner_time_blocks,public.partner_conditional_fees,public.partner_fee_migration_audit from public,anon,authenticated;
grant select,insert,update,delete on public.partner_time_blocks,public.partner_conditional_fees to authenticated;
grant all on public.partner_time_blocks,public.partner_conditional_fees,public.partner_fee_migration_audit to service_role;

create policy time_block_read on public.partner_time_blocks for select to authenticated
using(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy time_block_insert on public.partner_time_blocks for insert to authenticated
with check(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy time_block_update on public.partner_time_blocks for update to authenticated
using(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'))
with check(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy time_block_delete on public.partner_time_blocks for delete to authenticated
using(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));

create policy conditional_fee_read on public.partner_conditional_fees for select to authenticated
using(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy conditional_fee_insert on public.partner_conditional_fees for insert to authenticated
with check(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy conditional_fee_update on public.partner_conditional_fees for update to authenticated
using(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'))
with check(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
create policy conditional_fee_delete on public.partner_conditional_fees for delete to authenticated
using(exists(select 1 from public.partners p where p.id=partner_id and p.user_id=(select auth.uid()) and coalesce(p.provider_type,'local')='local'));
commit;
