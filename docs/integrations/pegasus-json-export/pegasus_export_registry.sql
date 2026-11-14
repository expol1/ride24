-- Pegasus-only export registry. No triggers or changes to existing booking logic.
CREATE SCHEMA IF NOT EXISTS pegasus_private;
REVOKE ALL ON SCHEMA pegasus_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA pegasus_private TO service_role;
CREATE TABLE IF NOT EXISTS pegasus_private.export_state (
 booking_id uuid PRIMARY KEY,
 partner_id uuid NOT NULL CHECK (partner_id='b61dfc7b-a4cd-4f27-b059-517cdf4f01cf'::uuid),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 payload jsonb NOT NULL,
 fingerprint text NOT NULL,
 changed_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON pegasus_private.export_state FROM PUBLIC, anon, authenticated;
ALTER TABLE pegasus_private.export_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON pegasus_private.export_state TO service_role;
CREATE TABLE IF NOT EXISTS pegasus_private.export_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_refresh_at timestamptz,
 window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 requests_in_window integer NOT NULL DEFAULT 0 CHECK(requests_in_window>=0)
);
REVOKE ALL ON pegasus_private.export_control FROM PUBLIC, anon, authenticated;
ALTER TABLE pegasus_private.export_control ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON pegasus_private.export_control TO service_role;
INSERT INTO pegasus_private.export_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS pegasus_private.location_codes (
 location_id uuid PRIMARY KEY,
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-Z][A-Z0-9_]{2,39}$')
);
REVOKE ALL ON pegasus_private.location_codes FROM PUBLIC, anon, authenticated;
ALTER TABLE pegasus_private.location_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON pegasus_private.location_codes TO service_role;
INSERT INTO pegasus_private.location_codes(location_id,code) VALUES
('f507a656-a969-4c6b-82be-cd7af26225fd','OHRID_AIRPORT'),
('2743dd2b-76e5-4de9-b7d3-6adc86496a8b','OHRID_CITY'),
('b65a38af-0ba3-4a81-a30c-46d78c3d464f','PESTANI'),
('b8908cfd-de49-45bf-a3ab-183469bcdd24','SKOPJE_AIRPORT')
ON CONFLICT(location_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.pegasus_export_page(
 p_after_booking_id uuid DEFAULT NULL, p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pegasus_private AS $peg$
DECLARE
 v_partner constant uuid := 'b61dfc7b-a4cd-4f27-b059-517cdf4f01cf'::uuid;
 v_refreshed timestamptz; v_window timestamptz; v_calls integer;
 v_items jsonb; v_last uuid; v_more boolean;
BEGIN
 IF current_user <> 'service_role' THEN
   RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
   RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE='22023';
 END IF;
 -- Row lock is confined to Pegasus control; other rental partners never wait on it.
 PERFORM 1 FROM pegasus_private.export_control WHERE singleton=true FOR UPDATE;
 SELECT last_refresh_at,window_started_at,requests_in_window
   INTO v_refreshed,v_window,v_calls
   FROM pegasus_private.export_control WHERE singleton=true;
 IF v_window >= clock_timestamp()-interval '1 minute' THEN
   IF v_calls>=30 THEN
     RAISE EXCEPTION 'EXPORT_RATE_LIMIT' USING ERRCODE='22023';
   END IF;
   UPDATE pegasus_private.export_control
     SET requests_in_window=requests_in_window+1 WHERE singleton=true;
 ELSE
   UPDATE pegasus_private.export_control
     SET window_started_at=clock_timestamp(),requests_in_window=1
     WHERE singleton=true;
 END IF;
 IF v_refreshed IS NULL OR v_refreshed < clock_timestamp()-interval '30 seconds' THEN
   INSERT INTO pegasus_private.export_state(booking_id,partner_id,payload,fingerprint)
   SELECT source.id,v_partner,source.payload,md5(source.payload::text)
   FROM (
     SELECT b.id,
       jsonb_build_object(
         'bookingId',b.id,'reservationCode',b.reservation_code,
         'status',b.status::text,
         'category',jsonb_build_object('id',b.car_class_id,'code',cc.class_code,'model',cc.model),
         'vehicleId',NULL,
         'pickup',jsonb_build_object('date',b.start_date,'time',b.pickup_time,
           'locationId',b.pickup_location_id,'locationCode',plc.code,
           'locationName',coalesce(pl.location_name,b.pickup_location),'timeZone','Europe/Skopje'),
         'return',jsonb_build_object('date',b.end_date,'time',b.return_time,
           'locationId',b.dropoff_location_id,'locationCode',rlc.code,
           'locationName',coalesce(rl.location_name,b.return_location),'timeZone','Europe/Skopje'),
         'customer',jsonb_build_object('name',b.main_driver_name,'email',b.client_email,'phone',b.client_phone),
         'rental',jsonb_build_object(
           'currency',b.partner_currency,
           'amountPayableToPartner',b.pickup_payment_partner_currency,
           'extrasIncludedInAmount',NULL,
           'extrasBreakdownAvailable',b.pricing_items_snapshot IS NOT NULL,
           'extras',CASE WHEN b.pricing_items_snapshot IS NULL THEN NULL ELSE
             (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'code',x.item->>'id','name',coalesce(x.item->>'name_en',x.item->>'name_pl'),
                 'kind',x.item->>'kind','quantity',x.item->'quantity',
                 'amountPayableToPartner',CASE
                   WHEN (x.item->>'partner_cents') ~ '^[0-9]+$'
                   THEN round((x.item->>'partner_cents')::numeric/100,2)
                   ELSE NULL END,
                 'includedInBasePrice',x.item->'included_in_price'
               ) ORDER BY x.ordinality),'[]'::jsonb)
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(b.pricing_items_snapshot->'items')='array'
                  THEN b.pricing_items_snapshot->'items' ELSE '[]'::jsonb END
              ) WITH ORDINALITY AS x(item,ordinality)
              WHERE x.item->>'kind' IN ('extra','time_fee')
             ) END,
           'extrasMustNotBeAddedAgainToTotal',true
         ),
         'cancelledAt',b.cancelled_at,'sourcePartnerId','B61DFC7B'
       ) AS payload
     FROM public.bookings b
     LEFT JOIN public.car_classes cc ON cc.id=b.car_class_id AND cc.partner_id=v_partner
     LEFT JOIN public.partner_locations pl ON pl.id=b.pickup_location_id AND pl.partner_id=v_partner
     LEFT JOIN public.partner_locations rl ON rl.id=b.dropoff_location_id AND rl.partner_id=v_partner
     LEFT JOIN pegasus_private.location_codes plc ON plc.location_id=b.pickup_location_id
     LEFT JOIN pegasus_private.location_codes rlc ON rlc.location_id=b.dropoff_location_id
     WHERE b.partner_id=v_partner AND b.status IN ('paid','cancelled')
   ) source
   ON CONFLICT(booking_id) DO UPDATE SET
     revision=pegasus_private.export_state.revision+1,
     payload=excluded.payload,
     fingerprint=excluded.fingerprint,
     changed_observed_at=clock_timestamp()
   WHERE pegasus_private.export_state.fingerprint IS DISTINCT FROM excluded.fingerprint;

   -- Tombstones remain even if a confirmed source booking disappears.
   UPDATE pegasus_private.export_state es SET
     payload=jsonb_set(es.payload || jsonb_build_object(
       'sourceDeletionObservedAt',clock_timestamp(),'cancelledAt',clock_timestamp()
     ),'{status}','"cancelled"'::jsonb,true),
     revision=es.revision+1,
     changed_observed_at=clock_timestamp()
   WHERE es.partner_id=v_partner AND es.payload->>'status'='paid'
     AND NOT EXISTS(
       SELECT 1 FROM public.bookings b WHERE b.id=es.booking_id
         AND b.partner_id=v_partner AND b.status IN ('paid','cancelled')
     );
   UPDATE pegasus_private.export_state es SET fingerprint=md5(es.payload::text)
     WHERE es.fingerprint IS DISTINCT FROM md5(es.payload::text);
   UPDATE pegasus_private.export_control SET last_refresh_at=clock_timestamp()
     WHERE singleton=true;
 END IF;
 SELECT coalesce(jsonb_agg(page.item ORDER BY page.booking_id),'[]'::jsonb),
        max(page.booking_id)
 INTO v_items,v_last
 FROM (
   SELECT es.booking_id,
          es.payload || jsonb_build_object(
            'revision',es.revision,'lastModifiedAt',es.changed_observed_at,
            'firstObservedAt',es.first_observed_at
          ) item
   FROM pegasus_private.export_state es
   WHERE es.partner_id=v_partner
     AND (p_after_booking_id IS NULL OR es.booking_id>p_after_booking_id)
     AND coalesce((es.payload->'return'->>'date')::date,current_date)>=current_date-180
   ORDER BY es.booking_id LIMIT p_limit
 ) page;
 SELECT exists(
   SELECT 1 FROM pegasus_private.export_state es
   WHERE es.partner_id=v_partner
     AND (v_last IS NOT NULL AND es.booking_id>v_last)
     AND coalesce((es.payload->'return'->>'date')::date,current_date)>=current_date-180
 ) INTO v_more;
 RETURN jsonb_build_object('schemaVersion','1.0','partnerId','B61DFC7B',
   'revisionSemantics','observed_change','generatedAt',clock_timestamp(),
   'items',v_items,'nextCursor',CASE WHEN v_more THEN v_last ELSE NULL END,
   'hasMore',v_more);
END;
$peg$;
REVOKE ALL ON FUNCTION public.pegasus_export_page(uuid,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pegasus_export_page(uuid,integer) TO service_role;
COMMENT ON FUNCTION public.pegasus_export_page(uuid,integer) IS
 'Partner-specific read-only-source export. No shared booking triggers or mutations.';
