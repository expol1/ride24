-- PROPOSAL ONLY — DO NOT EXECUTE UNTIL PR #84 PRODUCTION INTEGRATION IS APPROVED.
-- Ride24 shared bookings table: additive, nullable fields only.
-- Source: Caravel contract 17 Nov 2026; every Caravel booking must pin the
-- exact immutable API terms document shown before Stripe.
-- DO NOT trust client-supplied document_id. Server must resolve it from
-- GET /v1/reference/terms, fetch the body, verify canonical content_hash
-- per Caravel pack §3.9 and persist id as part of the booking transaction.
-- Confirm existing bookings RLS, grants, triggers, service roles first.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS caravel_terms_document_id text,
  ADD COLUMN IF NOT EXISTS caravel_terms_language text,
  ADD COLUMN IF NOT EXISTS caravel_terms_content_hash text;

COMMENT ON COLUMN public.bookings.caravel_terms_document_id IS
 'Immutable Caravel GET /v1/reference/terms/{document_id} id of contract shown before Stripe; NULL for other providers.';
COMMENT ON COLUMN public.bookings.caravel_terms_language IS
 'BCP47 language code of Caravel terms accepted for this booking.';
COMMENT ON COLUMN public.bookings.caravel_terms_content_hash IS
 'Caravel canonical SHA-256 from the authoritative immutable terms record; not PDF MD5/etag.';

