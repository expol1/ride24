-- Caravel-only production webhook observation store; not applied at commit time.
-- HMAC and scoped supplier GET are mandatory BEFORE calling the restricted RPC.
-- Never consume payload.data as booking truth. No client PII or secrets stored.
BEGIN;
CREATE TABLE IF NOT EXISTS public.caravel_production_webhook_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL,
  operator_id text NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 128),
  supplier_id text NOT NULL CHECK (length(supplier_id) BETWEEN 1 AND 128),
  supplier_booking_id text NOT NULL CHECK (length(supplier_booking_id) BETWEEN 1 AND 128),
  external_ref text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 150),
  event_revision int NOT NULL CHECK (event_revision > 0),
  fetched_revision int NOT NULL CHECK (fetched_revision >= event_revision),
  sequence bigint CHECK (sequence IS NULL OR sequence > 0),
  provider_status text NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 128),
  ride24_booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  sequence_gap boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS caravel_production_webhook_supplier_revision_idx
  ON public.caravel_production_webhook_events(supplier_id,supplier_booking_id,fetched_revision DESC);
CREATE INDEX IF NOT EXISTS caravel_production_webhook_gaps_idx
  ON public.caravel_production_webhook_events(received_at DESC) WHERE sequence_gap;
ALTER TABLE public.caravel_production_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.caravel_production_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.caravel_production_webhook_events TO service_role;

CREATE OR REPLACE FUNCTION public.caravel_record_verified_webhook_event(
  p_event_id text, p_event_type text, p_occurred_at timestamptz, p_operator_id text,
  p_supplier_id text, p_supplier_booking_id text, p_external_ref text,
  p_event_revision integer, p_fetched_revision integer, p_sequence bigint, p_provider_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_partner constant uuid := '78721481-7619-44df-a9b7-5faa344b69bb';
  v_linked_id uuid;
  v_previous_revision integer;
  v_previous_sequence bigint;
  v_gap boolean := false;
  v_count integer;
BEGIN
  IF current_user NOT IN ('service_role','postgres') THEN
    RAISE EXCEPTION 'CARAVEL_WEBHOOK_SERVICE_ROLE_REQUIRED';
  END IF;
  IF p_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_operator_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_supplier_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_supplier_booking_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_event_type IS NULL OR length(p_event_type) NOT BETWEEN 1 AND 128
     OR p_external_ref IS NULL OR length(p_external_ref) NOT BETWEEN 1 AND 150
     OR p_provider_status !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_event_revision < 1 OR p_fetched_revision < p_event_revision
     OR (p_sequence IS NOT NULL AND p_sequence < 1)
     OR p_occurred_at IS NULL
  THEN RAISE EXCEPTION 'CARAVEL_WEBHOOK_INVALID_EVIDENCE'; END IF;

  -- Serialize operator stream checks for concurrent deliveries.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operator_id, 20261119));

  SELECT max(sequence) INTO v_previous_sequence
    FROM public.caravel_production_webhook_events
   WHERE operator_id = p_operator_id;
  v_gap := p_sequence IS NOT NULL AND v_previous_sequence IS NOT NULL AND p_sequence > v_previous_sequence + 1;

  SELECT max(fetched_revision) INTO v_previous_revision
    FROM public.caravel_production_webhook_events
   WHERE supplier_id = p_supplier_id AND supplier_booking_id = p_supplier_booking_id;

  -- Match only Caravel's own Ride24 reservation and supplier ID.
  SELECT id INTO v_linked_id FROM public.bookings
   WHERE partner_id = v_partner
     AND api_booking_reference = p_supplier_booking_id
     AND caravel_supplier_id = p_supplier_id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  INSERT INTO public.caravel_production_webhook_events
    (event_id,event_type,occurred_at,operator_id,supplier_id,supplier_booking_id,external_ref,
     event_revision,fetched_revision,sequence,provider_status,ride24_booking_id,sequence_gap)
  VALUES
    (p_event_id,p_event_type,p_occurred_at,p_operator_id,p_supplier_id,p_supplier_booking_id,p_external_ref,
     p_event_revision,p_fetched_revision,p_sequence,p_provider_status,v_linked_id,v_gap)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('accepted',true,'duplicate',true,'sequence_gap',false);
  END IF;
  -- No automatic booking cancellations, refunds or voucher changes.
  -- Supplier-initiated changes and missed sequences go to manual reconciliation.
  IF v_linked_id IS NOT NULL AND
    (v_previous_revision IS NULL OR p_fetched_revision > v_previous_revision) AND
    (p_event_type <> 'booking.confirmed' OR p_provider_status <> 'confirmed' OR v_gap)
  THEN
    UPDATE public.bookings SET manual_review = true WHERE id = v_linked_id;
    IF NOT EXISTS (
      SELECT 1 FROM public.booking_review_queue
      WHERE booking_id = v_linked_id::text AND provider_key = 'caravel' AND resolved = false
    ) THEN
      INSERT INTO public.booking_review_queue(booking_id, provider_key, provider_status, api_response, resolved)
      VALUES (v_linked_id::text,'caravel',left(p_provider_status,128),
        'Verified Caravel event ' || left(p_event_type,80) ||
        CASE WHEN v_gap THEN ' / sequence gap' ELSE '' END, false);
    END IF;
  END IF;
  RETURN jsonb_build_object('accepted',true,'duplicate',false,
    'sequence_gap',v_gap,'linked',v_linked_id IS NOT NULL,
    'stale',v_previous_revision IS NOT NULL AND p_fetched_revision <= v_previous_revision);
END;
$fn$;
REVOKE ALL ON FUNCTION public.caravel_record_verified_webhook_event(
  text,text,timestamptz,text,text,text,text,integer,integer,bigint,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.caravel_record_verified_webhook_event(
  text,text,timestamptz,text,text,text,text,integer,integer,bigint,text
) TO service_role;
COMMIT;
