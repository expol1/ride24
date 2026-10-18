-- Mandatory surcharges audit and cutover, 2026-10-18.
-- RUN ONLY AFTER DEPLOYING BOTH QUOTE + BOOKING EDGE FUNCTIONS AND WEB UI.
-- Do not alter the Montenegro/other existing location fees.
-- Existing extras are deactivated, never deleted; all original rows are preserved in audit.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$
declare r record;
declare v_partner_id uuid;
declare loc_id uuid;
declare original public.partner_extras%rowtype;
declare rule_id uuid;
begin
  -- Time fees backed by existing partner-owned price rows.
  for r in select * from (values
    ('Mountain Calendar Unip Lda','1dccbbd5-d395-400c-8310-86d115a94a4b'::uuid,'pickup','22:00'::time,'07:00'::time,null::text,50.00::numeric,true,false),
    ('Auto Ilhéu Rent a Car','ebe7c7dd-5511-4007-9987-e013bd542875'::uuid,'pickup','19:45'::time,'23:45'::time,'Ponta Delgada Airport (PDL)',15.00::numeric,true,false),
    ('Auto Ilhéu Rent a Car','cdcb8c7f-4bcc-4c18-9ab2-cc3f62af1d17'::uuid,'return','05:00'::time,'07:00'::time,'Ponta Delgada Airport (PDL)',25.00::numeric,true,false),
    ('Cosmo Rent SRLS','f21dacb8-e686-4b1c-8bbd-89b459a4ff05'::uuid,'pickup','00:01'::time,'08:00'::time,null::text,50.00::numeric,true,false),
    ('Laima''s Car Hire','a4fb1ad2-e79a-4908-abeb-d2347fed157b'::uuid,'either','20:00'::time,'06:00'::time,null::text,25.00::numeric,true,false),
    ('STAR RENTACAR BULGARIA','26561d9f-9696-41b4-a921-faa74b25eacf'::uuid,'either','19:40'::time,'08:30'::time,null::text,20.00::numeric,false,true)
  ) as x(company,source_id,applies,from_time,to_time,point,charge,once_booking,needs_approval)
  loop
    select p.id into strict v_partner_id from public.partners p
      where p.company_name=r.company and p.active=true and p.account_status='active' and p.provider_type='local';
    select * into strict original from public.partner_extras e where e.id=r.source_id
      and e.partner_id=v_partner_id and e.active=true and e.code='custom' and e.billing='rental' and e.amount=r.charge;
    loc_id:=null;
    if r.point is not null then
      select l.id into strict loc_id from public.partner_locations l
      where l.partner_id=v_partner_id and l.location_name=r.point and l.active=true and coalesce(l.is_api_managed,false)=false;
    end if;
    insert into public.partner_time_fees (partner_id,location_id,applies_to,starts_at,ends_at,amount,once_per_booking,requires_approval,active)
    values(v_partner_id,loc_id,r.applies,r.from_time,r.to_time,r.charge,r.once_booking,r.needs_approval,true) returning id into rule_id;
    insert into public.partner_fee_migration_audit(source_extra_id,original_extra,target_type)
      values(original.id,to_jsonb(original),'time');
    update public.partner_extras set active=false where id=original.id and active=true;
    if not found then raise exception 'Failed to deactivate original extra %', original.id; end if;
  end loop;

  -- Bulgarian original items describe the same 20 EUR per-event charge across
  -- two adjoining windows. The merged 19:40–08:30 rule avoids double billing at midnight.
  select p.id into strict v_partner_id from public.partners p where p.company_name='STAR RENTACAR BULGARIA' and p.active=true;
  select * into strict original from public.partner_extras where id='1719f985-d243-4803-864f-e33330aaa230'::uuid
      and partner_id=v_partner_id and active=true and code='custom' and billing='rental' and amount=20;
  insert into public.partner_fee_migration_audit(source_extra_id,original_extra,target_type)
    values(original.id,to_jsonb(original),'time');
  update public.partner_extras set active=false where id=original.id;

  for r in select * from (values
    ('Mountain Calendar Unip Lda','a7360444-7b28-4ae0-b2a8-ae6043e3e46f'::uuid,'location_either','Madeira Airport (FNC)'::text,null::text[],15.00::numeric,
      'Transfer lotnisko Madera','Madeira Airport transfer'),
    ('Mountain Calendar Unip Lda','d43c2555-0ce9-48b2-98bf-df3df29fca8a'::uuid,'cross_city',null::text,array['Lisbon','Porto','Faro']::text[],120.00::numeric,
      'Zwrot w innym mieście kontynentalnym (Lizbona / Porto / Faro)','One-way return between mainland cities (Lisbon / Porto / Faro)')
  ) as x(company,source_id,kind,point,cities,charge,pl,en)
  loop
    select p.id into strict v_partner_id from public.partners p
      where p.company_name=r.company and p.active=true and p.account_status='active' and p.provider_type='local';
    select * into strict original from public.partner_extras e where e.id=r.source_id
      and e.partner_id=v_partner_id and e.active=true and e.code='custom' and e.billing='rental' and e.amount=r.charge;
    loc_id:=null;
    if r.point is not null then
      select l.id into strict loc_id from public.partner_locations l
        where l.partner_id=v_partner_id and l.location_name=r.point and l.active=true and coalesce(l.is_api_managed,false)=false;
    end if;
    insert into public.partner_conditional_fees
      (partner_id,kind,location_id,city_scope,name_pl,name_en,amount,active)
    values(v_partner_id,r.kind,loc_id,r.cities,r.pl,r.en,r.charge,true);
    insert into public.partner_fee_migration_audit(source_extra_id,original_extra,target_type)
      values(original.id,to_jsonb(original),'conditional');
    update public.partner_extras set active=false where id=original.id and active=true;
  end loop;

  -- The Azores partner has a limited out-of-hours airport service.
  -- Closed periods are forbidden, not bookable for an extra surcharge.
  select p.id into strict v_partner_id from public.partners p
    where p.company_name='Auto Ilhéu Rent a Car' and p.active=true and p.account_status='active' and p.provider_type='local';
  select l.id into strict loc_id from public.partner_locations l
    where l.partner_id=v_partner_id and l.location_name='Ponta Delgada Airport (PDL)' and l.active=true;
  insert into public.partner_time_blocks (partner_id,location_id,applies_to,starts_at,ends_at,active)
    values(v_partner_id,loc_id,'pickup','23:45','07:00',true),
          (partner_id,loc_id,'return','00:00','05:00',true);
end;
$$;
commit;
