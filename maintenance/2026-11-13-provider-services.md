# Provider-calculated services — 2026-11-13

Renteon Aggregator documentation located at https://aggregator.renteon.com/swagger/docs/v1. `/create` returns an unsaved BookingModel; services are selected with IsSelected and Quantity and priced with `/calculate`. Only `/save` persists a booking.

Implemented: reconciled mandatory charges in availability; provider-priced service catalogue and quantities; driver-based recalculation; account/driver/selection-bound quotes and consent fingerprint; common Ride24 pricing snapshot for booking summary, partner items and EN/PL voucher; recalculation before provider save; exact supplier identifiers retained. The existing rental discount/margin/loyalty/PLN conversion model remains in use. No new schema or local-partner tariff changes.

Evidence: real sandbox reference 26-ATH-205, two baby seats, additional driver, EUR 148.80 supplier total, confirmed, status read, cancelled through shared Ride24 adapter. AVIA unsaved night quote: 25 offers; one baby seat, driver age 22, additional driver age 35, both out-of-hours fees. Supplier total EUR 456.65; selected services sum exactly to it. No production booking or payment created. 41 targeted tests passed before deployment (provider service reconciliation, selection limits, ownership, changed drivers, consent, common voucher validation, existing local/API contracts and web extras UI).

Deployed backend: booking-options v9, create-booking-request v27, api-booking-dispatch v27, search-api v73. Original JWT modes preserved: true for first two, false with existing handler authentication/rate limiting for last two. Temporary sandbox acceptance function closed (v8, JWT required, HTTP 410).

Limits: Android source/runtime is not accessible; this does not certify native APK. An age-24 AVIA policy discrepancy (supplier 18–23 vs agreed 18–24) blocks options quote pending provider confirmation. Unmapped UNSPECIFIED optional services and insurance changes are not selectable. Seasonal/route restrictions remain provider-authoritative. Full payment, real-device push and customer email E2E are not certified. Caravel/Arvent live integration is not certified by these changes.

Rollback: restore task-owned code from prior main 5f2946f and matching complete function bundles; preserve subsequent/concurrent edits and original verify_jwt modes. Local predeployment complete function backups are retained in sibling live-backup/options-*.json. No table restore is needed.
