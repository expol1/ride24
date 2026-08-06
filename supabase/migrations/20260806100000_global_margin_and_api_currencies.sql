-- Ride24: global margin for all partners and operational currencies for API partners.
-- Additive migration. Existing bookings, payments and vouchers are not recalculated.

begin;

create table if not exists public.ride24_pricing_settings (
  id smallint primary key default 1 check (id = 1),
  global_margin_percent numeric(6,2) not null default 25
    check (global_margin_percent > 0 and global_margin_percent <= 100),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.ride24_pricing_settings (id, global_margin_percent)
values (1, 25)
on conflict (id) do nothing;

alter table public.ride24_pricing_settings enable row level security;
revoke all on table public.ride24_pricing_settings from public, anon, authenticated;
grant all on table public.ride24_pricing_settings to service_role;

create or replace function public.get_global_platform_margin()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select global_margin_percent from public.ride24_pricing_settings where id = 1),
    25::numeric
  );
$$;

revoke all on function public.get_global_platform_margin() from public;
grant execute on function public.get_global_platform_margin() to anon, authenticated, service_role;

-- Accept ISO-style three-letter currency codes. TRL is normalized to current TRY.
update public.partners
set currency = case
  when upper(trim(currency)) = 'TRL' then 'TRY'
  else upper(trim(currency))
end
where currency is not null;

alter table public.partners drop constraint if exists partners_currency_check;
alter table public.partners
  add constraint partners_currency_check
  check (currency is null or currency ~ '^[A-Z]{3}$');

update public.providers_config
set currency = case
  when upper(trim(currency)) = 'TRL' then 'TRY'
  else upper(trim(currency))
end
where currency is not null;

alter table public.providers_config drop constraint if exists providers_config_currency_check;
alter table public.providers_config
  add constraint providers_config_currency_check
  check (currency is null or currency ~ '^[A-Z]{3}$');

-- Every car class receives the current partner discount and the single global margin.
create or replace function public.calculate_car_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  partner_discount numeric;
  global_margin numeric;
begin
  if new.public_price is null or new.public_price <= 0 then
    raise exception 'Public price must be greater than 0';
  end if;

  if tg_op = 'INSERT' then
    select discount_percent
    into partner_discount
    from public.partners
    where id = new.partner_id;

    if not found then
      raise exception 'Partner o ID % nie istnieje', new.partner_id;
    end if;

    new.partner_discount_percent := coalesce(partner_discount, 15);
  else
    -- Zmiana globalnej marży nie może zmieniać dotychczasowego rabatu klasy.
    new.partner_discount_percent := coalesce(old.partner_discount_percent, 10);
  end if;

  global_margin := public.get_global_platform_margin();
  new.platform_margin_percent := coalesce(global_margin, 25);

  if new.partner_discount_percent < 0 or new.partner_discount_percent > 100
     or new.platform_margin_percent <= 0 or new.platform_margin_percent > 100 then
    raise exception 'INVALID_PRICING_CONFIGURATION';
  end if;

  new.partner_net_price := round(
    (new.public_price * (1 - new.partner_discount_percent / 100.0))::numeric,
    2
  );
  new.final_customer_price := round(
    (new.partner_net_price * (1 + new.platform_margin_percent / 100.0))::numeric,
    2
  );

  return new;
end;
$$;

revoke all on function public.calculate_car_price() from public;

-- Local bookings use the global margin at calculation time. API bookings use
-- the margin snapshot already stored in api_quotes by search-api.
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

  select cc.public_price, coalesce(cc.partner_discount_percent, 10)
  into regular_public_price, partner_discount
  from public.car_classes cc
  where cc.id = car_id
    and cc.active = true;

  if not found or regular_public_price is null or regular_public_price <= 0 then
    raise exception 'CAR_NOT_FOUND_OR_INACTIVE';
  end if;

  platform_margin := public.get_global_platform_margin();
  if partner_discount < 0 or partner_discount > 100
     or platform_margin <= 0 or platform_margin > 100 then
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

revoke all on function public.calculate_booking_price(uuid, date, date) from public, anon, authenticated;
grant execute on function public.calculate_booking_price(uuid, date, date) to service_role;

create or replace function public.admin_set_global_platform_margin(p_margin numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_margin numeric(6,2);
  updated_classes integer := 0;
  expired_quotes integer := 0;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if p_margin is null or p_margin <= 0 or p_margin > 100 then
    raise exception 'INVALID_GLOBAL_MARGIN';
  end if;

  normalized_margin := round(p_margin, 2);

  insert into public.ride24_pricing_settings (
    id, global_margin_percent, updated_at, updated_by
  )
  values (1, normalized_margin, now(), auth.uid())
  on conflict (id) do update set
    global_margin_percent = excluded.global_margin_percent,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;

  update public.car_classes
  set platform_margin_percent = normalized_margin
  where platform_margin_percent is distinct from normalized_margin;
  get diagnostics updated_classes = row_count;

  update public.api_quotes
  set expires_at = now()
  where used_at is null
    and booking_id is null
    and expires_at > now();
  get diagnostics expired_quotes = row_count;

  return jsonb_build_object(
    'success', true,
    'global_margin_percent', normalized_margin,
    'updated_car_classes', updated_classes,
    'expired_api_quotes', expired_quotes
  );
end;
$$;

revoke all on function public.admin_set_global_platform_margin(numeric) from public, anon;
grant execute on function public.admin_set_global_platform_margin(numeric) to authenticated, service_role;

-- Refresh stored display prices without touching booking snapshots.
update public.car_classes
set platform_margin_percent = public.get_global_platform_margin()
where platform_margin_percent is distinct from public.get_global_platform_margin();

commit;
