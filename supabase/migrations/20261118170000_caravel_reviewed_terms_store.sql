-- Caravel ONLY, additive. Immutable store of the supplier terms documents that a
-- Ride24 operator has reviewed (full clauses/v1 body as fetched from
-- GET /v1/reference/terms/{document_id}, canonical SHA-256 recomputed).
-- The customer consent screen is rendered ONLY from a row here whose
-- (document_id, content_hash) equals caravel_release_control. No row exists
-- until production terms are fetched with the production key; nothing is
-- activated by this migration. Service role only; no client access.
BEGIN;

CREATE TABLE IF NOT EXISTS public.caravel_reviewed_terms (
  document_id text PRIMARY KEY CHECK (document_id ~ '^[A-Za-z0-9._~-]{1,200}$'),
  supplier_id text NOT NULL CHECK (supplier_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}$'),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  format text NOT NULL CHECK (format = 'clauses/v1'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  -- Operator review of the binding text (never browser input).
  documented_excluded_codes jsonb NOT NULL CHECK (jsonb_typeof(documented_excluded_codes) = 'array'),
  damage_admin_fee_minor integer NOT NULL CHECK (damage_admin_fee_minor >= 0),
  damage_admin_fee_currency text NOT NULL CHECK (damage_admin_fee_currency = 'EUR'),
  exclusion_clause_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exclusion_clause_refs) = 'array'),
  admin_fee_clause_ref text,
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 200),
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.caravel_reviewed_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.caravel_reviewed_terms FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.caravel_reviewed_terms TO service_role;

-- Documents never change for an id (Caravel §3.9): refuse UPDATE/DELETE.
CREATE OR REPLACE FUNCTION public.caravel_reviewed_terms_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $f$
BEGIN
  RAISE EXCEPTION 'CARAVEL_REVIEWED_TERMS_IMMUTABLE';
END;
$f$;
REVOKE ALL ON FUNCTION public.caravel_reviewed_terms_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS caravel_reviewed_terms_immutable ON public.caravel_reviewed_terms;
CREATE TRIGGER caravel_reviewed_terms_immutable
  BEFORE UPDATE OR DELETE ON public.caravel_reviewed_terms
  FOR EACH ROW EXECUTE FUNCTION public.caravel_reviewed_terms_immutable();

-- Bridge the SHARED Stripe-first workflow to the Caravel voucher guard
-- (caravel-voucher-confirmation-guard.mjs). Caravel rows only. When the shared
-- api_booking_workflows row is claimed for supplier dispatch (state -> dispatching,
-- only reachable after api_record_verified_payment), copy the Stripe-verified
-- evidence onto the booking exactly once. Never touches other partners.
CREATE OR REPLACE FUNCTION public.caravel_shared_flow_dispatch_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $f$
BEGIN
  IF NEW.state = 'dispatching' AND OLD.state IS DISTINCT FROM 'dispatching'
     AND NEW.paid_at IS NOT NULL AND NEW.amount_cents > 0 AND NEW.currency = 'pln' THEN
    UPDATE public.bookings b
       SET caravel_stripe_payment_confirmed_at = NEW.paid_at,
           caravel_supplier_dispatch_claimed_at = greatest(clock_timestamp(), NEW.paid_at),
           stripe_amount_cents = NEW.amount_cents,
           stripe_currency = NEW.currency
     WHERE b.id = NEW.booking_id
       AND b.partner_id = '78721481-7619-44df-a9b7-5faa344b69bb'::uuid
       AND b.provider_type = 'api'
       AND b.stripe_session_id IS NOT DISTINCT FROM NEW.stripe_session_id
       AND b.caravel_supplier_dispatch_claimed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$f$;
REVOKE ALL ON FUNCTION public.caravel_shared_flow_dispatch_evidence() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS caravel_shared_flow_dispatch_evidence ON public.api_booking_workflows;
CREATE TRIGGER caravel_shared_flow_dispatch_evidence
  AFTER UPDATE OF state ON public.api_booking_workflows
  FOR EACH ROW EXECUTE FUNCTION public.caravel_shared_flow_dispatch_evidence();

COMMIT;
