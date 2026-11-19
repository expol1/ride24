-- Original first issue of the main driver's licence (not replacement card).
-- Optional for all existing providers; mandatory only for Arvent in
-- create-booking-request and rechecked against the live supplier tariff.
-- No backfill and no public access policy changes.
alter table public.bookings
  add column if not exists main_driver_license_since date;
