-- Ride24: keep API locations the operator deliberately hid out of search.
--
-- Caravel lists Port Souda (external_id 4) and Port Agios Nikolaos (23), but
-- every POST /v1/quote with them as pickup or return is refused with 422
-- delivery_not_offered (verified on production, 20 Nov 2026). They were set
-- inactive, yet caravel_set_release(open=true) ("Aktywuj API") reactivated
-- every Caravel api-managed location. The catalogue sync already keeps `active`
-- of existing rows, so only the release switch and manual edits could undo it.
--
-- operator_hidden = true keeps a location inactive on every write path until an
-- operator clears the flag. Other partners and all other columns are unchanged.

ALTER TABLE public.partner_locations
  ADD COLUMN IF NOT EXISTS operator_hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.partner_locations.operator_hidden IS
  'Operator hid this location from search; it stays active=false until this flag is cleared.';

CREATE OR REPLACE FUNCTION public.partner_locations_keep_operator_hidden()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $f$
BEGIN
  NEW.active := false;
  RETURN NEW;
END;
$f$;
REVOKE ALL ON FUNCTION public.partner_locations_keep_operator_hidden() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS partner_locations_keep_operator_hidden ON public.partner_locations;
CREATE TRIGGER partner_locations_keep_operator_hidden
  BEFORE INSERT OR UPDATE ON public.partner_locations
  FOR EACH ROW WHEN (NEW.operator_hidden AND NEW.active)
  EXECUTE FUNCTION public.partner_locations_keep_operator_hidden();

UPDATE public.partner_locations
   SET operator_hidden = true, active = false
 WHERE partner_id = '78721481-7619-44df-a9b7-5faa344b69bb'
   AND is_api_managed AND external_id IN ('4', '23');

-- Same function as 20261118190000_caravel_release_switch.sql; the only change is
-- "AND NOT operator_hidden" when reactivating Caravel locations on release.
CREATE OR REPLACE FUNCTION public.caravel_set_release(
  p_open boolean, p_certified_at timestamptz, p_document_id text, p_content_hash text,
  p_actor text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  v_partner constant uuid := '78721481-7619-44df-a9b7-5faa344b69bb';
  v_locations integer; v_classes integer;
BEGIN
  IF current_user NOT IN ('service_role','postgres') THEN RAISE EXCEPTION 'CARAVEL_SERVICE_ROLE_REQUIRED'; END IF;
  IF p_open IS NULL OR coalesce(trim(p_actor),'') = '' OR coalesce(trim(p_reason),'') = ''
    THEN RAISE EXCEPTION 'CARAVEL_RELEASE_AUDIT_REQUIRED'; END IF;
  PERFORM 1 FROM public.caravel_release_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARAVEL_RELEASE_STATE_MISSING'; END IF;

  IF p_open THEN
    IF p_certified_at IS NULL OR p_certified_at > clock_timestamp()
      THEN RAISE EXCEPTION 'CARAVEL_CERTIFICATION_EVIDENCE_REQUIRED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.caravel_reviewed_terms
        WHERE document_id = p_document_id AND content_hash = p_content_hash
          AND language = 'en' AND version >= 5 AND format = 'clauses/v1'
          AND damage_admin_fee_minor = 10000 AND damage_admin_fee_currency = 'EUR'
          AND free_cancellation_until_pickup IS TRUE
          AND jsonb_array_length(documented_excluded_codes) > 0
          AND jsonb_array_length(exclusion_clause_refs) > 0
          AND admin_fee_clause_ref IS NOT NULL)
      THEN RAISE EXCEPTION 'CARAVEL_REVIEWED_TERMS_V5_CONTRACT_REQUIRED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.partner_api_credentials
        WHERE partner_id = v_partner AND api_url = 'https://api.caravelway.com'
          AND nullif(api_key,'') IS NOT NULL)
      THEN RAISE EXCEPTION 'CARAVEL_PRODUCTION_CREDENTIALS_REQUIRED'; END IF;
    SELECT count(*) INTO v_locations FROM public.partner_locations
      WHERE partner_id = v_partner AND is_api_managed AND nullif(external_id,'') IS NOT NULL;
    SELECT count(*) INTO v_classes FROM public.car_classes
      WHERE partner_id = v_partner AND is_api_managed AND nullif(external_id,'') IS NOT NULL;
    IF v_locations = 0 OR v_classes = 0 THEN RAISE EXCEPTION 'CARAVEL_CATALOG_NOT_SYNCED'; END IF;

    UPDATE public.caravel_release_control
       SET certified = true, official_certified_at = p_certified_at,
           terms_document_id = p_document_id, terms_content_hash = p_content_hash,
           allow_customer_checkout = true
     WHERE singleton;
    UPDATE public.partners
       SET api_provider = 'caravel', api_enabled = true, api_status = 'synced', provider_type = 'api'
     WHERE id = v_partner AND active AND account_status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION 'CARAVEL_PARTNER_ACCOUNT_NOT_ACTIVE'; END IF;
    UPDATE public.partner_locations SET active = true
     WHERE partner_id = v_partner AND is_api_managed AND nullif(external_id,'') IS NOT NULL
       AND NOT operator_hidden;
    UPDATE public.car_classes SET active = true
     WHERE partner_id = v_partner AND is_api_managed AND nullif(external_id,'') IS NOT NULL;
  ELSE
    -- Kill switch: no new search offers, consent, checkout or supplier dispatch.
    -- Certification evidence is kept; paid bookings continue in the shared workflow.
    UPDATE public.caravel_release_control SET allow_customer_checkout = false WHERE singleton;
    UPDATE public.partners SET api_enabled = false, api_status = 'paused' WHERE id = v_partner;
  END IF;

  INSERT INTO public.caravel_release_log(actor, opened, reason, certified_at, terms_document_id, terms_content_hash)
  VALUES (trim(p_actor), p_open, trim(p_reason), p_certified_at, p_document_id, p_content_hash);
  RETURN (SELECT jsonb_build_object('certified', certified, 'allow_customer_checkout', allow_customer_checkout,
    'terms_document_id', terms_document_id) FROM public.caravel_release_control WHERE singleton);
END;
$function$;
REVOKE ALL ON FUNCTION public.caravel_set_release(boolean,timestamptz,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.caravel_set_release(boolean,timestamptz,text,text,text,text) TO service_role;
