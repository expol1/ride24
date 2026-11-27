-- Per-booking hold on automated API refunds. Used when a supplier state
-- contradicts other evidence (e.g. Arvent cancelled a reservation minutes
-- after emailing its confirmation PDF) and a human must decide before an
-- irreversible Stripe refund. Rows without a hold are unaffected, so the
-- automatic refund path for every partner behaves exactly as before.
create table if not exists public.api_refund_holds (
  booking_id uuid primary key references public.bookings(id),
  reason text not null check (char_length(reason) between 10 and 1000),
  created_by text not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by text
);
alter table public.api_refund_holds enable row level security;
revoke all on public.api_refund_holds from anon, authenticated;
drop policy if exists api_refund_holds_admin_read on public.api_refund_holds;
create policy api_refund_holds_admin_read on public.api_refund_holds
  for select to authenticated using (public.is_admin());
grant select on public.api_refund_holds to authenticated;

create or replace function public.api_refund_hold_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.state in ('refunding','refunded') and old.state is distinct from new.state
     and exists (select 1 from public.api_refund_holds h
                 where h.booking_id = new.booking_id and h.released_at is null) then
    raise exception 'API_REFUND_ON_HOLD' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.api_refund_hold_guard() from public, anon, authenticated;

drop trigger if exists api_refund_hold_guard on public.api_booking_workflows;
create trigger api_refund_hold_guard
  before update of state on public.api_booking_workflows
  for each row execute function public.api_refund_hold_guard();
