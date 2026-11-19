-- Caravel production launch — non-mutating Ride24 database preflight.
-- Run as a SELECT in Supabase SQL editor. No credentials or personal data
-- are read, logged, exposed or modified. DO NOT use this report as a
-- substitute for supplier's official 24h certification + signed terms review.
--
-- Expected on 18 Nov 2026: NO_GO. Maintain customer checkout OFF.
-- Updated 18 Nov 2026 (evening): + reviewed terms store and server-flag checks.
WITH
  gate AS (
    SELECT bool_or(certified) AS certified,
      bool_or(allow_customer_checkout) AS checkout_enabled,
      bool_or(official_certified_at IS NOT NULL) AS has_certificate_timestamp,
      max(terms_document_id) AS terms_id,
      max(terms_content_hash) AS terms_sha
    FROM public.caravel_release_control WHERE singleton IS TRUE
  ),
  partner AS (
    SELECT count(*) AS count,
      bool_or(api_provider='caravel' AND api_enabled IS TRUE
        AND api_status='synced' AND provider_type='api'
        AND active IS TRUE AND account_status='active') AS api_active
    FROM public.partners
    WHERE id='78721481-7619-44df-a9b7-5faa344b69bb'::uuid
  ),
  credentials AS (
    SELECT count(*) FILTER (WHERE
      nullif(api_key,'') IS NOT NULL OR
      nullif(bearer_token,'') IS NOT NULL OR
      nullif(api_secret,'') IS NOT NULL) AS with_token
    FROM public.partner_api_credentials
    WHERE partner_id='78721481-7619-44df-a9b7-5faa344b69bb'::uuid
  ),
  fleet AS (
    SELECT (SELECT count(*) FROM public.car_classes WHERE
      partner_id='78721481-7619-44df-a9b7-5faa344b69bb'::uuid
      AND active IS TRUE AND is_api_managed IS TRUE
      AND nullif(external_id,'') IS NOT NULL) AS classes,
      (SELECT count(*) FROM public.partner_locations WHERE
      partner_id='78721481-7619-44df-a9b7-5faa344b69bb'::uuid
      AND active IS TRUE AND is_api_managed IS TRUE
      AND nullif(external_id,'') IS NOT NULL) AS locations
  ),
  reviewed AS (
    SELECT count(*) AS n FROM public.caravel_reviewed_terms t, gate g
    WHERE t.document_id = g.terms_id AND t.content_hash = g.terms_sha
  ),
  checks AS (
    SELECT 10 AS seq, 'official_supplier_certification' AS check_id,
      CASE WHEN certified IS TRUE AND has_certificate_timestamp IS TRUE
        THEN 'PASS' ELSE 'BLOCKED' END AS result,
      'Official 24h Caravel certification must be documented separately' AS notes
      FROM gate
    UNION ALL SELECT 20,'current_reviewed_terms',
      CASE WHEN terms_id IS NOT NULL AND
        terms_sha ~ '^[0-9a-f]{64}$' THEN 'PASS' ELSE 'BLOCKED' END,
      'Must match independently canonical-hashed active clauses/v1 terms'
      FROM gate
    UNION ALL SELECT 25,'reviewed_terms_body_stored',
      CASE WHEN n = 1 THEN 'PASS' ELSE 'BLOCKED' END,
      'caravel_reviewed_terms row (full clauses/v1 body + exclusions + admin fee) for the released id/hash'
      FROM reviewed
    UNION ALL SELECT 30,'partner_provider_enabled',
      CASE WHEN api_active IS TRUE THEN 'PASS' ELSE 'BLOCKED' END,
      'Exact Caravel partner UUID; not any generic custom API partner'
      FROM partner
    UNION ALL SELECT 40,'standard_credential_store_configured',
      CASE WHEN with_token > 0 THEN 'PASS' ELSE 'BLOCKED' END,
      'Checks presence only in partner_api_credentials; never displays secrets'
      FROM credentials
    UNION ALL SELECT 50,'active_api_vehicle_categories',
      CASE WHEN classes > 0 THEN 'PASS' ELSE 'BLOCKED' END,
      'Requires live provider-synced vehicle category IDs'
      FROM fleet
    UNION ALL SELECT 60,'active_api_pickup_locations',
      CASE WHEN locations > 0 THEN 'PASS' ELSE 'BLOCKED' END,
      'Requires active provider-synced Ride24 pickup locations'
      FROM fleet
    UNION ALL SELECT 70,'customer_checkout_release',
      CASE WHEN checkout_enabled IS TRUE THEN 'PASS' ELSE 'BLOCKED' END,
      'Never enable before successful certification, coverage and E2E review'
      FROM gate
    UNION ALL SELECT 75,'paid_fulfillment_server_flags',
      'MANUAL','Edge secrets CARAVEL_PRODUCTION_WRITES_ALLOWED and CARAVEL_STRIPE_FIRST_APPROVED (both unset = no supplier booking)'
    UNION ALL SELECT 80,'verified_latest_supplier_coverage_terms',
      'MANUAL','Supplier Premium waiver, exclusions, admin fee, zero deposit/excess and real SHA-256'
    UNION ALL SELECT 90,'live_signed_HMAC_and_webhook_reconcile',
      'MANUAL','Official HMAC fixture self-test, signed delivery, replay and missed-event recovery'
    UNION ALL SELECT 100,'production_authenticated_checkout_and_dispatch',
      'MANUAL','Deployment of customer consent, Stripe receipt, atomic dispatch, voucher and refund flows'
    UNION ALL SELECT 110,'live_End_to_End_and_AVIA_regression',
      'MANUAL','Use real supplier sandbox/certification, not mock-only GitHub CI'
  )
SELECT check_id, result, notes FROM (
  SELECT 0 AS seq, 'FINAL_GO_NO_GO' AS check_id,
    CASE WHEN bool_and(result='PASS') THEN 'DB_CHECKS_PASSED'
      ELSE 'NO_GO' END AS result,
    'MANUAL checks require separate signed evidence before production launch' AS notes
  FROM checks
  UNION ALL
  SELECT seq,check_id,result,notes FROM checks
) q ORDER BY seq;
