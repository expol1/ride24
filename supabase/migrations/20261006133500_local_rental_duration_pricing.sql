-- Ride24 LOCAL rental-duration pricing
-- Backward compatible: if a car has no active duration tier, pricing remains unchanged.

create table if not exists public.rental_duration_discounts (
  id uuid primary key default gen_random_uuid(),
  car_class_id uuid not null references public.car_classes(id) on delete cascade,
  min_days integer not null,
  max_days integer null,
  discount_percent numeric(5,2) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint rental_duration_discounts_min_days_check check (min_days >= 1),
  constraint rental_duration_discounts_max_days_check check (max_days is null or max_days >= min_days),
  constraint rental_duration_discounts_discount_check check (discount_percent >= 0 and discount_percent <= 80)
);

create index if not exists rental_duration_discounts_car_class_idx
  on public.rental_duration_discounts(car_class_id, active, min_days, max_days);

alter table public.rental_duration_discounts enable row level security;

drop policy if exists rental_duration_discounts_public_read on public.rental_duration_discounts;
create policy rental_duration_discounts_public_read
  on public.rental_duration_discounts
  for select
  to public
  using (active = true);

drop policy if exists rental_duration_discounts_owner_insert on public.rental_duration_discounts;
create policy rental_duration_discounts_owner_insert
  on public.rental_duration_discounts
  for insert
  to authenticated
  with check (public.can_manage_car_class(car_class_id));

drop policy if exists rental_duration_discounts_owner_update on public.rental_duration_discounts;
create policy rental_duration_discounts_owner_update
  on public.rental_duration_discounts
  for update
  to authenticated
  using (public.can_manage_car_class(car_class_id))
  with check (public.can_manage_car_class(car_class_id));

drop policy if exists rental_duration_discounts_owner_delete on public.rental_duration_discounts;
create policy rental_duration_discounts_owner_delete
  on public.rental_duration_discounts
  for delete
  to authenticated
  using (public.can_manage_car_class(car_class_id));

create or replace function public.validate_rental_duration_discount_overlap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.active is not true then
    return new;
  end if;

  if exists (
    select 1
    from public.rental_duration_discounts rdd
    where rdd.car_class_id = new.car_class_id
      and rdd.active = true
      and rdd.id <> new.id
      and int4range(rdd.min_days, coalesce(rdd.max_days, 2147483646) + 1, '[)')
          && int4range(new.min_days, coalesce(new.max_days, 2147483646) + 1, '[)')
  ) then
    raise exception 'DURATION_RANGE_OVERLAP';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_rental_duration_discount_overlap
  on public.rental_duration_discounts;

create trigger trg_validate_rental_duration_discount_overlap
before insert or update of car_class_id, min_days, max_days, active
on public.rental_duration_discounts
for each row
execute function public.validate_rental_duration_discount_overlap();

-- Server-side booking pricing mirrors Results:
-- base/seasonal price -> duration discount -> partner discount -> Ride24 margin.
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
  source_public_price numeric;
  duration_discount numeric := 0;
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

  source_public_price := coalesce(seasonal_public_price, regular_public_price);
  if source_public_price <= 0 then
    raise exception 'INVALID_PUBLIC_PRICE';
  end if;

  select coalesce(rdd.discount_percent, 0)
  into duration_discount
  from public.rental_duration_discounts rdd
  where rdd.car_class_id = car_id
    and rdd.active = true
    and rental_days >= rdd.min_days
    and (rdd.max_days is null or rental_days <= rdd.max_days)
  order by rdd.min_days desc, rdd.created_at desc, rdd.id desc
  limit 1;

  duration_discount := coalesce(duration_discount, 0);
  if duration_discount < 0 or duration_discount > 80 then
    raise exception 'INVALID_DURATION_DISCOUNT';
  end if;

  effective_public_price := round(source_public_price * (1 - duration_discount / 100.0), 2);
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
    'source_public_price_per_day', source_public_price,
    'public_price_per_day', effective_public_price,
    'duration_discount_percent', duration_discount,
    'duration_discount_applied', duration_discount > 0,
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

grant select on public.rental_duration_discounts to anon, authenticated;
grant insert, update, delete on public.rental_duration_discounts to authenticated;
