# Ride24 API partners — mandatory payment-first integration standard (production)

Status: **mandatory shared booking contract**. Baseline: merged PR #88, Supabase project `zwyerdeuvyzgkgwglowr`.
This specification applies to AVIA and **every future API partner**. Only the provider-specific translation/adapter changes. Do **not** fork the booking lifecycle, payment system, or voucher flow for each rental company.

## 1. One shared lifecycle

1. Search provider availability and quote **vehicle group (SIPP/ACRISS)** with the actual pickup, return, exact period, mileage, protections, fees, extras, minimum rental, ages and locations.
2. Present the provider's rental price separately from the Ride24 booking fee. The supplier rental is paid directly to the rental company at collection unless an explicitly approved and separately implemented exception exists.
3. Create internal API cart as `awaiting_payment`. **No supplier save/reservation before paid Stripe.**
4. Authenticated server-side Stripe Checkout charges **only the Ride24 fee in PLN**, with the authoritative database amount, matching customer and booking; never accept a frontend amount. The payment must match signed LIVE webhook, retrieved Checkout session, currency, amount, account mode, booking ID, payment-intent ID and session ID.
5. Record payment atomically and idempotently. Revalidate provider live availability, original group, dates/times, locations, **total supplier price**, contractual terms and selected extra quantities. Representative model name/photo can vary without invalidating the same category.
6. Supplier save **exactly once**. Any uncertain timeout/unknown save must go to manual reconciliation, not an automatic retry.
7. Publish `paid` reservation and voucher/email/push **only** after the supplier confirms the same binding. The voucher shows booked group and allows an equivalent vehicle or complimentary higher-category upgrade; never a downgrade or unapproved extra charge.
8. If fulfillment definitively fails **without an existing supplier reservation**, refund the Ride24 fee to the original Stripe payment method using a stable idempotency key; notify the customer. Ambiguous outcomes require manual review, not a blind refund or duplicate booking.
9. Preserve supplier reference, payment audit trail, customer cancellation rules, supplier status polling, and reconciliation in the same Ride24 tables and workers as AVIA.

## 2. Provider adapter acceptance contract

Every API provider must implement the existing Ride24 paid-fulfillment adapter boundary with **four verified capabilities**:
- `availability/quote`: fresh category availability and binding terms, period totals and options;
- `revalidate`: compare actual provider live state to accepted immutable booking/quote after the verified Stripe charge;
- `create`: submit one idempotent provider reservation, return an authentic supplier reference; on uncertain save, never issue an unguarded second call;
- `status`: retrieve and verify the exact supplier reference, confirmed category, dates, locations, total, and options; plus verified cancellation for the existing ordinary Ride24 cancellation pathway.

If the provider uses a different API (Arvent, Caravel, etc.), translate its methods and fields **inside the adapter**, not in Checkout, shared webhook, CRM, vouchers or the customer booking flow. Do not enable the partner until this contract passes. In current baseline, `hasPaidFulfillmentAdapter` allows `renteon_aggregator` only; other API providers are **not automatically compatible** just because their API is connected. They must be added to the validated adapter registry after implementation and tests.

## 3. Mandatory acceptance for each future API partner

- Real **isolated** provider sandbox: quote, selected options, category substitution, save, status and verified cancellation.
- Confirm no deposit/credit card requirements, insurance/excess rules, included services and exclusions, currency, cancellation, optional extras and minimum rent. Publish accurate exceptions, don't silently assume AVIA terms.
- Signed Stripe TEST webhook, successful and failed payment, paid-then-provider-unavailable full refund, duplicate webhook, timeout without reference and retry/reconciliation, expired Checkout, and voucher/email.
- Production initial smoke with explicitly authorized real payment; do not claim real-payment end-to-end acceptance from unit tests alone.
- Preserve partner-account/manual booking flows and native Android contract. Every new API adapter requires compatibility tests and rollback controls.
- Use `api_enabled=false` for rollout gating. Never change an existing production provider to `demo` to test it.

## 4. Invariants enforceable in source

- Existing shared core: `supabase/functions/_shared/api-payment-flow.mjs`, `api-payment-runtime.ts`, `api-provider-fulfillment.ts`, `stripe-webhook/index.ts`, `api-booking-dispatch/index.ts`, `api-booking-status-sync/index.ts`.
- Supplier adapters: `provider-adapters.ts` and corresponding provider-specific module(s).
- Provider gate: `hasPaidFulfillmentAdapter` in `api-provider-fulfillment.ts`; no fallback to legacy unpaid dispatch for API partners.
- Single source of truth: `api_booking_workflows` and paid-provider reference, never frontend state.
- Security: provider credentials remain server-side Vault/Edge secrets; never expose through browser, APK, client log or Checkout metadata.

**Operational decision:** New API partners inherit the **same customer and payment lifecycle** as AVIA, but they still require supplier-specific field mapping and acceptance. This is normal adapter work, not a new checkout or separate payment system. Never claim unsupported API methods are plug-and-play.


## 5. Two protected business flows and controlled exceptions

**Permanent default for all API partners (`partners.provider_type='api'`):**
`Stripe Ride24 fee → Stripe signed/retrieved payment confirmation → fresh supplier quote and terms → exactly-one supplier booking for the chosen vehicle group → supplier-confirmed Ride24 voucher`.
This is one central business workflow, never duplicated separately per API partner. A future supplier-specific adapter must implement the verified contract in section 2. Supplier rental payment remains payable directly to the provider on collection unless a separately approved exception exists.

**Permanent default for ordinary Partner Account / manually managed partners (`partners.provider_type!='api'`):**
Keep the existing partner request flow, notifications to partner via email and Android Partner App push, partner acceptance, subsequent Ride24 booking-fee collection and voucher according to existing rules. Do not alter their Stripe timing, partner status, cancellation/acceptance, vouchers or manual handling merely to integrate an API partner. The API-only paid-before-supplier-dispatch path must never intercept or modify these local reservations.

**Exceptions:** Only the Ride24 owner can explicitly approve a partner-specific deviation. Document its business justification, provider scope, settlement rules, tax/payment implications, security, test cases, cancellation/refund path and rollback plan in a separate, reviewed change. Default is **no exception**. A partner asking for a prepayment, unusual voucher or alternative payout does not authorize silently bypassing the shared Stripe-to-provider sequence.

**Production implementation evidence (2026-11-14):**
- `create-booking-request`: API new booking starts `awaiting_payment`, ordinary Partner Account new booking starts `pending` and queues `partner_new_request` with partner push.
- `create_checkout_session`: API checkout is guarded by `apiPaymentEnabled`, the paid adapter registry, payment deadline, accepted quote and server-side amount; ordinary Partner Account remains on the existing accepted-booking checkout.
- `stripe-webhook`, `api-booking-dispatch`, `api-booking-status-sync`: require durable verified payment before API supplier dispatch and then share status/reconciliation.
- AVIA `api_enabled=true`, `active=true`, `account_status=active`. A **production** `search-api` request for Zadar Airport, 2027-03-01 10:00 to 2027-03-04 10:00, returned HTTP 200, **25 AVIA offers**, `partial=false`, 0 provider errors. This confirms API publication and live availability for those search criteria; it does not represent a paid end-to-end booking.
- Existing normal partner accounts remain active separately; no production checkout or local partner setting was changed during this documentation verification.

**Acceptance disclaimer:** The shared production code and real AVIA search have been verified. The first genuine paid LIVE AVIA booking must still confirm final Ride24 payment state, supplier reference, voucher and notifications; if any check fails, investigate safely before treating that booking as finished.
