# Ride24 API integration checkpoint — 2026-11-12

Status: PARTIAL IMPLEMENTATION. This is not an end-to-end acceptance certificate.

## Deployed

- Supabase search-api v71: stable pickup/return UUID resolution, legacy name compatibility, explicit provider errors/partial response, common normalized vehicle class.
- Supabase api-partner-admin v28: canonical airport labels, provider identifiers retained, missing metadata preservation and ownership checks before writes.
- AVIA vehicle metadata: 33 existing records retained, model names populated, 28 source image URLs, 28 active variants. Five unsupported/hidden categories disabled. No booking/customer records changed.
- Temporary metadata audit function closed with HTTP 410 and JWT verification enabled.

## Prepared, not published

Web canonical labels, UUID request parameters, shared A–F category labels, representative image labeling and integration error messages. GitHub main push was rejected by automatic approval review. No alternative publication route attempted.

Concurrent upstream Smart Search/admin/guide work through d17e768 was merged locally without conflicts. Its new daily automation is separate from provider metadata synchronization; this work does not certify it or claim it implements full provider sync.

## Evidence

- Live production read-only API matrix: ZAD/ZAG/SPU/DBV/PUY, 1/3/7 days, pickup 2027-03-10 10:00: all 15 searches returned 25 offers.
- Zadar UUID and legacy-label requests returned identical offer/model/class/price identities for the compared parameters.
- Latest v71 probe: daytime 25 offers, 25 models, 24 image URLs; nighttime returns explicit SURCHARGES_REQUIRE_QUOTE error instead of a successful empty result. See adjacent verification JSON.
- Real public WWW search: Zadar, 2026-11-20 to 2026-11-23, 10:00, rendered 20 cards (UI limit). Raw airport label and technical category descriptions remain until web publication.
- After merging upstream: 87/87 selected automated tests passed (normalization, API compatibility, options, extras UI, native contract, payment return, location fee ranking, minimum rental and Georgia normalization).
- Earlier broader regression batch: 93/93. Overlaps exist; do not sum these batches as distinct tests.

## Remaining work and limits

- Selected extras and mandatory-fee quotes remain blocked by the existing API booking safety contract. Setup contains 29 service definitions but not prices. A real nighttime quote includes two separate EUR 80 charges; these cannot be silently discarded.
- Provider quote/create/cancel documentation and sandbox verification are still needed to implement priced extras without inventing fields or sending unsupported reservations.
- Seasonal/location/group minimum periods are not universally verified. Successful one-day samples do not establish year-round permission.
- APK runtime/source unavailable in this workspace. Contract tests are not APK execution or WWW/APK parity certification.
- No new full reservation/payment/voucher/email/push/cancellation E2E was completed. No real payments or production reservations made.
- Caravel and Arvent remain disabled API drafts; live regression of those adapters is not certified.
- Automatic provider schedules, incremental sync, complete extras/fees/restrictions, unknown-field admin review and future-partner alias coverage are not complete.
- Existing financial and AVIA card-policy flags were not changed. Historical no-preauthorization confirmation conflicts with the original task's EUR 1 wording; no business-policy decision was inferred.

## Recovery

Original car-class values and live search-api v69 source are in backups/api-normalization-20261112. Restore only fields/rows changed by this task after checking subsequent updates; do not blindly restore a whole table. Git preserves prior sources. Backend rollback must deploy a complete function bundle with matching shared files, preserving verify_jwt settings. Web publication has not occurred.