-- These constraints allow NULL for all preexisting/non-Caravel rows.
-- Not a substitute for provider-scoped transactional server validation.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_caravel_terms_snapshot_consistency_chk'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_caravel_terms_snapshot_consistency_chk
      CHECK (
        (caravel_terms_document_id IS NULL AND
         caravel_terms_language IS NULL AND
         caravel_terms_content_hash IS NULL)
        OR
        (caravel_terms_document_id IS NOT NULL AND
         caravel_terms_document_id ~ '^[A-Za-z0-9._~-]{1,200}

COMMIT;

-- REQUIRED IMPLEMENTATION BEFORE EXECUTING:
-- 1. Id + hash must come from server-fetched authoritative Caravel terms,
--    not browser text/old PDF, and be tied to partner + current language.
-- 2. The same id must be stored in api_quotes.raw_response.provider_quote_data
--    at quote creation, then copied to bookings in create-booking-request
--    BEFORE Stripe. Race with new terms -> requote/reshow/re-accept, no charge.
-- 3. Ensure selected id is still current when dispatching after Stripe.
--    If it changed after charge: fail safe/manual review/refund according to
--    existing Ride24 procedures. Do not book silently under changed terms.
-- 4. Exact document and version must be accessible in customer booking/voucher.
-- 5. Verify RLS grants: only backend service role may change these audit fields.
-- 6. Test all existing non-Caravel partners with no values and ensure unaffected.
-- SECURITY REVIEW (read-only verified 2026-11-18):
-- public.bookings has RLS enabled; authenticated users have SELECT only,
-- service_role has DML. public.api_quotes also has RLS and service_role
-- DML only. New nullable columns do NOT need any added grants or RLS
-- policies. Preserve these privileges; do not grant client write access.
-- 7. Avoid reusing existing partner_terms_snapshot for a non-URL id; keep
--    Ride24's URL-snapshot semantics intact for existing rentals.
-- Rollback (only if columns are unused; require separate approval):
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_caravel_terms_snapshot_consistency_chk;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS caravel_terms_content_hash,
--   DROP COLUMN IF EXISTS caravel_terms_language,
--   DROP COLUMN IF EXISTS caravel_terms_document_id;
 AND
         caravel_terms_language IS NOT NULL AND
         caravel_terms_language ~ '^[a-z]{2}(-[A-Z]{2})?

COMMIT;

-- REQUIRED IMPLEMENTATION BEFORE EXECUTING:
-- 1. Id + hash must come from server-fetched authoritative Caravel terms,
--    not browser text/old PDF, and be tied to partner + current language.
-- 2. The same id must be stored in api_quotes.raw_response.provider_quote_data
--    at quote creation, then copied to bookings in create-booking-request
--    BEFORE Stripe. Race with new terms -> requote/reshow/re-accept, no charge.
-- 3. Ensure selected id is still current when dispatching after Stripe.
--    If it changed after charge: fail safe/manual review/refund according to
--    existing Ride24 procedures. Do not book silently under changed terms.
-- 4. Exact document and version must be accessible in customer booking/voucher.
-- 5. Verify RLS grants: only backend service role may change these audit fields.
-- 6. Test all existing non-Caravel partners with no values and ensure unaffected.
-- 7. Avoid reusing existing partner_terms_snapshot for a non-URL id; keep
--    Ride24's URL-snapshot semantics intact for existing rentals.
-- Rollback (only if columns are unused; require separate approval):
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_caravel_terms_hash_format_chk;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS caravel_terms_content_hash,
--   DROP COLUMN IF EXISTS caravel_terms_language,
--   DROP COLUMN IF EXISTS caravel_terms_document_id;
 AND
         caravel_terms_content_hash IS NOT NULL AND
         caravel_terms_content_hash ~ '^[0-9a-f]{64}

COMMIT;

-- REQUIRED IMPLEMENTATION BEFORE EXECUTING:
-- 1. Id + hash must come from server-fetched authoritative Caravel terms,
--    not browser text/old PDF, and be tied to partner + current language.
-- 2. The same id must be stored in api_quotes.raw_response.provider_quote_data
--    at quote creation, then copied to bookings in create-booking-request
--    BEFORE Stripe. Race with new terms -> requote/reshow/re-accept, no charge.
-- 3. Ensure selected id is still current when dispatching after Stripe.
--    If it changed after charge: fail safe/manual review/refund according to
--    existing Ride24 procedures. Do not book silently under changed terms.
-- 4. Exact document and version must be accessible in customer booking/voucher.
-- 5. Verify RLS grants: only backend service role may change these audit fields.
-- 6. Test all existing non-Caravel partners with no values and ensure unaffected.
-- 7. Avoid reusing existing partner_terms_snapshot for a non-URL id; keep
--    Ride24's URL-snapshot semantics intact for existing rentals.
-- Rollback (only if columns are unused; require separate approval):
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_caravel_terms_hash_format_chk;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS caravel_terms_content_hash,
--   DROP COLUMN IF EXISTS caravel_terms_language,
--   DROP COLUMN IF EXISTS caravel_terms_document_id;
)
      );
  END IF;
END
$migration$;

COMMIT;

-- REQUIRED IMPLEMENTATION BEFORE EXECUTING:
-- 1. Id + hash must come from server-fetched authoritative Caravel terms,
--    not browser text/old PDF, and be tied to partner + current language.
-- 2. The same id must be stored in api_quotes.raw_response.provider_quote_data
--    at quote creation, then copied to bookings in create-booking-request
--    BEFORE Stripe. Race with new terms -> requote/reshow/re-accept, no charge.
-- 3. Ensure selected id is still current when dispatching after Stripe.
--    If it changed after charge: fail safe/manual review/refund according to
--    existing Ride24 procedures. Do not book silently under changed terms.
-- 4. Exact document and version must be accessible in customer booking/voucher.
-- 5. Verify RLS grants: only backend service role may change these audit fields.
-- 6. Test all existing non-Caravel partners with no values and ensure unaffected.
-- 7. Avoid reusing existing partner_terms_snapshot for a non-URL id; keep
--    Ride24's URL-snapshot semantics intact for existing rentals.
-- Rollback (only if columns are unused; require separate approval):
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_caravel_terms_hash_format_chk;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS caravel_terms_content_hash,
--   DROP COLUMN IF EXISTS caravel_terms_language,
--   DROP COLUMN IF EXISTS caravel_terms_document_id;
