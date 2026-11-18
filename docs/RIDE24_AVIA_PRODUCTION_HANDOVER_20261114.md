# Ride24 AVIA API — production handover and verified limits (2026-11-14)

**Project** Supabase `zwyerdeuvyzgkgwglowr`; GitHub `expol1/ride24`.  
**Status** The payment-first production workflow is deployed and enabled, AVIA API partner is enabled, and live Stripe Checkout/webhook configuration has been verified read-only. **No actual successfully charged LIVE Ride24 → AVIA end-to-end booking has been observed yet.** Do not relabel this last acceptance step as passed.

## Verified production facts

- PR #88 merged at 2026-11-14 11:20:47Z, merge commit `f05746e05042fdc4c9d3330ad75799159e8cc8a7`.
- Supabase payment migrations `20261114110526`, `20261114111238`, `20261114112855` installed; `api_payment_settings.enabled=true`.
- AVIA partner `91e04805-31da-4242-9e6f-b6075019d784`: `api_provider=renteon_aggregator`, `api_enabled=true`, `active=true`, 28 active vehicle groups.
- Exact deployed entrypoint source equals GitHub `main` for: `create-booking-request` v32, `create_checkout_session` v86, `stripe-webhook` v88, `api-booking-dispatch` v34, `api-booking-status-sync` v29, `generate-voucher` v132, `email-worker` v90, `client-cancel-booking` v28.
- Existing cron jobs: `ride24-api-booking-status-sync` and `invoke-email-worker`, both every 5 minutes, enabled. Email log in last day: 2 sent, 0 queued, 0 failed at check time.
- The **LIVE** Stripe account (distinct from the previously connected TEST account) was verified from the Edge server via readonly `GET /v1/account`: `acct_1TEm7p67UAIA6d2h`. `STRIPE_SECRET_KEY` starts `sk_live_`; `STRIPE_WEBHOOK_SECRET` exists and starts `whsec_`; exact production webhook `https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/stripe-webhook` is enabled on Stripe LIVE, `we_1TIUq767UAIA6d2hyuhAYMkg`, with `checkout.session.completed` and `checkout.session.expired`.
- LIVE Checkout smoke (unpaid): `cs_live_ac6OPXUHPZcbFUPl0u0Re9uTLSv472f9OBhRv89VF6VwsHIqC1EZdWvkSl`, amount PLN 12.34, initial `open`, final `expired`, `payment_status=unpaid`. This proves live checkout API reachability and expiration, **not** a live paid ride.
- Isolated Stripe TEST checks previously passed: successful PLN 12.34 PaymentIntent, full PLN 12.34 refund, verified signed webhook events, Checkout session creation and expiration. Isolated Renteon `demo` save/status/cancel accepted, supplier ref `26-ATH-207`. Those are **separate** acceptance checks, not a combined paid live/TEST booking.
- PR #88 GitHub Actions: 5/5 suites passed; API compatibility 248/248, 0 failed, 0 skipped.
- Old manually tested AVIA references `26-P2-8302` and `26-P2-8303` are soft-cancelled both in Ride24 and acknowledged via supplier cancellation path. Preserve audit tombstones because they have `cs_live_` IDs, until Stripe live settlement readback/retention is reconciled. No workflow rows marked paid.

## Booking architecture and remaining verification

- Only Ride24 booking fee (PLN) goes through Stripe; supplier rental amount remains payable to the provider on collection for standard AVIA terms.
- Stripe paid event must be signature-verified, mode/amount/session/owner-checked and recorded before supplier reservation. Revalidate supplier **category**, price, terms, dates, location and extras after payment. Do not bind representative model/photo.
- Confirm supplier reference and category before marking paid/publishing voucher. Definitive failure => fully refund the Ride24 fee. Unknown save => manual review; no duplicate reserve/refund.
- Existing API core is reused for every future provider. **Current paid adapter registry supports only `renteon_aggregator`.** Other APIs (e.g. Arvent, Caravel) still need adapters and actual acceptance before `api_enabled=true`. They do not need a new Stripe/checkout/voucher business model.
- Master standard: `docs/RIDE24_API_PAYMENT_FIRST_PARTNER_STANDARD.md`.

## Explicit remaining gate

A **real customer-authenticated, successfully PAID live Checkout → persisted `api_booking_workflows` → verified AVIA supplier reference → paid Ride24 booking → generated voucher → notification** has **not** yet been observed. It requires a deliberate live paid booking by an authorized tester or actual customer (a valid real payment method), and is not interchangeable with a live unpaid Checkout smoke. If fulfilling via a test live booking, agree with provider on cancellation first and verify both Stripe refund and supplier cancellation; do not generate a real reservation without awareness of possible fees or obligations.

The user has chosen to handle new Android changes separately. Before promoting APK compatibility claims, test the existing Android path independently.

## Security cleanup

- Temporary LIVE read-only readiness helper `ride24-live-final-readiness-20261114` was closed with JWT enabled and static HTTP 410 code after verification.
- The temporary Stripe TEST acceptance/webhook helpers were also previously closed with JWT-protected HTTP 410.
- No production credentials exposed to the client or this report.
