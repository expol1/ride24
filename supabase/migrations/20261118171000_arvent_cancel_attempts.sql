-- Single durable attempt, shared by the client endpoint and scheduled worker.
create table public.arvent_cancel_attempts (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
alter table public.arvent_cancel_attempts enable row level security;
revoke all on public.arvent_cancel_attempts from public, anon, authenticated;
grant select, insert on public.arvent_cancel_attempts to service_role;
