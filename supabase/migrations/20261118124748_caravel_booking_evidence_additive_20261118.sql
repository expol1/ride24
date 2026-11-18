-- Supabase production migration 20261118124748: Caravel-only ADDITIVE schema.

-- Applied 2026-11-18 via Supabase MCP; exact DDL copied from the two reviewed

-- docs/integrations/caravel-*.sql proposals. No live Caravel account/checkout.

-- Idempotent field/constraint/index creation, preserves existing AVIA and API paths.




ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS caravel_terms_document_id text,
  ADD COLUMN IF NOT EXISTS caravel_terms_language text,
  ADD COLUMN IF NOT EXISTS caravel_terms_content_hash text,
  ADD COLUMN IF NOT EXISTS caravel_coverage_supplier_id text,
  ADD COLUMN IF NOT EXISTS caravel_coverage_quote_id text,
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

COMMENT ON COLUMN public.bookings.caravel_coverage_supplier_id IS
  'Supplier scope of Premium exclusion consent, captured before Stripe.';
COMMENT ON COLUMN public.bookings.caravel_coverage_quote_id IS
  'Exact Caravel UUID quote accepted before Stripe; changed quotes block dispatch.';

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
          caravel_coverage_supplier_id IS NULL AND
          caravel_coverage_quote_id IS NULL AND
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
          caravel_coverage_supplier_id IS NOT NULL AND
          caravel_coverage_supplier_id ~ '^[A-Za-z0-9_-]{1,128}$' AND
          caravel_coverage_quote_id IS NOT NULL AND
          caravel_coverage_quote_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
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


ALTER TABLE public.bookings
 ADD COLUMN IF NOT EXISTS caravel_supplier_quote_id uuid,
 ADD COLUMN IF NOT EXISTS caravel_supplier_id text,
 ADD COLUMN IF NOT EXISTS caravel_stripe_payment_confirmed_at timestamptz,
 ADD COLUMN IF NOT EXISTS caravel_supplier_dispatch_claimed_at timestamptz;

COMMENT ON COLUMN public.bookings.caravel_supplier_quote_id IS
 'Immutable Caravel supplier quote UUID, snapshotted in same booking INSERT as accepted terms BEFORE Stripe.';
COMMENT ON COLUMN public.bookings.caravel_supplier_id IS
 'Caravel supplier account scope, snapshotted by trusted server before Stripe.';
COMMENT ON COLUMN public.bookings.caravel_stripe_payment_confirmed_at IS
 'Server-written only after Stripe-signed verified payment session matches amount, currency, booking and original checkout.';
COMMENT ON COLUMN public.bookings.caravel_supplier_dispatch_claimed_at IS
 'Server-written atomically with Caravel-only api_status CAS from caravel_paid_awaiting_supplier; never automatically reset.';

DO $caravel_claim$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.bookings'::regclass
    AND conname='bookings_caravel_claim_consistency_chk'
 ) THEN
  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_caravel_claim_consistency_chk
    CHECK (
      api_status IS DISTINCT FROM 'caravel_supplier_dispatch_claimed'
      OR COALESCE((
        partner_id = '78721481-7619-44df-a9b7-5faa344b69bb'::uuid
        AND provider_type = 'api'
        AND stripe_session_id IS NOT NULL
        AND stripe_currency = 'pln'
        AND stripe_amount_cents > 0
        AND caravel_supplier_quote_id IS NOT NULL
        AND caravel_supplier_id IS NOT NULL
        AND caravel_supplier_id ~ '^[A-Za-z0-9_-]{1,128}$'
        AND caravel_terms_document_id IS NOT NULL
        AND caravel_terms_content_hash IS NOT NULL
        AND caravel_terms_language IS NOT NULL
        AND caravel_stripe_payment_confirmed_at IS NOT NULL
        AND caravel_supplier_dispatch_claimed_at IS NOT NULL
        AND caravel_supplier_dispatch_claimed_at >= caravel_stripe_payment_confirmed_at
      ), FALSE)
    );
 END IF;
END
$caravel_claim$;

-- Partial uniqueness is Caravel-only. It prevents duplicate review tickets
-- when two workers encounter the SAME supplier outcome at once. It is not a
-- new booking constraint, and other providers' reviews remain unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS booking_review_queue_caravel_supplier_review_uq
 ON public.booking_review_queue (booking_id)
 WHERE provider_key='caravel' AND provider_status='supplier_manual_review';

