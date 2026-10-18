-- RUN MANUALLY ONLY AFTER migration + the booking-options and create-booking-request
-- Edge Functions are deployed and both WEB and Android v2 quotes have been verified.
-- Do not include in the initial schema migration: old clients must not pay unseen charges.
begin;
-- Match exactly one real LOCAL Portugal partner and its existing 50 EUR item.
do $$
declare
    partner_row uuid;
    current_extra uuid;
begin
    select p.id into strict partner_row from public.partners p
      where p.company_name='Mountain Calendar Unip Lda'
        and p.country='Portugal' and p.provider_type='local' and p.active=true;

    select e.id into strict current_extra from public.partner_extras e
      where e.partner_id=partner_row and e.code='custom'
        and e.name_en='Out-of-hours pickup 22:00–07:00 (charge per booking)'
        and e.amount=50 and e.billing='rental' and e.active=true;

    if not exists(select 1 from public.partner_time_fees f where f.partner_id=partner_row
       and f.location_id is null and f.applies_to='pickup'
       and f.starts_at='22:00:00' and f.ends_at='07:00:00'
       and f.amount=50 and f.active=true)
    then
      insert into public.partner_time_fees
        (partner_id,location_id,applies_to,starts_at,ends_at,amount,once_per_booking,active)
      values (partner_row,null,'pickup','22:00','07:00',50,true,true);
    end if;

    -- Disable the obsolete optional item only when the obligatory fee exists.
    if exists(select 1 from public.partner_time_fees f where f.partner_id=partner_row
       and f.location_id is null and f.applies_to='pickup'
       and f.starts_at='22:00' and f.ends_at='07:00'
       and f.amount=50 and f.active=true)
    then
       update public.partner_extras set active=false where id=current_extra;
    end if;
end;
$$;
commit;
