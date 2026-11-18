-- DRAFT ONLY — NOT APPLIED TO RIDE24 SUPABASE.
-- Caravel post-Stripe atomic dispatch claim. Requires the previously reviewed
-- Caravel terms and coverage snapshot migration, real signed Stripe handler,
-- current Caravel clauses/v1/quote proof, official 24-hour certification and
-- an E2E test of cancellations/refunds/voucher gating BEFORE deploying.
--
-- Sole designated Caravel partner (until a separately reviewed expansion):
-- 78721481-7619-44df-a9b7-5faa344b69bb.
--
-- Existing non-Caravel rows keep all four fields NULL. No grants, RLS
-- changes, service_role exposure or change to AVIA.

BEGIN;
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
      OR
      (
        partner_id = '78721481-7619-44df-a9b7-5faa344b69bb'::uuid
        AND provider_type = 'api'
        AND status = 'pending'
        AND manual_review IS FALSE
        AND cancelled_at IS NULL
        AND api_booking_reference IS NULL
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
      )
    );
 END IF;
END
$caravel_claim$;
COMMIT;

-- Required integration semantics — NOT executable as a public SQL endpoint:
-- 1. Stripe signature + session verified, UPDATE bookings by id AND
--    status='awaiting_payment', with no cancelled_at, setting status='pending',
--    api_status='caravel_paid_awaiting_supplier' and
--    caravel_stripe_payment_confirmed_at=server now. NO voucher or email yet.
-- 2. Authenticated SERVICE-ROLE dispatcher does a SINGLE filtered UPDATE:
--    UPDATE bookings SET api_status='caravel_supplier_dispatch_claimed',
--    caravel_supplier_dispatch_claimed_at=:server_now
--    WHERE id=:booking_id AND status='pending'
--      AND api_status='caravel_paid_awaiting_supplier'
--      AND caravel_stripe_payment_confirmed_at IS NOT NULL
--      AND cancelled_at IS NULL AND api_booking_reference IS NULL
--      AND manual_review IS FALSE RETURNING ...;
--    Exactly one row = winner, zero rows = do not call Caravel.
-- 3. Freshly load quote, terms, supplier, protection/IDP evidence via service
--    role. verifyCaravelClaimedPaidBooking MUST pass. Then single
--    Idempotency-Key=Ride24 booking UUID, external_ref=ride24-{uuid}.
-- 4. Only a provider-confirmed response with exact quote/payment becomes
--    Ride24 status='paid', api_status='confirmed', api_booking_reference.
--    ONLY THEN create voucher and send confirmation.
-- 5. On unknown supplier response: keep claimed state and queue manual
--    reconciliation/refund; NEVER automatically issue another booking.
-- 6. All these writes require tested authorization and error handling.
--    Do not use SECURITY DEFINER to bypass user policies.
--
-- Rollback requires approval and confirmation that NO Caravel booking uses
-- this state; preserve payment/reconciliation evidence before any deletion.
