# Ride24 — City Rent Green Card fee (2026-11-17)

## Live configuration
- Only City Rent / AD GROUP d.o.o. Mostar, partner 888143c9-3c3b-4192-8066-21ca3620dc4e, currency EUR.
- Optional custom partner extra, id d6fbe6cc-4399-4f41-a584-ea6bd3421d9f.
- Source price: EUR 10 per billed rental day, limited to EUR 100 *partner net* per booking.
- Standard Ride24 platform margin applies to the **capped** partner fee; currently 10% across this partner's active car classes. At the 10-day cap, partner gets EUR 100 and customer pays EUR 110, with EUR 10 retained by Ride24 as part of the online booking fee.
- Cross-border driving still requires explicit partner authorization; the optional service is not itself border clearance.

## Server-only implementation
- Added nullable `partner_extras.max_total_amount` with a check that capped extras are daily and max_quantity=1.
- The regular `partner_extras` row remains daily EUR 10 and active, visible in Partner Extras.
- `_shared/booking-options.mjs` loads the cap from the database. `makeBookingQuote` converts only capped rows to a single quote line with `billing='rental'` and `amount=min(days * amount, max_total_amount)`. All ordinary extras remain unchanged.
- Same shared module deployed to **both** Supabase Edge Functions `booking-options` (v19) and `create-booking-request` (v35), preserving other deployed files and JWT settings. Both must stay in sync.
- Existing Android/WWW customer apps consume the standard server quote and selection as a one-time item. No APK/WWW UI edit needed. Snapshot, fingerprint, online commission and voucher follow existing v2 flow.
- No bookings were created in deployment. Live authenticated end-to-end selection has not been run.

## Rollback
- Immediately disable only this extra by setting `partner_extras.active=false` for the ID above. This preserves prior booking price snapshots.
- If rollback of code is required, redeploy the previous module bundled with Edge Functions booking-options v18 and create-booking-request v34, preserving the rest of each live function bundle; the nullable DB column can remain.
- No feature flag for other partners needs changing.
