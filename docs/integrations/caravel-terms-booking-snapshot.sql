-- DRAFT ONLY — DO NOT EXECUTE until Caravel contract, quote persistence,
-- customer acceptance, canonical SHA-256 (§3.9), RLS and full Ride24 E2E
-- booking/refund tests have passed. This is NOT a production migration.
--
-- Caravel documents are immutable and identified by document_id. Save the
-- exact authoritative clauses/v1 version displayed and accepted BEFORE Stripe.
-- The server must derive these values from Caravel, never client-supplied text.
-- This additive migration leaves every existing non-Caravel booking unchanged.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS caravel_terms_document_id text,
  ADD COLUMN IF NOT EXISTS caravel_terms_language text,
  ADD COLUMN IF NOT EXISTS caravel_terms_content_hash text,
  ADD COLUMN IF NOT EXISTS caravel_coverage_terms_document_id text,
  ADD COLUMN IF NOT EXISTS caravel_coverage_terms_content_hash text,
  ADD COLUMN IF NOT EXISTS caravel_coverage_excluded_codes jsonb,
  ADD COLUMN IF NOT EXISTS caravel_coverage_damage_admin_fee_minor integer,
  ADD COLUMN IF NOT EXISTS caravel_coverage_accepted_at timestamptz;

COMMENT ON COLUMN public.bookings.caravel_terms_document_id IS
  'Immutable Caravel authoritative terms document_id accepted before Stripe; NULL for other providers.';
COMMENT ON COLUMN public.bookings.caravel_terms_language IS
  'Language of the authoritative Caravel terms accepted by this booking.';
COMMENT ON COLUMN public.bookings.caravel_terms_content_hash IS
  'Provider-declared canonical SHA-256 of the accepted Caravel terms, verified per contract section 3.9.';

-- The columns must be either ALL NULL (legacy/other provider) or ALL valid.
-- A CHECK constraint cannot prove the document came from Caravel, was shown
-- to the client or was independently hashed — backend enforcement is mandatory.
DO $caravel_terms$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_caravel_terms_snapshot_consistency_chk'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_caravel_terms_snapshot_consistency_chk
      CHECK (
        (
          caravel_terms_document_id IS NULL AND
          caravel_terms_language IS NULL AND
          caravel_terms_content_hash IS NULL
        )
        OR
        (
          caravel_terms_document_id IS NOT NULL AND
          caravel_terms_document_id ~ '^[A-Za-z0-9._~-]{1,200}$' AND
          caravel_terms_document_id NOT IN ('.', '..') AND
          caravel_terms_language IS NOT NULL AND
          caravel_terms_language ~ '^[a-z]{2}(-[A-Z]{2})?$' AND
          caravel_terms_content_hash IS NOT NULL AND
          caravel_terms_content_hash ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END
$caravel_terms$;

-- The coverage consent is optional ONLY for fully covered Caravel Premium.
-- A LIMITED Premium snapshot is all-or-none and must reference the exact
-- same immutable contract the customer accepted. Its exclusion array must
-- contain at least one supplier-defined code; only the trusted backend can
-- check that each code and charge was presented to the customer.
DO $caravel_coverage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_caravel_coverage_consent_consistency_chk'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_caravel_coverage_consent_consistency_chk
      CHECK (
        (
          caravel_coverage_terms_document_id IS NULL AND
          caravel_coverage_terms_content_hash IS NULL AND
          caravel_coverage_excluded_codes IS NULL AND
          caravel_coverage_damage_admin_fee_minor IS NULL AND
          caravel_coverage_accepted_at IS NULL
        )
        OR
        (
          caravel_terms_document_id IS NOT NULL AND
          caravel_terms_content_hash IS NOT NULL AND
          caravel_coverage_terms_document_id IS NOT NULL AND
          caravel_coverage_terms_document_id = caravel_terms_document_id AND
          caravel_coverage_terms_content_hash IS NOT NULL AND
          caravel_coverage_terms_content_hash = caravel_terms_content_hash AND
          caravel_coverage_excluded_codes IS NOT NULL AND
          jsonb_typeof(caravel_coverage_excluded_codes) = 'array' AND
          jsonb_array_length(
            CASE WHEN jsonb_typeof(caravel_coverage_excluded_codes) = 'array'
                 THEN caravel_coverage_excluded_codes
                 ELSE '[]'::jsonb END
          ) > 0 AND
          caravel_coverage_damage_admin_fee_minor IS NOT NULL AND
          caravel_coverage_damage_admin_fee_minor >= 0 AND
          caravel_coverage_accepted_at IS NOT NULL
        )
      );
  END IF;
END
$caravel_coverage$;

COMMIT;

-- BEFORE APPROVING/EXECUTING:
-- 1. Verify the canonical clauses/v1 SHA-256 algorithm from Caravel §3.9.
--    A matching provider-declared hash alone is NOT independent verification.
-- 2. Add a SERVER-SIDE reviewed doc id/hash/language to api_quotes.raw_response
--    and display the exact document to the customer before payment.
-- 3. Capture customer acceptance, including the separately accepted
--    Premium exclusion codes, damage/theft administration fee and server
--    timestamp (if applicable). Copy both snapshots into the same bookings
--    INSERT atomically, not via an unauthenticated later UPDATE.
-- 4. Re-read CURRENT document_id before Stripe payment. If changed, halt
--    and show/re-accept updated terms BEFORE collecting the booking fee.
-- 5. Re-check after Stripe, before Caravel booking creation. If changed,
--    do not silently book; reuse Ride24 review/refund path.
-- 6. Show the actual accepted terms document/version in booking and voucher.
-- 7. Test RLS and E2E for all other providers (including AVIA) and for
--    cancelled / refunded Caravel bookings.
-- 8. Read-only audit of Ride24 Supabase 18 Nov 2026: public.bookings and
--    public.api_quotes both have RLS enabled; authenticated role has SELECT
--    only on public.bookings; service_role has INSERT/UPDATE/SELECT.
--    Do not add customer-write grants for these columns.
-- 9. Preserve current partner_terms_snapshot URL semantics; Caravel doc ID
--    belongs only in the new columns and associated quote metadata.

-- Rollback only before any real Caravel booking uses these columns;
-- requires separate approval and a full backup:
-- BEGIN;
-- ALTER TABLE public.bookings
--   DROP CONSTRAINT IF EXISTS bookings_caravel_coverage_consent_consistency_chk;
-- ALTER TABLE public.bookings
--   DROP CONSTRAINT IF EXISTS bookings_caravel_terms_snapshot_consistency_chk;
-- ALTER TABLE public.bookings
--   DROP COLUMN IF EXISTS caravel_coverage_accepted_at,
--   DROP COLUMN IF EXISTS caravel_coverage_damage_admin_fee_minor,
--   DROP COLUMN IF EXISTS caravel_coverage_excluded_codes,
--   DROP COLUMN IF EXISTS caravel_coverage_terms_content_hash,
--   DROP COLUMN IF EXISTS caravel_coverage_terms_document_id;
-- ALTER TABLE public.bookings
--   DROP COLUMN IF EXISTS caravel_terms_content_hash,
--   DROP COLUMN IF EXISTS caravel_terms_language,
--   DROP COLUMN IF EXISTS caravel_terms_document_id;
-- COMMIT;
