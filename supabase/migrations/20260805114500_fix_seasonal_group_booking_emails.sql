-- Ride24 LIVE hotfix: seasonal pricing, group bookings and booking e-mails.
-- Additive/destructive scope is limited to replacing functions and removing
-- the single-vehicle overlap constraint, which is incompatible with car groups.

begin;

-- Client contact data for partners is already exposed through the guarded
-- partner_get_bookings() RPC. The old direct profile policy was both redundant
-- and structurally wrong (it compared partner_id with auth.uid()). Removing it
-- also prevents public/profile policy evaluation from touching bookings.
drop policy if exists "Partner widzi swoich klientow" on public.profiles;

-- Management policies should not be evaluated for anonymous visitors.
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_locations'
      and policyname = 'Partner manages own locations'
  ) then
    alter policy "Partner manages own locations"
      on public.partner_locations
      to authenticated;
  end if;
end
$$;

-- Seasonal prices were previously writable by every authenticated account.
-- This helper and the replacement policies limit writes to the owning partner
-- (or an administrator), while keeping public read access for offer display.
create or replace function public.can_manage_car_class(p_car_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.car_classes cc
    join public.partners pa on pa.id = cc.partner_id
    where cc.id = p_car_class_id
      and (pa.user_id = auth.uid() or public.is_admin())
  );
$$;

revoke all on function public.can_manage_car_class(uuid) from public;
grant execute on function public.can_manage_car_class(uuid) to authenticated;

drop policy if exists "Partner insert seasonal prices" on public.seasonal_prices;
drop policy if exists "Partner update seasonal prices" on public.seasonal_prices;
drop policy if exists "Partner delete seasonal prices" on public.seasonal_prices;
drop policy if exists seasonal_prices_owner_insert on public.seasonal_prices;
drop policy if exists seasonal_prices_owner_update on public.seasonal_prices;
drop policy if exists seasonal_prices_owner_delete on public.seasonal_prices;

create policy seasonal_prices_owner_insert
  on public.seasonal_prices
  for insert
  to authenticated
  with check (public.can_manage_car_class(car_class_id));

create policy seasonal_prices_owner_update
  on public.seasonal_prices
  for update
  to authenticated
  using (public.can_manage_car_class(car_class_id))
  with check (public.can_manage_car_class(car_class_id));

create policy seasonal_prices_owner_delete
  on public.seasonal_prices
  for delete
  to authenticated
  using (public.can_manage_car_class(car_class_id));

-- Explicit anon grants existed on several authenticated-only RPCs. Their
-- internal checks already blocked anonymous actions, but the grants are removed
-- to make the database boundary match the application design.
revoke execute on function public.partner_accept_booking(uuid) from anon;
revoke execute on function public.partner_reject_booking(uuid) from anon;
revoke execute on function public.partner_expire_payment_bookings() from anon;
revoke execute on function public.client_cancel_booking(uuid, text, text) from anon;
revoke execute on function public.partner_get_bookings() from anon;
revoke execute on function public.partner_deactivate_account() from anon;
revoke execute on function public.partner_accept_agreement(text, text, text) from anon;

-- A car_class is a group/category, not a single physical vehicle. Multiple
-- requests for the same group and dates must therefore be possible.
alter table public.bookings
  drop constraint if exists no_overlapping_bookings;

