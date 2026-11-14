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
