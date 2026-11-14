# Pegasus Fleet — Operator and Integration Guide (EN, DRAFT)

**Status: NOT LIVE.** Ride24's Pegasus JSON export is a development prototype only. No production endpoint or credentials are available yet. Do not configure scheduled imports against production until Ride24 explicitly confirms readiness and the joint tests pass.

## 1. Reservation acceptance is still required in Ride24
Pegasus keeps its existing free Ride24 Partner Account. A new customer booking enters Ride24 as `pending`. An authorized Pegasus operator must open the Ride24 Partner App or Partner Dashboard, review availability and accept or reject the request within the displayed deadline. Accepting changes its status to `awaiting_payment`; this is **not yet a final confirmed rental**. The customer must then complete the separate Ride24 booking-fee payment. Only after Ride24 records status `paid` is the booking eligible for Fleet export. A rejected, pending or awaiting-payment booking is not exported as a confirmed booking. **Do not treat a Fleet import as acceptance in Ride24.**

## 2. What Pegasus manages in each system
- **Ride24:** vehicle categories, published prices, available dates, location settings, acceptance/rejection of incoming requests and the Ride24 payment-confirmation workflow.
- **Pegasus Fleet:** imported confirmed bookings, operational scheduling, assignment of a specific physical car, pickup/return workflow.
- Ride24 books a **vehicle category**, not a guaranteed individual registration/vehicle. Fleet should leave vehicle assignment empty until Pegasus staff select an available car in that category.
- Rental charges payable to Pegasus are separate from the Ride24 booking fee. Fleet must not treat the Ride24 fee as rental revenue or add extras twice.

## 3. Intended automatic import (after implementation)
- Fleet will fetch the dedicated HTTPS JSON endpoint with a secret sent in a request header, using server-to-server communication only. Never put credentials in frontend/mobile apps, URLs, screenshots, emails, or chat.
- Initial proposed interval: **every 5 minutes**, subject to load testing and final confirmation.
- Paginate until the full result set has been retrieved. Match bookings by immutable Ride24 `bookingId`; import must be idempotent.
- On later imports update the existing booking, not create a new one. Cancelled records must cancel/flag the matching Fleet booking.
- Reject older versions once Ride24 provides a verified monotonic revision. A temporary prototype returning null revisions is **not suitable for live import**.
- Fleet should retain a local import log and alert on repeated failures. After an outage, re-fetch all relevant pages and reconcile all bookings before normal operation.

## 4. Security and test requirements
- Read-only, Pegasus-only scope; no access to other Ride24 partners.
- HTTPS and independent authentication; rate limiting, secret rotation and logs without sensitive personal data.
- Validate synthetic booking creation, modification, cancellation, duplicates, out-of-order responses, missed imports, offline recovery, currency and extras accounting.
- No Fleet error may delay or block Ride24 booking acceptance, payment or other suppliers' API flows (including AVIA and Caravel).
- The live endpoint, credentials and exact schema will be delivered securely **only after** the export's revision/change tracking and cancellation-retention design passes tests.

## 5. Important operational rule
**Until Ride24 explicitly announces a different workflow, Pegasus staff must continue accepting every new Ride24 booking in the Ride24 Partner App or Partner Dashboard.** The JSON export does not remove or automate this approval step.
