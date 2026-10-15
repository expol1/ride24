# Priced extras: isolated implementation checkpoint

Status: NOT DEPLOYED. No production pricing/data changes in this task.

Current starting point: dec103fcf24786b4a5a5d9481ae8fc0ce77f5175.
Preserve all seven changes made after the morning backup, including the partner
insurance entry and destination SEO changes. Do not restore the old main over them.

## Confirmed user requirements

- Separate one-off pickup/return fees by partner location; blank means zero.
- At activation, copy each existing positive local pickup fee to the initial return
  fee. Do not change free locations, API-managed prices or historical bookings.
- Partner extras: standard child seat, booster, GPS, additional driver names PL/EN;
  custom EN name with optional PL, fallback EN; quantity and per-day/per-rental price.
- Apply the existing Ride24 margin to partner fees and extras as well as rental.
  Fees/extras are partner net amounts, not rental public prices subject to a second
  partner discount. Existing loyalty discount applies to the platform commission.
- Use the existing extras modal; show total before acceptance; preserve voucher
  design and add itemized breakdown in web/client Android/partner Android.
- Store immutable pricing snapshots; changes to the catalog never reprice bookings.
- No notification tests involving real partners, no destructive cleanup.

## Durable backups

- GitHub branch backup/before-priced-extras-2026-10-15 at b2a8f602d036d8f97d1d7360dd537631022489fb.
- User downloaded/CRC-verified the corresponding web ZIP and server ZIP.
- Server backup was successfully uploaded to user's Google Drive; not full DB/Storage.
- Important: live create-booking-request contains partner-push logic missing from the
  GitHub version. Restore/capture live function before applying booking changes.
- User retains current Android client 1.0.14 (versionCode 15) and partner 1.0.5 (6).

## Checkpoint recovered after workspace reset

Pure pricing engine and its 18 tests are restored and pass. It has no production
caller. It uses integer minor units, deterministic item ordering, rejects bad
prices/quantities and supplies distinct customer/partner projections.

Earlier uncommitted SQL prototype (16 isolated PGlite access tests) and server
integration draft were lost with the workspace reset. They were not deployed and
are NOT part of this checkpoint; reconstruct/review them before relying on them.
Both Android sources have been reuploaded, CRC-checked and extracted.
Client source: 1.0.14; partner source: 1.0.5. Baseline compilation is still required.

## Required remaining gates

1. Re-obtain Android sources and a working baseline build for each.
2. Rebuild disabled-by-default schema, partner catalog ownership/RLS, immutable
   snapshots, current live booking integration and server quote/revalidation endpoint.
3. Do not charge a legacy Android client an amount it did not display/accept. Require
   upgrade/web for paid-location bookings if old version cannot render accepted quote.
4. Handle additional-driver selection coherently with a paid driver extra; do not
   silently grant the driver service for free or double-charge it.
5. Quote revalidation on price/rate/selection/date/location change; reject stale quote
   and require customer to see/accept new totals. Validate location ownership.
6. UI/PL/EN in both Android apps and web; optional extras, unavailable items and error
   recovery; preserve existing free/legacy/API reservations.
7. Voucher pagination, long names and totals; online PLN vs partner currency must not
   be subtracted as if they were the same currency. Avoid exposing partner margin.
8. Confirm Stripe uses saved total commission, loyalty, expiry/cancel/refund semantics.
9. Backfill paid-location return fees only after current backup; enable only after
   all checks. Emergency disable must retain snapshots for bookings already created.

This checkpoint is a foundation, not a production-ready feature or an Android update.

## Reconstructed backend draft (not deployed)

Disabled schema proposal, catalog/location helpers, authenticated quote endpoint and
booking revalidation are now staged. The booking function is based on live v15 and
preserves its partner-push and email-worker dispatches. SQL isolation tests and
function type-check/integration tests are still required before deployment.

## Integration draft continued (15 October, evening)

- Customer web: existing extras modal now uses a server quote, resets consent on
  selection/driver changes, blocks stale responses and network-error fallback.
- Partner web: catalog CRUD (deactivate instead of delete), separate pickup/return
  fee fields and fee editing, partner-owned item breakdown via authenticated endpoint.
- Native drafts: client quote/catalog/selection/consent and booking breakdown; partner
  net item breakdown via a separate endpoint. Original RPCs and notifications unchanged.
  Changes relative to uploaded archives are saved in proposed/android-priced-extras.patch.
- Voucher: existing first page retained; bilingual itemized payment appendix with
  wrapping/pagination, separate paid-online PLN and due-partner currency.
- Live booking triggers inspected read-only: supplied net/commission/final snapshots
  pass through unchanged; existing status/push/email triggers remain untouched.
- Checks so far: 26 pricing/quote tests; 23 isolated PGlite schema/ownership checks;
  7 web DOM/syntax tests; 4 voucher validation/pagination tests. These are not a full
  production flow test. PDF pagination visually reviewed with test fonts; final
  production font/front-page review still required.
- Java 21 and Gradle 9.5 downloaded and run. Client's existing daemon criteria require
  Java 25; preparing that baseline plus Android SDK. No native build passed yet.

Release is still BLOCKED on native builds, endpoint integration/type checking,
controlled booking/payment/cancellation testing, and a fresh pre-deploy backup.
No production schema, fees, bookings, functions or web deployment changed by this work.
