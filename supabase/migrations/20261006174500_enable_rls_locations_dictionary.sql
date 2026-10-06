-- Ride24 security hardening: enable RLS for the public locations dictionary.
-- Existing policies already allow SELECT for anon and authenticated users.
-- No write policies are added, so public INSERT/UPDATE/DELETE become blocked.

alter table public.locations_dictionary enable row level security;
