-- Additive, opt-in minimum driving-licence tenure for LOCAL partners.
-- NULL / 0 = no additional requirement. Existing partners retain their behaviour.
-- API partner flows are unchanged. No backfill, RLS, triggers or payment changes.
alter table public.partners
  add column if not exists min_license_years integer;

alter table public.bookings
  add column if not exists additional_driver_license_since date;

alter table public.bookings
  add column if not exists min_license_years_snapshot integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.partners'::regclass
      and conname = 'partners_min_license_years_check'
  ) then
    alter table public.partners
      add constraint partners_min_license_years_check
      check (min_license_years is null or min_license_years between 0 and 50);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_min_license_years_snapshot_check'
  ) then
    alter table public.bookings
      add constraint bookings_min_license_years_snapshot_check
      check (min_license_years_snapshot is null or min_license_years_snapshot between 1 and 50);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_additional_driver_license_since_check'
  ) then
    alter table public.bookings
      add constraint bookings_additional_driver_license_since_check
      check (additional_driver_license_since is null
             or additional_driver_license_since >= date '1900-01-01');
  end if;
end $$;

comment on column public.partners.min_license_years is
  'Local partner only: minimum completed years since first driving licence, measured at pickup. NULL/0 disables the restriction.';
comment on column public.bookings.additional_driver_license_since is
  'Original first driving licence date of the additional driver at booking time, local rentals only.';
comment on column public.bookings.min_license_years_snapshot is
  'Local partner licence tenure rule applied when the booking was created.';
