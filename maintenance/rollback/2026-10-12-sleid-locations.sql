-- Manual rollback only. No rows or booking references are deleted.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$
DECLARE p_id uuid := '5c72f936-aef2-418a-84b5-ba1d56f2a6bc';
BEGIN
  PERFORM 1 FROM public.partner_locations WHERE partner_id=p_id FOR UPDATE;
  IF (SELECT count(*) FROM public.partner_locations WHERE partner_id=p_id) <> 4
     OR NOT EXISTS (SELECT 1 FROM public.partner_locations WHERE partner_id=p_id
       AND id='ab664ea1-87d6-469d-8692-8e33e660f1e3'
       AND location_name='Tirana International Airport (TIA)' AND type='airport')
     OR NOT EXISTS (SELECT 1 FROM public.partner_locations WHERE partner_id=p_id
       AND id='b10760d7-f8e4-450d-86f4-496f2c0ce493'
       AND location_name='Durrës City' AND type='city')
     OR NOT EXISTS (SELECT 1 FROM public.partner_locations WHERE partner_id=p_id
       AND id='0ddabc8e-5ccb-4756-ba96-b50115407b52'
       AND location_name='Tirana City' AND type='city' AND city='Tirana'
       AND country='Albania' AND region='Tirana' AND active=true
       AND extra_fee=false AND extra_fee_amount IS NULL AND contact_required=false
       AND guide_id='aa3d9095-f114-4726-9e14-d3b612efe351' AND is_api_managed=false)
     OR NOT EXISTS (SELECT 1 FROM public.partner_locations WHERE partner_id=p_id
       AND id='affc8051-680b-4e40-bba9-d80fbd8d6581'
       AND location_name='Golem (All Coastal Hotels)' AND type='hotel' AND city='Golem'
       AND country='Albania' AND region='Durrës' AND active=true
       AND extra_fee=false AND extra_fee_amount IS NULL AND contact_required=false
       AND guide_id='aa3d9095-f114-4726-9e14-d3b612efe351' AND is_api_managed=false)
  THEN RAISE EXCEPTION 'Location state changed; review before rollback'; END IF;

  UPDATE public.partner_locations SET location_name='Tirana Airport'
    WHERE partner_id=p_id AND id='ab664ea1-87d6-469d-8692-8e33e660f1e3';
  UPDATE public.partner_locations SET location_name='Durres City',type='hotel'
    WHERE partner_id=p_id AND id='b10760d7-f8e4-450d-86f4-496f2c0ce493';
  UPDATE public.partner_locations SET active=false
    WHERE partner_id=p_id AND id IN ('0ddabc8e-5ccb-4756-ba96-b50115407b52','affc8051-680b-4e40-bba9-d80fbd8d6581');
END $$;
COMMIT;
