-- The company-wide minimum is independent from vehicle duration discounts.
-- Existing companies retain the current one-day behavior.
alter table public.partners
  add column if not exists min_rental_days integer not null default 1;

alter table public.partners
  add constraint partners_min_rental_days_range
  check (min_rental_days between 1 and 366);

comment on column public.partners.min_rental_days is
  'Minimum calendar rental days required for all company locations (1..366).';
