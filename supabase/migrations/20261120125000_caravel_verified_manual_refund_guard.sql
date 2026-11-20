-- Manual bank-transfer refund reconciliation ONLY: Caravel verified cancellation.
-- Does not call Stripe, transfer funds, clear manual_review, or alter customer refund percentages.
-- All other API and local partner behavior is unchanged.
CREATE OR REPLACE FUNCTION public.admin_mark_refund_done(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- Only Caravel: a later webhook/payment diagnostic can leave
    -- manual_review=true after the supplier has confirmed cancellation.
    -- Keep that diagnostic flag and all review queue entries intact;
    -- allow manual bank-transfer bookkeeping only with independent,
    -- reference-matched supplier cancellation evidence.
    if b.partner_id = '78721481-7619-44df-a9b7-5faa344b69bb'::uuid then
      if b.api_booking_reference is null
        or b.api_status is distinct from 'cancelled'
        or b.api_response->>'status' is distinct from 'cancelled'
        or not (
          b.api_response->>'reference' = b.api_booking_reference or
          b.api_response->>'booking_reference' = b.api_booking_reference
        )
        or not exists (
          select 1 from public.api_booking_logs l
          where l.booking_id = b.id and l.provider = 'caravel'
            and l.action = 'cancel' and l.status = 'cancelled'
            and l.response_payload->>'status' = 'cancelled'
            and (
              l.response_payload->>'reference' = b.api_booking_reference or
              l.response_payload->>'booking_reference' = b.api_booking_reference
            )
        )
      then
        raise exception 'API_CANCELLATION_NOT_VERIFIED';
      end if;
      if b.refund_amount_pln is null or b.refund_amount_pln <= 0
        or b.online_payment_pln is null
        or b.refund_amount_pln > b.online_payment_pln then
        raise exception 'REFUND_AMOUNT_INVALID';
      end if;
      if not exists (
        select 1 from public.payments pay
        where pay.booking_id = b.id and pay.status = 'paid'
      ) or not exists (
        select 1 from public.api_booking_workflows w
        where w.booking_id = b.id and w.paid_at is not null
      ) then
        raise exception 'API_PAYMENT_NOT_VERIFIED';
      end if;
      if exists (
        select 1 from public.api_booking_workflows w
        where w.booking_id = b.id and
          (w.refund_id is not null or w.refund_started_at is not null or
           w.refund_status in ('pending','processing','succeeded','completed'))
      ) then
        raise exception 'API_REFUND_ALREADY_IN_PROGRESS';
      end if;
    else
      -- Preserve existing strict guard for AVIA, Arvent and all other API partners.
      if b.manual_review is true
        or (b.api_booking_reference is not null and b.api_status is distinct from 'cancelled') then
        raise exception 'API_CANCELLATION_NOT_VERIFIED';
      end if;
    end if;
  end if;
  update public.bookings
     set refund_status='completed', refund_completed_at=now()
   where id=p_id;
end;
$function$

