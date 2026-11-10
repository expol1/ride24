-- Additive, optional settings: existing partners, cars and fees keep their defaults.
alter table public.partners add column if not exists max_driver_age integer;
alter table public.car_classes add column if not exists min_driver_age integer;
alter table public.partner_locations add column if not exists free_from_rental_days integer;
alter table public.partners add constraint partners_max_driver_age_range
  check (max_driver_age is null or (max_driver_age between 18 and 120 and max_driver_age >= coalesce(min_driver_age,21)));
alter table public.car_classes add constraint car_classes_min_driver_age_range
  check (min_driver_age is null or min_driver_age between 18 and 120);
alter table public.partner_locations add constraint partner_locations_free_days_range
  check (free_from_rental_days is null or free_from_rental_days between 1 and 366);
comment on column public.car_classes.min_driver_age is 'Optional vehicle minimum; null inherits partners.min_driver_age (legacy fallback 21).';
comment on column public.partners.max_driver_age is 'Inclusive company-wide driver age maximum; null means no upper limit.';
comment on column public.partner_locations.free_from_rental_days is 'Standard pickup and return fees waived from this many billed rental days; null keeps fees. Does not waive time/conditional fees.';
