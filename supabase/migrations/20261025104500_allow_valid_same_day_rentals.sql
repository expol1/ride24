-- Permit same-day rentals only when return time is after pickup time.
-- Existing reservations, balances, and partner settings are untouched.
alter table public.bookings drop constraint if exists bookings_check;
alter table public.bookings drop constraint if exists valid_dates;
alter table public.bookings add constraint valid_dates check (
  end_date > start_date
  or (
    end_date = start_date
    and coalesce(return_time, time '10:00') > coalesce(pickup_time, time '10:00')
  )
);

-- Quotes are inserted by the authenticated API search service after it
-- validates both full timestamps. They store dates; times remain in quote context.
alter table public.api_quotes drop constraint if exists api_quotes_valid_dates;
alter table public.api_quotes add constraint api_quotes_valid_dates check (end_date >= start_date);
