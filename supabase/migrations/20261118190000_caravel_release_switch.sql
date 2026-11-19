-- Caravel ONLY. Atomic release switch + append-only audit log.
-- NOT APPLIED to production yet (18 Nov 2026): apply only at go-live review.
-- Defining the function changes nothing; calling it with p_open=true is the
-- production activation and requires the reviewed evidence checked below.
BEGIN;

CREATE TABLE IF NOT EXISTS public.caravel_release_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  opened boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  certified_at timestamptz,
  terms_document_id text,
  terms_content_hash text
);
ALTER TABLE public.caravel_release_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.caravel_release_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.caravel_release_log TO service_role;
GRANT USAGE ON SEQUENCE public.caravel_release_log_id_seq TO service_role;
CREATE OR REPLACE FUNCTION public.caravel_release_log_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $f$
BEGIN RAISE EXCEPTION 'CARAVEL_RELEASE_LOG_IMMUTABLE'; END; $f$;
REVOKE ALL ON FUNCTION public.caravel_release_log_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS caravel_release_log_immutable ON public.caravel_release_log;
CREATE TRIGGER caravel_release_log_immutable BEFORE UPDATE OR DELETE ON public.caravel_release_log
  FOR EACH ROW EXECUTE FUNCTION public.caravel_release_log_immutable();

CREATE OR REPLACE FUNCTION public.caravel_set_release(
  p_open boolean, p_certified_at timestamptz, p_document_id text, p_content_hash text,
  p_actor text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $f$
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
     WHERE partner_id = v_partner AND is_api_managed AND nullif(external_id,'') IS NOT NULL;
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
$f$;
REVOKE ALL ON FUNCTION public.caravel_set_release(boolean,timestamptz,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.caravel_set_release(boolean,timestamptz,text,text,text,text) TO service_role;

COMMIT;
