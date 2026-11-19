-- Original production definition before optional second-driver migration.
-- Execute only to rollback after pausing Caravel additional-driver checkout.
CREATE OR REPLACE FUNCTION public.caravel_commit_pending_booking(p_quote_id uuid, p_client_id uuid, p_payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_q public.api_quotes%ROWTYPE;
  v_p record;
  v_gate public.caravel_release_control%ROWTYPE;
  v_prov jsonb;
  v_pick record;
  v_drop record;
  v_class record;
  v_id uuid;
  v_rent_minor bigint;
  v_fee_minor bigint;
  v_quote_minor bigint;
  v_now timestamptz := clock_timestamp();
  v_exclusions jsonb;
BEGIN
  IF current_user NOT IN ('service_role','postgres')
    THEN RAISE EXCEPTION 'CARAVEL_SERVICE_ROLE_REQUIRED'; END IF;
  IF p_quote_id IS NULL OR p_client_id IS NULL OR
     jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'CARAVEL_ATOMIC_INVALID_ARGUMENT'; END IF;

  SELECT * INTO v_gate FROM public.caravel_release_control WHERE singleton=true;
  IF NOT FOUND OR NOT v_gate.certified OR
     NOT v_gate.allow_customer_checkout OR
     v_gate.official_certified_at IS NULL
    THEN RAISE EXCEPTION 'CARAVEL_RELEASE_GATE_CLOSED'; END IF;

  SELECT * INTO v_q FROM public.api_quotes
    WHERE id=p_quote_id
      AND partner_id='78721481-7619-44df-a9b7-5faa344b69bb'::uuid
      AND booking_id IS NULL AND used_at IS NULL
      AND expires_at > v_now + interval '10 minutes'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARAVEL_QUOTE_USED_OR_EXPIRED'; END IF;

  SELECT api_provider,api_enabled,api_status,provider_type,active,account_status
    INTO v_p FROM public.partners
   WHERE id=v_q.partner_id;
  IF NOT FOUND OR v_p.api_provider IS DISTINCT FROM 'caravel' OR
     v_p.api_enabled IS DISTINCT FROM true OR
     v_p.api_status IS DISTINCT FROM 'synced' OR
     v_p.provider_type IS DISTINCT FROM 'api' OR
     v_p.active IS DISTINCT FROM true OR
     v_p.account_status IS DISTINCT FROM 'active'
    THEN RAISE EXCEPTION 'CARAVEL_PARTNER_NOT_CERTIFIED'; END IF;

  SELECT id,partner_id,external_id,active INTO v_class
    FROM public.car_classes WHERE id=v_q.car_class_id;
  IF NOT FOUND OR v_class.partner_id IS DISTINCT FROM v_q.partner_id OR
     v_class.active IS DISTINCT FROM true OR
     v_class.external_id IS DISTINCT FROM v_q.external_group_id
    THEN RAISE EXCEPTION 'CARAVEL_CATEGORY_INVALID'; END IF;

  v_prov := v_q.raw_response->'provider_quote_data';
  IF jsonb_typeof(v_prov) IS DISTINCT FROM 'object' OR
     v_prov->>'provider' IS DISTINCT FROM 'caravel' OR
     v_prov->>'payment_model' IS DISTINCT FROM 'pay_on_arrival' OR
     v_prov->>'quote_id' IS DISTINCT FROM v_q.external_quote_reference OR
     v_prov->>'supplier_id' IS NULL OR
     v_prov->>'vehicle_id' IS DISTINCT FROM v_q.external_group_id OR
     v_prov->>'currency' IS DISTINCT FROM v_q.currency OR
     v_prov->>'terms_document_id' IS DISTINCT FROM v_gate.terms_document_id OR
     v_prov->>'terms_content_hash' IS DISTINCT FROM v_gate.terms_content_hash OR
     v_prov->>'terms_language' IS NULL OR
     (v_prov->>'expires_at')::timestamptz IS DISTINCT FROM v_q.expires_at
    THEN RAISE EXCEPTION 'CARAVEL_QUOTE_TERMS_OR_ORIGIN_CHANGED'; END IF;
  v_rent_minor := round(v_q.partner_net_total*100)::bigint;
  v_fee_minor := round(v_q.commission_total*100)::bigint;
  v_quote_minor := (v_prov#>>'{amounts_minor,total}')::bigint;
  IF v_rent_minor<=0 OR v_fee_minor<=0 OR
     v_quote_minor IS DISTINCT FROM v_rent_minor OR
     (v_prov#>>'{amounts_minor,pay_now}')::bigint IS DISTINCT FROM 0 OR
     (v_prov#>>'{amounts_minor,pay_at_pickup}')::bigint IS DISTINCT FROM v_rent_minor OR
     round(v_q.final_total*100)::bigint <> v_rent_minor+v_fee_minor OR
     v_q.partner_discount_percent <> 0
    THEN RAISE EXCEPTION 'CARAVEL_QUOTE_MONEY_INVALID'; END IF;

  IF (p_payload->>'client_id')::uuid IS DISTINCT FROM p_client_id OR
     (p_payload->>'car_class_id')::uuid IS DISTINCT FROM v_q.car_class_id OR
     (p_payload->>'partner_id')::uuid IS DISTINCT FROM v_q.partner_id OR
     (p_payload->>'api_quote_id')::uuid IS DISTINCT FROM p_quote_id OR
     p_payload->>'caravel_supplier_quote_id' IS DISTINCT FROM v_q.external_quote_reference OR
     p_payload->>'caravel_supplier_id' IS DISTINCT FROM v_prov->>'supplier_id' OR
     p_payload->>'caravel_terms_document_id' IS DISTINCT FROM v_gate.terms_document_id OR
     p_payload->>'caravel_terms_content_hash' IS DISTINCT FROM v_gate.terms_content_hash OR
     p_payload->>'caravel_terms_language' IS DISTINCT FROM v_prov->>'terms_language' OR
     p_payload->>'terms_accepted' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'CARAVEL_BOOKING_SNAPSHOT_TAMPERED'; END IF;
  IF (p_payload->>'start_date')::date IS DISTINCT FROM v_q.start_date OR
     (p_payload->>'end_date')::date IS DISTINCT FROM v_q.end_date OR
     p_payload->>'pickup_time' IS NULL OR p_payload->>'return_time' IS NULL OR
     ((p_payload->>'pickup_time')::time)::text IS DISTINCT FROM
       (v_q.raw_response#>>'{ride24_context,pickup_time}')::time::text OR
     ((p_payload->>'return_time')::time)::text IS DISTINCT FROM
       (v_q.raw_response#>>'{ride24_context,return_time}')::time::text
    THEN RAISE EXCEPTION 'CARAVEL_BOOKING_TIME_CHANGED'; END IF;

  SELECT partner_id,external_id,active,is_api_managed,return_only,location_name
    INTO v_pick FROM public.partner_locations
    WHERE id=(p_payload->>'pickup_location_id')::uuid;
  IF NOT FOUND OR v_pick.partner_id IS DISTINCT FROM v_q.partner_id OR
     v_pick.active IS DISTINCT FROM true OR
     v_pick.is_api_managed IS DISTINCT FROM true OR
     v_pick.return_only IS DISTINCT FROM false OR
     v_pick.external_id IS DISTINCT FROM v_q.pickup_location_external_id OR
     v_pick.location_name IS DISTINCT FROM p_payload->>'pickup_location'
    THEN RAISE EXCEPTION 'CARAVEL_PICKUP_NOT_APPROVED'; END IF;
  SELECT partner_id,external_id,active,is_api_managed,location_name
    INTO v_drop FROM public.partner_locations
    WHERE id=(p_payload->>'dropoff_location_id')::uuid;
  IF NOT FOUND OR v_drop.partner_id IS DISTINCT FROM v_q.partner_id OR
     v_drop.active IS DISTINCT FROM true OR
     v_drop.is_api_managed IS DISTINCT FROM true OR
     v_drop.external_id IS DISTINCT FROM v_q.dropoff_location_external_id OR
     v_drop.location_name IS DISTINCT FROM p_payload->>'return_location'
    THEN RAISE EXCEPTION 'CARAVEL_RETURN_NOT_APPROVED'; END IF;

  IF (p_payload->>'exchange_rate_snapshot')::numeric <= 0 OR
     round(v_q.commission_total *
       (p_payload->>'exchange_rate_snapshot')::numeric,2)
       IS DISTINCT FROM (p_payload->>'online_payment_pln')::numeric OR
     (p_payload->>'online_payment_pln')::numeric <= 0
    THEN RAISE EXCEPTION 'CARAVEL_FEE_OR_FX_MISMATCH'; END IF;

  v_exclusions := v_prov#>'{protection,excludes}';
  IF jsonb_typeof(v_exclusions) IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'CARAVEL_PROTECTION_MISSING'; END IF;
  IF jsonb_array_length(v_exclusions) > 0 AND (
    p_payload->'caravel_coverage_excluded_codes' IS DISTINCT FROM v_exclusions OR
    p_payload->>'caravel_coverage_terms_document_id'
      IS DISTINCT FROM v_gate.terms_document_id OR
    p_payload->>'caravel_coverage_terms_content_hash'
      IS DISTINCT FROM v_gate.terms_content_hash OR
    p_payload->>'caravel_coverage_supplier_id'
      IS DISTINCT FROM v_prov->>'supplier_id' OR
    p_payload->>'caravel_coverage_quote_id'
      IS DISTINCT FROM v_q.external_quote_reference OR
    (p_payload->>'caravel_coverage_damage_admin_fee_minor')::integer
      IS DISTINCT FROM (v_prov->>'damage_administration_fee_minor')::integer
  ) THEN RAISE EXCEPTION 'CARAVEL_EXCLUSION_CONSENT_REQUIRED'; END IF;
  IF jsonb_array_length(v_exclusions)=0 AND
    p_payload ? 'caravel_coverage_excluded_codes'
    THEN RAISE EXCEPTION 'CARAVEL_UNEXPECTED_COVERAGE_CONSENT'; END IF;
  IF trim(coalesce(p_payload->>'main_driver_name',''))='' OR
     (p_payload->>'main_driver_age')::int NOT BETWEEN 18 AND 90 OR
     trim(coalesce(p_payload->>'client_email',''))='' OR
     trim(coalesce(p_payload->>'client_phone',''))=''
    THEN RAISE EXCEPTION 'CARAVEL_CUSTOMER_INVALID'; END IF;

  INSERT INTO public.bookings(
    client_id,partner_id,car_class_id,pickup_location_id,dropoff_location_id,
    start_date,end_date,pickup_time,return_time,pickup_location,return_location,
    partner_currency,partner_public_price_snapshot,partner_discount_snapshot,
    partner_net_price_snapshot,platform_margin_snapshot,final_price_snapshot,
    commission_snapshot,online_payment_pln,pickup_payment_partner_currency,
    exchange_rate_snapshot,deposit_snapshot,status,provider_type,api_status,
    manual_review,api_quote_id,caravel_supplier_quote_id,caravel_supplier_id,
    caravel_terms_document_id,caravel_terms_language,caravel_terms_content_hash,
    caravel_coverage_supplier_id,caravel_coverage_quote_id,
    caravel_coverage_terms_document_id,caravel_coverage_terms_content_hash,
    caravel_coverage_excluded_codes,caravel_coverage_damage_admin_fee_minor,
    caravel_coverage_accepted_at,terms_accepted,terms_accepted_at,
    main_driver_name,main_driver_age,client_email,client_phone
  ) VALUES (
    p_client_id,v_q.partner_id,v_q.car_class_id,
    (p_payload->>'pickup_location_id')::uuid,
    (p_payload->>'dropoff_location_id')::uuid,
    v_q.start_date,v_q.end_date,
    (p_payload->>'pickup_time')::time,(p_payload->>'return_time')::time,
    v_pick.location_name,v_drop.location_name,
    v_q.currency,v_q.public_price_per_day,v_q.partner_discount_percent,
    v_q.partner_net_total,v_q.platform_margin_percent,v_q.final_total,
    v_q.commission_total,(p_payload->>'online_payment_pln')::numeric,
    v_q.partner_net_total,(p_payload->>'exchange_rate_snapshot')::numeric,
    0,'awaiting_payment','api','caravel_awaiting_stripe',
    false,v_q.id,(v_q.external_quote_reference)::uuid,v_prov->>'supplier_id',
    v_gate.terms_document_id,v_prov->>'terms_language',
    v_gate.terms_content_hash,
    CASE WHEN jsonb_array_length(v_exclusions)>0
      THEN v_prov->>'supplier_id' END,
    CASE WHEN jsonb_array_length(v_exclusions)>0
      THEN v_q.external_quote_reference END,
    CASE WHEN jsonb_array_length(v_exclusions)>0
      THEN v_gate.terms_document_id END,
    CASE WHEN jsonb_array_length(v_exclusions)>0
      THEN v_gate.terms_content_hash END,
    CASE WHEN jsonb_array_length(v_exclusions)>0
      THEN v_exclusions END,
    CASE WHEN jsonb_array_length(v_exclusions)>0
      THEN (v_prov->>'damage_administration_fee_minor')::integer END,
    CASE WHEN jsonb_array_length(v_exclusions)>0 THEN v_now END,
    true,v_now,
    p_payload->>'main_driver_name',(p_payload->>'main_driver_age')::bigint,
    p_payload->>'client_email',p_payload->>'client_phone'
  ) RETURNING id INTO v_id;
  UPDATE public.api_quotes
     SET used_at=v_now,booking_id=v_id
   WHERE id=v_q.id AND used_at IS NULL AND booking_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARAVEL_ATOMIC_QUOTE_RACE'; END IF;
  RETURN v_id;
END;
$function$

