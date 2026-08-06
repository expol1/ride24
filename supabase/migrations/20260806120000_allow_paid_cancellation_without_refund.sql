-- Ride24 LIVE
-- Allow a paid booking to be cancelled without a refund when fewer than
-- 30 days remain before pickup. Existing 50% and 90% refund rules stay unchanged.

create or replace function public.client_cancel_booking(
  p_booking_id uuid,
  p_refund_account text default null::text,
  p_refund_reason text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  b public.bookings%rowtype;
  v_percent integer := 0;
  v_amount numeric := 0;
  v_days integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
    into b
    from public.bookings
   where id = p_booking_id
     and client_id = auth.uid()
   for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND_OR_ACCESS_DENIED';
  end if;

  if b.status = 'pending' then
    delete from public.email_logs where booking_id = b.id;
    delete from public.booking_logs where booking_id = b.id;
    delete from public.bookings where id = b.id;

    return jsonb_build_object(
      'status', 'deleted',
      'refund_percent', 0,
      'refund_amount', 0
    );
  end if;

  if b.status in ('accepted', 'awaiting_payment') then
    update public.bookings
       set status = 'cancelled',
           cancelled_at = now()
     where id = b.id;

    update public.vouchers
       set status = 'cancelled'
     where booking_id = b.id;

    return jsonb_build_object(
      'status', 'cancelled',
      'refund_percent', 0,
      'refund_amount', 0
    );
  end if;

  if b.status = 'paid' then
    if b.cancelled_at is not null or b.refund_status is not null then
      raise exception 'ALREADY_CANCELLED';
    end if;

    v_days := b.start_date - current_date;

    if v_days < 0 then
      raise exception 'BOOKING_CANNOT_BE_CANCELLED';
    end if;

    if v_days >= 60 then
      v_percent := 90;
    elsif v_days >= 30 then
      v_percent := 50;
    else
      update public.bookings
         set status = 'cancelled',
             cancelled_at = now(),
             refund_percentage = 0,
             refund_amount_pln = 0,
             refund_status = null,
             refund_account = null,
             refund_reason = left(
               coalesce(
                 nullif(trim(p_refund_reason), ''),
                 'Anulowanie przez klienta bez zwrotu'
               ),
               1000
             )
       where id = b.id;

      update public.vouchers
         set status = 'cancelled'
       where booking_id = b.id;

      return jsonb_build_object(
        'status', 'cancelled',
        'refund_percent', 0,
        'refund_amount', 0
      );
    end if;

    if coalesce(trim(p_refund_account), '') = '' then
      raise exception 'REFUND_ACCOUNT_REQUIRED';
    end if;

    v_amount := round(
      coalesce(b.online_payment_pln, 0) * v_percent / 100.0,
      2
    );

    update public.bookings
       set status = 'cancelled',
           cancelled_at = now(),
           refund_percentage = v_percent,
           refund_amount_pln = v_amount,
           refund_status = 'pending',
           refund_account = left(trim(p_refund_account), 500),
           refund_reason = left(
             coalesce(
               nullif(trim(p_refund_reason), ''),
               'Brak powodu'
             ),
             1000
           )
     where id = b.id;

    update public.vouchers
       set status = 'cancelled'
     where booking_id = b.id;

    if not exists (
      select 1
        from public.transactions
       where booking_id = b.id
         and type = 'refund_pending'
    ) then
      insert into public.transactions(
        booking_id,
        type,
        amount,
        client_id
      )
      values (
        b.id,
        'refund_pending',
        v_amount,
        auth.uid()
      );
    end if;

    return jsonb_build_object(
      'status', 'cancelled',
      'refund_percent', v_percent,
      'refund_amount', v_amount
    );
  end if;

  raise exception 'BOOKING_CANNOT_BE_CANCELLED';
end;
$function$;

revoke execute on function public.client_cancel_booking(uuid, text, text)
  from public, anon;

grant execute on function public.client_cancel_booking(uuid, text, text)
  to authenticated;
