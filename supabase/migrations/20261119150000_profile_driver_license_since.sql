-- Optional original driving-licence date saved by the client for the profile
-- owner and for each saved driver. Lets every client (WWW and Android builds
-- that do not send the booking field) reuse it for suppliers that require
-- licence tenure (Arvent). Nullable; no backfill; existing RLS unchanged.
alter table public.profiles
  add column if not exists license_since date
  check (license_since is null or license_since >= date '1900-01-01');
alter table public.drivers
  add column if not exists license_since date
  check (license_since is null or license_since >= date '1900-01-01');
