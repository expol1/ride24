# Caravel Channel API v1.67.0 — certification readiness (Ride24)

Source: partner pack `https://sandbox-api.caravelway.com/docs/packs/caravel/` (CERTIFICATION, Webhook Receiver Guide, CHANNEL-API), read 14 Nov 2026.
**The official 24-hour run (`POST /_certification/start`) has NOT been started.** Start it only with Ride24's explicit authorization for that irreversible 24-hour certification window.

## Sandbox webhook receipt preparation — 16 Nov 2026
- `caravel-webhook-probe.ts` verifies the signature (raw body, exact method/path, HMAC and timestamp) and validates the event envelope; its test fixtures cover tampering, changed path, stale timestamps and malformed bodies.
- `caravel-sandbox-webhook-probe/index.ts` is an **UNDEPLOYED** sandbox-only Edge entrypoint, designed for `verify_jwt=false` with mandatory HMAC authentication and a strict 32 KiB request-body limit. Returns only accepted/rejected status; logs no payload, stores no personal data and never updates Ride24 reservations.
- This is only a signature/connectivity probe. It **does not** implement durable `event_id` deduplication, per-booking revision persistence or real production webhook dispatch. The hosted Caravel webhook delivery and HMAC self-test have NOT been run. Additional security review and separate authorization are required before deployment.

## Reliability and pagination readiness — 16 Nov 2026 (isolated branch only)
- `caravel-sandbox-adapter.ts` now retries **only** GET or POST with the same UUID idempotency key on HTTP 429/503 and transient network failures. Maximum three attempts, honors `Retry-After` seconds/HTTP-date, and stops rather than waiting indefinitely when the advised delay exceeds the configured bound. POST payload and UUID are identical on every attempt. 422 is never retried.
- Reference endpoints follow every opaque `meta.next_page` token with supplier scope preserved; repeated or malformed tokens, malformed page arrays and excessive page chains fail closed. `listAllBookings()` now walks all pages of the status reconciliation list while retaining `updated_since`.
- New mock-only tests in `tests/caravel-reliability.test.mjs` cover 429, 503, unchanged idempotency keys, long `Retry-After`, 422, opaque token characters, reference paging and booking paging. The tests are run by the PR's Caravel CI workflow.
- **Not yet confirmed on live Caravel certification:** actual pagination token responses, 429/backoff trace and registry metrics. No deliberate rate-limit bombardment has been attempted.
- **Still missing before certification:** evidence for 401/403/404 families, rejected expired quote, direct-booking expected-price guard, webhook live delivery and HMAC self-test. The actual 24-hour certification has not been started.

## Negative-case test coverage update (16 Nov 2026)
- Added `tests/caravel-certification-edge.test.mjs`, included in GitHub Actions. This suite mocks upstream 401/403/404/409/422 envelopes and verifies error-code/status preservation and no retry; unknown error codes stay unknown instead of being guessed.
- A mismatched opaque `page_token` gets a mocked `422 malformed_page_token` response without retry or supplier-scope changes. This is **not** a live cross-endpoint pagination test.
- The Caravel booking draft rejects an expired quote including the exact expiry instant **before** any provider write. This is local application-side protection, **not** the Caravel upstream `quote.expired_rejected` metric.
- Existing `caravel-reliability.test.mjs` covers HTTP 429/503 backoff, bounded `Retry-After`, same idempotency key on retried POST, and all-page reads. Live measurement still required; never force a 429 by excessive traffic.
- Do not implement the `expected_price` direct-booking endpoint or claim its guard until the exact Caravel OpenAPI request schema is accessible and verified. The quoted-create flow remains Ride24's default.

## Readiness update after source-document review (16 Nov 2026)
- Current specification checked against the partner's bundled v1.67.0 documentation (HTML export). The official run has not started.
- Live tests on 16 Nov: EUR and GBP **25/25** steps each, `failed: false`. The conflict on an **active** booking returned 409 `revision_conflict`; the booking stayed confirmed at revision 1, then cancelled correctly at revision 2, fee 0, and the function was returned to HTTP 410.
- New isolated rehearsal code supports the six gating scenarios as described, plus non-gating phases. Mock tests cover unknown location types, two freshly catalogued vehicle IDs, a GET after cancellation and the reference shrink/return sequence.
- **Important correction:** in `shrunk-reference-refresh:1` the vehicle is removed from refreshed catalogue and search results, yet must be quoted using a **baseline-persisted** record; in `:2` it returns and must remain the same record under the original ID. This is now how the code and tests behave.
- A private Supabase Storage reference-state adapter and an independent admin-only rehearsal endpoint were added to PR #84. **Neither the bucket nor the endpoint has been deployed**, and no production tables were touched. See `caravel-cert-sandbox-store.md`.
- Code-only CI success does not prove the 24-hour hosted run will pass. The true gating changes are injected only during a real active run; some rehearsals need saved mutated responses.

