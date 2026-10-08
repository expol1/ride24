-- Production RPC definitions read on 2026-10-08. Synthetic isolated fixtures only.
CREATE OR REPLACE FUNCTION public.partner_accept_booking(p_booking_id uuid)
 RETURNS TABLE(booking_id uuid, status booking_status, payment_deadline timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deadline timestamptz := now() + interval '24 hours';
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;

  return query
  update public.bookings b
     set status = 'awaiting_payment',
         payment_deadline = v_deadline,
         expires_at = v_deadline
   where b.id = p_booking_id
     and b.status = 'pending'
     and (b.partner_response_deadline is null or b.partner_response_deadline >= now())
     and exists (
       select 1 from public.partners p
       where p.id = b.partner_id and p.user_id = auth.uid() and p.provider_type = 'local'
     )
  returning b.id, b.status, b.payment_deadline;

  if not found then raise exception 'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED'; end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.partner_app_get_bookings()
 RETURNS TABLE(id uuid, reservation_code text, status booking_status, start_date date, end_date date, pickup_time time without time zone, return_time time without time zone, pickup_location text, return_location text, partner_response_deadline timestamp with time zone, payment_deadline timestamp with time zone, partner_currency text, partner_amount numeric, class_code text, car_description text, main_driver_name text, main_driver_age bigint, additional_driver_name text, additional_driver_age bigint, client_phone text, client_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if auth.uid() is null then
        raise exception 'AUTH_REQUIRED';
    end if;

    if not exists (
        select 1
        from public.partners p
        where p.user_id = auth.uid()
          and coalesce(p.provider_type, 'local') = 'local'
    ) then
        raise exception 'PARTNER_NOT_FOUND_OR_NOT_LOCAL';
    end if;

    return query
    select
        b.id,
        coalesce(b.reservation_code::text, '') as reservation_code,
        b.status,
        b.start_date,
        b.end_date,
        b.pickup_time,
        b.return_time,
        b.pickup_location,
        b.return_location,
        b.partner_response_deadline,
        b.payment_deadline,
        b.partner_currency,
        coalesce(b.pickup_payment_partner_currency, b.partner_net_price_snapshot) as partner_amount,
        cc.class_code,
        cc.description as car_description,
        b.main_driver_name,
        b.main_driver_age,
        b.add_driver_name as additional_driver_name,
        b.add_driver_age as additional_driver_age,
        case when b.status = 'paid' then b.client_phone else null end as client_phone,
        case when b.status = 'paid' then b.client_email else null end as client_email
    from public.bookings b
    join public.partners p on p.id = b.partner_id
    left join public.car_classes cc on cc.id = b.car_class_id
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') = 'local'
    order by b.created_at desc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.partner_reject_booking(p_booking_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  update public.bookings b
     set status = 'rejected'
   where b.id = p_booking_id
     and b.status = 'pending'
     and (b.partner_response_deadline is null or b.partner_response_deadline >= now())
     and exists (select 1 from public.partners p where p.id = b.partner_id and p.user_id = auth.uid() and p.provider_type = 'local')
  returning b.id into v_id;
  if v_id is null then raise exception 'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED'; end if;
  return v_id;
end;
$function$;

