# Ride24 mandatory fee cleanup – staged, auditable rollout

## Intended UX
Do not change result-card rental prices. Mandatory night pickup/return and conditional location/one-way surcharges belong in the existing full quote just before "Potwierdzam i rezerwuję". Optional child seats, GPS, Wi-Fi, extra drivers and voluntary cross-border permission remain in the extras picker. WEB and Android use the same server-side price and saved snapshot.

## Existing database and audited changes (2026-10-18)
- **Montenegro NOVAKOVIC**: existing pickup and return location fees are correct and untouched.
- **Portugal Mountain Calendar / Madlobos**: pickup 22:00–07:00 at 50 EUR, once per booking; Madeira Airport transfer 15 EUR once when airport is pickup or return; one-way cross-city return 120 EUR only when pickup and return cities differ AND both are Lisbon, Porto or Faro.
- **Azores Auto Ilhéu**: 15 EUR only for airport pickup 19:45–23:45; 25 EUR only for airport return 05:00–07:00; Ponta Delgada Airport (PDL) unavailable for pickup 23:45–07:00 and return 23:45–05:00. These are the documented special windows plus the user's instruction that the airport closes; do not impose unsupported restrictions on office/city pickup points. Partner official regular hours outside these windows still need confirmation before defining a complete office schedule.
- **Italy Cosmo**: pickup 00:01–08:00, 50 EUR once per booking.
- **Cyprus Laima**: pickup or return 20:00–06:00, 25 EUR once per booking.
- **Bulgaria STAR**: the two adjacent 20 EUR custom extras have one combined 19:40–08:30 rule. Charge per matching pickup and/or return event, each 20 EUR; booking still requires partner approval.
- **Albania Sleid**: 100 EUR permission for travel to Montenegro or North Macedonia is not inferable from pickup/return locations. Leave it opt-in; do not force it on all Tirana/Durrës bookings.
- **Test profile tets**: leave its artificial custom product unchanged; exclude test profile from commercial cleanup.

The all-partners cutover moves exactly nine existing custom extras to server-authoritative rule types (7 time-based rows incl. Bulgaria's 2 for one unified fee, and 2 conditional Portuguese rows). Original rows are deactivated, not deleted, and the exact previous values are preserved in `partner_fee_migration_audit`. No historical booking, location fee or Stripe data are updated.

## Ordered deployment
1. Save source backup branch, inspect live Edge Function source against GitHub `main`.
2. Apply `20261018193000_partner_time_fees.sql` and `20261018211000_conditional_fees_and_closed_hours.sql` to Supabase. Both are additive.
3. Deploy matching `booking-options` and `create-booking-request` plus the shared modules as a coordinated update; preserve each function's JWT and import-map setting.
4. Publish WEB partner dashboard, helper modules and price summaries. Run CI, manual/Android compatibility tests.
5. Execute **only** `maintenance/2026-10-18-all-partners-fee-cutover.sql` in a transaction. This covers Azores closed hours and all eligible partners; do not also run any earlier Madeira-only script.
6. Verify database counts, detailed partner rows, all unchanged location fees, old extras disabled, feature flag still on, and application quote fingerprint behavior. Confirm booking, Stripe and voucher correctness on controlled QA flows; do not make a real purchase automatically.
7. Rollback if necessary by disabling new rules and reactivating archived extras using `partner_fee_migration_audit` in a single transaction. Do not overwrite whole DB or historical snapshots.

## Controls
- Server quotes and booking submissions use a matching authenticated fingerprint; older native versions cannot silently bypass applicable mandatory charges. Older Android may require an update for partners that have active rules; show a clear update/WEB path.
- API-managed partners remain on their own provider pricing, no extra local rules.
- Changing dates/hours/locations requires a fresh quote. Closed hours fail with typed bilingual pickup/return errors (no surcharge can override).
- Charge inputs are partner NET; Ride24 applies the same platform pricing logic used for location fees; loyalty adjusts the platform component, not partner earnings.
- The pre-existing WEB emergency-disable button-state test still needs separate QA before shipping. Verify on both desktop and Android physical devices.