## Important remaining evidence and setup before certification
- Private reference bucket and rehearsal endpoint require separate explicit activation and JWT/admin checks. The old acceptance function must remain closed.
- Verify the full ten-phase flow against an actual injected run before pressing `/_certification/start` (no skipping or inventing evidence). A phase without observed follow-up traffic is inconclusive.
- Additional registry checks still pending: status families, pagination and token binding, expired quote, direct-price guard, 429 and Retry-After with a stable idempotency key, and live webhook delivery. HMAC fixture verification was local only; `/_certification/hmac-self-test` was not invoked.
- The sandbox-only medium served plan in `opaque-id-tolerance` must be QUOTED, never booked or published to Ride24 customers.

## Current acceptance evidence — 16 Nov 2026
- Isolated admin-only Supabase function was deployed for live tests, then replaced by `closed.ts` (HTTP 410 with valid admin JWT; 401 without auth); production integrations remained untouched.
- Real sandbox EUR (`acct_eaa0…`) and GBP (`acct_a714…`): **23/23 steps OK for each supplier**, `failed: false`; Premium `INS_PREMIUM` quote + booking + idempotency replay + status read + cancel + idempotent second cancel. No active test bookings remain.
- Quote/booking amounts reconciled: EUR 132.00 / GBP 114.00; `booking_id`, `quote_id`, currency, confirmed revision 1, cancelled revision 2 all verified.
- Sandbox Premium intentionally has nonzero deposit/excess and absent optional coverage fields. Caravel confirmed these are fictional fixtures shared by all partners. Ride24's production publishability guard correctly refuses them. Production must independently confirm Premium plan, included protection, EUR and VAT inclusive, deposit/excess/theft excess zero, and populated covers/excludes.
- `Booking.payment` is optional when payment model was defaulted; Ride24 sends `pay_on_arrival` explicitly and rejects contradictory present payment details.
- Active-booking **revision_conflict 409** probe was added to the isolated acceptance harness on 16 Nov and mocked; a live run of that new step remains pending.
- Local test suite and CI were green at `64770501e` (108/108 local Caravel tests). Never equate mocked tests with the official certification outcome.

Older evidence below is retained as dated history; references to pending live booking tests or pending Premium sandbox fixtures describe the state on **14 Nov**, not the current state.

## Prerequisites (CERTIFICATION.md "What you need first")
| Prerequisite | Ride24 status |
| --- | --- |
| Full sandbox flow capabilities → reference sync → availability → quote → book → cancel | Implemented in `tests/caravel-live-sandbox.mjs` for **every** supplier the key holds. Verified only on a local mock so far; real run pending (see blockers). |
| Key on every request, `GET /v1/capabilities` included | Yes — `CaravelClient.request()` always sends `X-API-Key`. |
| Base URL is configuration | Yes — `CaravelClient({environment: "sandbox" \| "production"})`; production needs `allowProduction`, production bookings need `allowProductionBookingWrites`. |
| Reference sync on demand; quote a specific vehicle from the synced catalogue | Yes — reference merge store (`caravel-reference-sync.ts`) and the "served plan, ids from reference sync" quote step. |
| Two suppliers walked (search, quote, booking each) — gate `suppliers.every_supplier_exercised` | Harness loops over `GET /v1/suppliers`; the live account holds 2 suppliers (EUR + GBP, confirmed by the 13 Nov diagnostics). |
| Webhook self-test | HMAC verifier passes Caravel's published fixture (`tests/caravel-stage1.test.mjs`). No receiver is deployed; the portal's sandbox inspector captures events. |

## Ten phases (six gating scenarios)
| Phase | Gates | What Ride24's client does |
| --- | --- | --- |
| baseline | – | Full flow incl. booking + cancel with invented data. |
| unknown-enum-value | **yes** | Unknown values never throw: location `type` outside the map is kept in the merge store; it is only not published (`LOCATION_TYPE_UNVERIFIED`). Quoting continues. |
| unknown-error-code | **yes** | `CaravelError` carries any `code`; unknown codes map to action `stop` (generic degrade). The harness marks the first failed locations read as DEGRADED and reads again on the next sync (a 422 is not retried in place). |
| unknown-response-field | **yes** | Readers take documented fields only; request bodies are built field by field (quote, booking, cancel) — nothing from a response is copied back. |
| unknown-feature-code | **yes** | `capabilities` features are not interpreted beyond `environment` / `api_version`. |
| opaque-id-tolerance | **yes** | Ids are stored as served, never parsed; the harness re-syncs and quotes the served plan (no `plan` named) with a `protection_id` from the fresh `GET /v1/reference/protections`. A renamed vehicle is the same record. |
| shrunk-reference-refresh:1 / :2 | **yes** (one scenario, both stages) | `mergeCaravelReference()` never deletes: a missing record keeps its id and `missing_since`; when it returns it is the same record. |
| deprecation-notice | no | Routes are kept; no behaviour depends on Deprecation/Sunset headers. |
| version-format | no | Ride24 never sends `X-API-Version`, and does not parse `api_version` as major.minor.patch. |

