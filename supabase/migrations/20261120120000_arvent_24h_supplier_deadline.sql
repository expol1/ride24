-- Arvent: 24h approval window counted from the moment Arvent's API accepted
-- the paid reservation (status 0 received). Persisted, server-side.
alter table public.api_booking_workflows
  add column if not exists supplier_received_at timestamptz,
  add column if not exists supplier_deadline_at timestamptz;

-- Client-readable copy for the countdown. Deliberately NOT
-- partner_response_deadline: auto_expire_bookings() expires pending bookings
-- whose partner_response_deadline passed, which would race the supplier
-- confirmation/cancellation of a paid Arvent booking.
alter table public.bookings
  add column if not exists supplier_confirmation_deadline timestamptz;

-- Server clock for client countdowns (never the phone's clock).
create or replace function public.ride24_server_now()
returns timestamptz language sql stable security invoker set search_path = public
as $$ select now() $$;
grant execute on function public.ride24_server_now() to anon, authenticated;
