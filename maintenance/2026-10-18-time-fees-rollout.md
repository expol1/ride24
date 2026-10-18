# Ride24 mandatory time fees — change plan (18 October 2026)

## Goal
Retain the existing UX: rental search prices are not changed. Obligatory
pickup, return and time surcharges appear in the full quote just before
"Potwierdzam i rezerwuję". Seat, GPS, driver and other opt-in extras stay separate.

## Existing facts
- Montenegro NOVAKOVIC already uses `partner_locations.extra_fee_amount` and
  `return_fee_amount`. Keep both as-is.
- Portugal Mountain Calendar/Madlobos has 50 EUR, 22:00–07:00, **pickup**,
  billed once per booking, currently a selectable `partner_extras.custom`.
- Auto Ilhéu (Azores) has separate conditional pickup (19:45–23:45) and
  return (05:00–07:00) rules; its return before 05:00 is stated to be
  unavailable. Do not migrate those conditions automatically until the
  unsupported-hours block is implemented and confirmed with that partner.
- Madeira airport transfer (15 EUR) and mainland one-way return (120 EUR)
  remain conditional custom extras until a clear location/pair rule is agreed.

## Deployment (must be coordinated, not automatic)
1. Apply the additive `partner_time_fees` migration (no rows, no price change).
2. Deploy matching `_shared/booking-items.mjs`,
   `_shared/booking-options.mjs`, `booking-options`, and
   `create-booking-request` together with all transitive dependencies.
3. Publish WEB: `partner-dashboard.html`, `partnerExtras.js`,
   `partnerTimeFees.js`, and shared booking breakdown helpers.
   Existing search page and result card prices remain unchanged.
4. Verify local 12:00 and 23:30 quotes, unchanged optional extras, old-app
   fail-closed response, Stripe checkout, partner cash amount, vouchers,
   both WEB and Android client and partner booking detail screens.
5. Only after validation execute `2026-10-18-madeira-time-fee-cutover.sql`
   in one transaction. It inserts the new automatic rule and disables the
   matching optional 50 EUR custom extra. No earlier booking snapshots change.
6. Confirm production booking quotes for Mountain Calendar show the amount
   exactly once; test at 21:59, 22:00, 06:59, 07:00 local time.
7. For additional partners, set up rules explicitly through the partner panel.
   Confirm charging basis and location specificity before moving custom rows.

## Risks and safeguards
- Search results intentionally remain unchanged; fees are displayed before
  final consent/booking. The backend is the single source of pricing truth.
- Times are local wall-clock times in each selected location, not UTC. Rules
  use a half-open interval: start inclusive, end exclusive; wrap at midnight.
- A rule with `applies_to=either` and `once_per_booking=true` adds one
  charge even if pickup and return both fall inside the window.
- Old Android clients cannot bypass new mandatory time rules: v1 booking
  requests for a partner with active rules are rejected with
  `PRICING_UPDATE_REQUIRED`, even for daytime pickups. Do not activate
  before supported app versions are broadly available.
- API partners are excluded; their own provider quotes remain authoritative.
- Do not activate timed fees on production before checking existing Android
  native parsing of `kind: time_fee` on physical devices and cash/voucher math.
- Current WEB v2 emergency-disable button state assertion is a pre-existing
  failure documented in `maintenance/2026-10-16-android-extras-followup.md`.
  Revalidate that separately before release.
- On rollback deactivate the `partner_time_fees` rule and reactivate
  the corresponding old custom row together in a single transaction; do not
  roll back the entire database. Existing booking snapshots stay immutable.
