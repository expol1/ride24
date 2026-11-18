-- API cancellation settlement safeguard. The customer cancellation schedule (90/50/0)
-- and manual bank-transfer refund process are unchanged.
-- Requires an explicit supplier cancellation before the admin marks an API manual refund done.
create or replace function public.admin_mark_refund_done(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype;
begin
  if not exists (
    select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'
  ) then
    raise exception 'Brak dostępu';
  end if;
  select * into b from public.bookings where id=p_id for update;
  if not found then
    raise exception 'REFUND_BOOKING_NOT_FOUND';
  end if;
  -- Preserve the historical admin operation for LOCAL partners exactly.
  -- A local manual payout may be reconciled without API-specific statuses.
  if b.provider_type='api' then
    if b.status::text is distinct from 'cancelled' or b.refund_status is distinct from 'pending' then
      raise exception 'REFUND_NOT_PENDING';
    end if;
    if b.manual_review is true
      or (b.api_booking_reference is not null and b.api_status is distinct from 'cancelled') then
      raise exception 'API_CANCELLATION_NOT_VERIFIED';
    end if;
  end if;
  update public.bookings
     set refund_status='completed', refund_completed_at=now()
   where id=p_id;
end;
$$;
