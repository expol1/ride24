# Pegasus Fleet — isolated JSON export (DRAFT / disabled)

Status: design only. No production endpoint, secrets, scheduler, migrations, or modifications to booking/Stripe/API flows have been deployed.

## Isolation contract
- Scope partner UUID `b61dfc7b-a4cd-4f27-b059-517cdf4f01cf` exclusively; reject other partner IDs, never accept a client-supplied partner filter.
- Read-only access to bookings, car classes, locations and pricing snapshots. No writes to bookings, no use of API-provider booking dispatch, no Stripe changes.
- No direct dependency from checkout, payment webhook, booking acceptance or cancellation into the exporter.
- Separate authentication and rate limiting; no service-role token in Pegasus Fleet or client apps.
- Fail closed if credentials missing; independent feature flag OFF by default.
- Never publish customer PII in GitHub, logs, or sample fixtures.

## API contract proposal
`GET /pegasus-export/v1/bookings` over HTTPS. Authenticate with an independently scoped secret, server-side validation and secret rotation. Response `Cache-Control: no-store`.

Return **full snapshots** of all relevant confirmed and cancelled Pegasus bookings, with pagination and a bounded date window; never only a short-lived delta. Stable `bookingId` = bookings.id. A cancelled booking remains visible as a tombstone throughout the agreed retention period, including after missed polls. No deletion of confirmed bookings without an auditable tombstone.

Fields: schemaVersion, generatedAt, nextCursor, items[] with bookingId, reservationCode, status, revision, lastModifiedAt, category {id,code}, vehicleId:null, pickup {date,time,location}, return {date,time,location}, customer, rental {currency,amountPayableToPartner,extrasIncludedInAmount}, extras[].

**BLOCKER**: public.bookings has no updated_at or monotonic booking_version. A content hash is not a monotonic revision and does not by itself solve out-of-order imports or A→B→A transitions. Implement a reliable separate version/event journal or a proven versioned snapshot registry **without touching shared booking lifecycle**, and verify all mutation paths. If this is impossible, stop before production deployment.

**BLOCKER**: Verify exact paid/confirmed eligibility for local partner and what cancelled/expired/deleted rows survive. Validate extras semantics and amount payable to partner; never include Ride24 booking fee as partner revenue. No real Pegasus booking rows currently available for end-to-end validation.

## Integration acceptance tests
1. Only Pegasus partner rows visible; no other partners even if ID manipulated.
2. Unauthorized, expired and incorrect credentials rejected; secrets never exposed in logs.
3. Confirmed booking; modification; cancellation; duplicate import; missed polls; recovery after 24h; out-of-order import.
4. Category-only booking imports without assigning a physical car.
5. Verify rental total/extras no double count; EUR and location mappings.
6. Failures/timeouts never change Ride24 bookings or block Stripe, AVIA, Caravel, Arvent.
7. Load/rate tests and kill switch; compare booking/API baselines before activation.

Do not send this as a live API spec to Pegasus until blockers are resolved and a test endpoint is verified.