## Evidence status
- **Real API, 14 Nov 2026 (admin-only `caravel-sandbox-acceptance` v1, code pinned to commit f30c9ce), both suppliers:**
  - EUR `acct_eaa0…` (Europe/Athens, 2 desks, 4 vehicles) and GBP `acct_a714…` (Europe/London, 3 desks, 2 vehicles): capabilities, whoami, suppliers, constants, reference locations / policies / vehicles / protections / extras / fees, served-plan quote from reference ids, day + night availability, unknown-vehicle refusal (422 `validation_error`, `vehicle_id:unknown_vehicle`), Premium-plan quote, idempotent quote replay (same `quote_id`), key reuse with a different body (**422** `idempotency_key_reused`, not 409) — all as expected, `failed: false`.
  - Ride24 normalization on live data: every desk and vehicle normalized; quotes reconcile line items to `grand_total` (EUR 132.00 / GBP 114.00 for 3 days, tax inclusive); out-of-hours fee priced by Caravel at night (EUR 30.00 / GBP 18.00) and the desk-hours check flags the same ends.
  - **Premium blocker:** every `premium` row fails the Ride24 policy — deposit EUR 300 / GBP 250, excess above zero, `theft_excess`, `product_type` and `covers` not stated. With `booking: true` the function therefore booked **nothing** at either supplier (by design).
  - Extras: EUR "Child seat" (5.00/day) and "Additional driver" (0/day), GBP "Child seat" (4.00/day) and "Winter kit" (0/day) — all category `other`, so not mapped to Ride24 codes.
- **Real API (13 Nov 2026, admin-only read-only diagnostics function):** capabilities, whoami, suppliers (2), reference locations / policies / vehicles / protections / extras / fees, availability day + night — all 2xx for the first supplier.
- **Not yet observed on the real API:** quote, booking, replay, 409s, cancel, second supplier walk, served-plan quote. These need a server-side run with the key (blocker 1).
- **Simulated only (local mocks / fixtures):** everything in `tests/caravel-*.test.mjs`; the full two-supplier harness on `scripts/mock-caravel-two-suppliers.mjs` (scratchpad, not committed).

## Stage 1b (14 Nov 2026) — ready for Caravel's answer
- **protection_options:** a Premium row is checked with its included package and every bookable `protection_options` package (`caravelProtectionCandidates`, `selectCaravelPremiumProtection`). Only a package that passes the Premium policy on its own data is quoted, and it is published only when the final quote confirms it (zero quote deposit, the protection line priced in the quote, totals reconciled). The Premium-only rule is unchanged.
- **Diagnostics:** every Premium row reports, per package, exact `excess` / `deposit` / `theft_excess` minor units, `product_type`, `covers` / `excludes`, `missing_fields` and the rejection codes (`describeCaravelProtection`). No personal data.
- **Extras mapping:** `CARAVEL_CONFIRMED_EXTRAS_MAPPING` (empty) takes entries keyed `<supplier_id>:<extra_id>` / `:code:` / `:supplier_code:` only after Caravel confirms them; category `other` is never mapped by name.
- **Rental bounds:** billed `rental_days` must sit inside the operator's `min_rental_days` / `max_rental_days`; availability reports `unsellable_window` / `unsellable_movement` / `unsellable_ends`.

## Remaining gates before the official 24-hour run
1. Confirm live active-booking `revision_conflict` behavior on both sandbox suppliers using a wrong positive `expected_revision` **before** the real cancellation; verify the booking remains confirmed, then cancel it and shut the test function (401/410).
2. Recheck the official `CERTIFICATION.md` prerequisites and HMAC self-test interface with the partner pack; the `opaque-id-tolerance` certification phase MUST send **no plan** and use a fresh `protection_id` from `GET /v1/reference/protections` (served Medium in sandbox only). All bookings remain Premium.
3. Obtain Ride24's explicit authorization to start `POST /_certification/start` and complete the subsequent run in the 24-hour limit. Do not start merely because CI passed.
4. After passing certification, request production access in Caravel portal and verify EVERY production Premium availability/protection row before exposing offers; keep partner `api_enabled=false` until the AVIA shared-flow integration is safely complete.