-- Server-side price calculation now mirrors results.html:
-- pickup-month seasonal public price -> partner discount -> Ride24 margin.
create or replace function public.calculate_booking_price(
  car_id uuid,
  start_date date,
  end_date date
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  rental_days integer;
  pickup_month integer;
  regular_public_price numeric;
  seasonal_public_price numeric;
  effective_public_price numeric;
  partner_discount numeric;
  platform_margin numeric;
  partner_net_per_day numeric;
  base_total numeric;
  commission numeric;
  final_total numeric;
begin
  if car_id is null or start_date is null or end_date is null then
    raise exception 'INVALID_BOOKING_DATES';
  end if;

  rental_days := end_date - start_date;
  if rental_days < 1 then
    raise exception 'INVALID_BOOKING_DATES';
  end if;

  select
    cc.public_price,
    coalesce(cc.partner_discount_percent, 10),
    coalesce(cc.platform_margin_percent, 25)
  into
    regular_public_price,
    partner_discount,
    platform_margin
  from public.car_classes cc
  where cc.id = car_id
    and cc.active = true;

  if not found or regular_public_price is null or regular_public_price <= 0 then
    raise exception 'CAR_NOT_FOUND_OR_INACTIVE';
  end if;

  if partner_discount < 0 or partner_discount > 100
     or platform_margin < 0 or platform_margin > 100 then
    raise exception 'INVALID_PRICING_CONFIGURATION';
  end if;

  pickup_month := extract(month from start_date)::integer;

  select sp.public_price
  into seasonal_public_price
  from public.seasonal_prices sp
  where sp.car_class_id = car_id
    and sp.active = true
    and (
      (sp.start_month <= sp.end_month
       and pickup_month between sp.start_month and sp.end_month)
      or
      (sp.start_month > sp.end_month
       and (pickup_month >= sp.start_month or pickup_month <= sp.end_month))
    )
  order by sp.created_at desc, sp.id desc
  limit 1;

  effective_public_price := coalesce(seasonal_public_price, regular_public_price);
  if effective_public_price <= 0 then
    raise exception 'INVALID_PUBLIC_PRICE';
  end if;

  partner_net_per_day := effective_public_price * (1 - partner_discount / 100.0);
  base_total := round(partner_net_per_day * rental_days, 2);
  final_total := round(
    partner_net_per_day * (1 + platform_margin / 100.0) * rental_days,
    2
  );
  commission := round(final_total - base_total, 2);

  return json_build_object(
    'days', rental_days,
    'public_price_per_day', effective_public_price,
    'partner_discount_percent', partner_discount,
    'platform_margin_percent', platform_margin,
    'partner_net_per_day', round(partner_net_per_day, 2),
    'base_total', base_total,
    'commission', commission,
    'final_total', final_total,
    'seasonal_price_applied', seasonal_public_price is not null
  );
end;
$$;

revoke all on function public.calculate_booking_price(uuid, date, date) from public;
revoke all on function public.calculate_booking_price(uuid, date, date) from anon;
revoke all on function public.calculate_booking_price(uuid, date, date) from authenticated;
grant execute on function public.calculate_booking_price(uuid, date, date) to service_role;

-- The old BEFORE INSERT trigger always rewrote the split to 80/20, which only
-- happened to be correct for a 25% markup. Preserve the authoritative server
-- snapshots and validate that net + commission equals the final total.
create or replace function public.set_booking_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  margin_percent numeric;
begin
  if new.final_price_snapshot is null then
    return new;
  end if;

  if new.final_price_snapshot < 0 then
    raise exception 'INVALID_BOOKING_SNAPSHOT';
  end if;

  if new.partner_net_price_snapshot is null
     and new.commission_snapshot is null then
    margin_percent := coalesce(new.platform_margin_snapshot, 25);
    if margin_percent < 0 or margin_percent > 100 then
      raise exception 'INVALID_BOOKING_SNAPSHOT';
    end if;

    new.partner_net_price_snapshot := round(
      new.final_price_snapshot / (1 + margin_percent / 100.0),
      2
    );
    new.commission_snapshot := round(
      new.final_price_snapshot - new.partner_net_price_snapshot,
      2
    );
  elsif new.partner_net_price_snapshot is null then
    new.partner_net_price_snapshot := round(
      new.final_price_snapshot - new.commission_snapshot,
      2
    );
  elsif new.commission_snapshot is null then
    new.commission_snapshot := round(
      new.final_price_snapshot - new.partner_net_price_snapshot,
      2
    );
  end if;

  if new.partner_net_price_snapshot < 0
     or new.commission_snapshot < 0
     or abs(
       new.partner_net_price_snapshot
       + new.commission_snapshot
       - new.final_price_snapshot
     ) > 0.05 then
    raise exception 'INVALID_BOOKING_SNAPSHOT';
  end if;

  return new;
end;
$$;

-- Queue all status e-mails with an explicit recipient. The Edge worker is
-- triggered by the normal application actions and processes only that booking.
create or replace function public.booking_email_queue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  client_email text;
  partner_email text;
  partner_type text;
begin
  select coalesce(p.email, new.client_email)
    into client_email
    from public.profiles p
   where p.id = new.client_id;

  client_email := coalesce(client_email, new.client_email);

  select
    coalesce(pa.email, p.email),
    coalesce(pa.provider_type, 'local')
    into partner_email, partner_type
    from public.partners pa
    left join public.profiles p on p.id = pa.user_id
   where pa.id = new.partner_id;

  if new.status = 'pending' and partner_type = 'local' then
    insert into public.email_logs(booking_id, email, type, status)
    values(new.id, partner_email, 'partner_new_request', 'queued')
    on conflict (booking_id, type)
    where booking_id is not null and type is not null
    do update set email = excluded.email, status = 'queued';

  elsif new.status = 'awaiting_payment' then
    insert into public.email_logs(booking_id, email, type, status)
    values(new.id, client_email, 'client_payment_required', 'queued')
    on conflict (booking_id, type)
    where booking_id is not null and type is not null
    do update set email = excluded.email, status = 'queued';

  elsif new.status = 'rejected' then
    insert into public.email_logs(booking_id, email, type, status)
    values(new.id, client_email, 'client_booking_rejected', 'queued')
    on conflict (booking_id, type)
    where booking_id is not null and type is not null
    do update set email = excluded.email, status = 'queued';

  elsif new.status = 'paid' then
    insert into public.email_logs(booking_id, email, type, status)
    values(new.id, client_email, 'booking_confirmation', 'queued')
    on conflict (booking_id, type)
    where booking_id is not null and type is not null
    do update set email = excluded.email, status = 'queued';

    if partner_type = 'local' then
      insert into public.email_logs(booking_id, email, type, status)
      values(new.id, partner_email, 'partner_booking_confirmed', 'queued')
      on conflict (booking_id, type)
      where booking_id is not null and type is not null
      do update set email = excluded.email, status = 'queued';
    end if;
  end if;

  return new;
end;
$$;

commit;
