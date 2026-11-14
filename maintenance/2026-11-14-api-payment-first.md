# API payment-first reservation audit and staged implementation

Status: staged; not enabled in production. Base main ad114aafa5c9437cdb01fcdc24c3f99c4eb1f3c6 includes PR #85 and #87. No cosmetic changes.

## Confirmed production flow before this patch

`create-booking-request` inserted a pending API booking and called `api-booking-dispatch` before checkout. Dispatch created the supplier reservation and changed confirmed supplier bookings to awaiting_payment with a 24-hour window. Status sync could also dispatch pending records. The ordinary checkout used the saved Ride24 fee, not the supplier's rental amount. The signed Stripe completed-event handler did not additionally retrieve and match the session payment status, customer, amount and currency before publishing paid/voucher state.

Two existing unpaid AVIA bookings already had supplier references during the audit. They were not created, cancelled, altered or refunded by this work. Existing supplier references need explicit reconciliation during cutover; do not resend them.

The historical `create-checkout` v50 independently accepted a caller-provided amount without authentication or booking ownership, with localhost return URLs. This confirmed defect was safely repaired separately: production v51 delegates to the existing authenticated `create_checkout_session` implementation (v81 source). A real unauthenticated POST with amount=1 returned HTTP 401 AUTH_REQUIRED. No Stripe session/payment was created by that test. The original complete v50 bundle is backed up.

## Staged behavior

- API carts are internal awaiting_payment records. Creating them never dispatches a supplier booking.
- The checkout validates the logged-in owner, a bound current quote, the server-calculated PLN Ride24 fee and deadline. A stable idempotency key and saved session prevent repeated clicks from creating different payment sessions. The old endpoint delegates to this same implementation.
- A signature-verified webhook retrieves the Stripe session and validates payment mode, paid/complete status, live/test mode, exact amount/currency, client and booking metadata, session ID and payment intent. A service-role-only transaction records the payment once and clears old expiry deadlines.
- A durable workflow revalidates fresh availability, route, times, group, currency, accepted terms/documents, price and selected services before a locked dispatch transition. Price/terms changes are not silently accepted.
- A supplier save timeout or interrupted worker becomes unknown. No blind create retry and no automatic refund while outcome is ambiguous. Known references are read back. Unknown references remain manual review until the provider offers a verified unique lookup by OrderReference.
- Only verified supplier confirmation and the stored paid workflow can publish booking status paid. Voucher generation checks that same reference and confirmation. Existing database email triggers then queue client confirmation; obsolete API payment-required/rejection mail is suppressed.
- Definitive inability to fulfill schedules a full refund of the Ride24 fee only. Stripe pending/failed/succeeded refund states remain distinct. Stable refund idempotency plus payment-intent read-back prevents repeat refunds; no blind retry after the idempotency window.
- Unpaid cancellation retains the cart. A late paid event on a cancelled/expired cart enters refund/reconciliation, never new supplier dispatch. Paid unresolved supplier operations cannot be deleted through the old pending cancellation RPC.
- Ordinary cancellation of a confirmed paid booking keeps the existing manual refund policy and thresholds. Local-partner payment and booking behavior are retained.
- Adapter capability gating currently permits Renteon only. Caravel, Arvent and future adapters must implement and validate this common contract before activation; this change does not activate them.

## Evidence

- 229 automated tests passed in the final combined regression invocation (zero failures, zero skips). The command is tracked in API Compatibility QA.
- Tests include real handler code with isolated Stripe/database doubles, the durable state engine, PostgreSQL-compatible PGlite transactions/permissions, unpaid and expired sessions, payment mismatch, duplicate webhook/dispatch, cancellation races, provider price/route/service changes, unknown timeouts, refunds, local partner regressions, HTML syntax and existing PR #87 switches.
- These are automated integration/contract tests, not real Stripe sandbox payments.
- Real Renteon AVIA quote-only acceptance on 2026-11-14: HR-ZAD-ZAD pickup/return, 2027-03-01 to 2027-03-04, 23:00 both ends, two ServiceId 489 baby seats. Fresh availability + calculation + post-payment revalidation succeeded. Partner total EUR 385.56; separate Ride24 fee PLN 165.81 using the explicit test FX 4.3 and margin 10%. No supplier save call, no booking/payment/customer insertion.
- The one-use authenticated acceptance function was closed after testing (v2, JWT enabled, HTTP 410 body). Job 0f59b50c-179f-4afc-8dd1-11d907b7c905 records the outcome without credentials.
- The server configuration check found no test Stripe key under STRIPE_TEST_SECRET_KEY, STRIPE_SECRET_KEY_TEST or the existing STRIPE_SECRET_KEY. No key values were exposed.
- No real charge, production supplier booking, refund, cancellation or customer notification was initiated in this task. No native Android runtime was available; native contract tests are not APK acceptance.

## Cutover and rollback plan — not executed

1. Configure an isolated Stripe test key and test webhook secret through Supabase secrets (never commit/paste secrets into reports). Run actual sandbox payment, duplicate event, rejection, delayed event and refund scenarios against the isolated test workflow and a provider-confirmed demo environment.
2. Reconcile legacy API bookings with supplier references. Do not delete or resend them. Preserve existing financial records and supplier IDs.
3. Apply the additive migration with api_payment_settings.enabled=false. Keep historical data; no destructive rollback or table dropping.
4. Deploy the complete matching function bundles: dispatcher gate first; API creation and both checkout names; webhook, status sync, voucher, email worker and cancellation. Keep API checkout disabled during the short cutover. Publish the functional WWW payment handoff while preserving PR #85/#87. Verify old APK calling contract before activation.
5. Enable API checkout only after sandbox acceptance, live source checks and user approval of the production cutover. Search and local-partner reservations remain available.
6. Emergency rollback: disable new API checkout through the flag, retain the verified-payment dispatch gate, pause new supplier creates while preserving reconciliation/refunds for existing payments. Do not roll back to the old unpaid dispatch behavior. Restore individually backed-up presentation/local functions only if compatible; retain workflow/payment rows.

## Remaining acceptance gates

Actual Stripe sandbox end-to-end including refund and webhook replay; provider demo save/status/cancellation using this new workflow; real Android acceptance; legacy booking reconciliation. Renteon unique OrderReference lookup semantics need confirmation for automatic recovery of an ambiguous save with no returned reference. The current implementation safely stops for manual review instead of risking a duplicate. Fixed minimum rentals/delivery rules still require provider-supplied terms, as Renteon explained.


## 2026-11-14 continuation — Renteon demo confirmation and category contract

- Veronika Čule confirmed the supplier code `demo` (lowercase), using the previously shared server-side credentials. Reservations for that code do not affect AVIA availability. The production partner remains configured as `Avia` and must not be modified to `demo`.
- The adapter treats provider codes as case-sensitive. Added a regression to ensure lowercase `demo` cannot reuse a differently cased quote; the supplier save test also asserts `CarCategory` and no concrete vehicle ID/VIN.
- API supplier-backed vouchers now explicitly explain the group-based booking, equivalent vehicle and complimentary higher-category upgrade. Non-API voucher wording is unchanged. These rules do not authorize changing the originally accepted booked group during post-payment revalidation.
- Current connected Stripe **test-mode** account shows zero registered webhook endpoints and zero Checkout sessions. It is not verified as the configured Ride24 sandbox account. Do not infer that sandbox checkout or signature-verified webhook delivery is ready.
- Read-only production inventory found two legacy AVIA API records with supplier references and status `awaiting_payment`, with no successful recorded payment. Preserve both for reconciliation; do not dispatch again, blindly delete or refund.
- Important operational trap: the existing `api-partner-admin` `testConnection` action updates `api_enabled=false` for the partner. **Do not invoke it against production AVIA just to test `demo`**, and never swap the live provider code temporarily.
- Do not route shared Renteon Basic credentials through ad-hoc `pg_net` SQL: the queued Authorization header may be visible to other database roles. Use a dedicated isolated server-side test harness with the existing Vault-backed secret, not a browser/client or SQL HTTP queue.
- After this checkpoint, the five PR CI workflow suites, including API Compatibility QA, completed successfully for commit `d0a76373bb2b3dc66f6ef41fa50bfb15fd3e98da`.
- No demo save/status/cancel was invoked from this session. No Stripe payment/refund was initiated; no migration, Edge Function deployment, partner setting or production booking was changed. PR remains draft until live sandbox acceptance, native APK test and historical booking reconciliation.


## Isolated sandbox preparation — 2026-11-14, head after d2eeb3d

- User explicitly selected connected Stripe test account `acct_1TzZduCJpFkHpJqc` (New business) for isolated Ride24 tests only. The connector reports `livemode=false`. A fresh read returned zero webhook endpoints. Therefore no actual connection to a Ride24 test webhook has been established or claimed. No test charge was initiated before that prerequisite.
- Supabase lists no development branches for Ride24; the only other visible project is unrelated and must not be reused. The user's latest instruction prohibits production changes without approval. No function/migration/secret/partner update was made in this continuation.
- Fixed a group-booking regression: representative ModelName/photo/display order no longer invalidate the same contracted category. Category, passenger capacity, financial and insurance constraints still do. Added positive/negative regression cases.
- Added `tests/sandbox/renteon-demo-runner.mjs`: requires exact lowercase demo and the documented Aggregator origin; verifies route against demo setup; requests the booked group; accepts dynamic selections; journals save intent before one save; never retries uncertain saves; records the returned reference; cancels only that run's known demo reference and verifies cancellation by status read-back. The journal claim must persist and cannot be reset after an unknown save.
- Added an undeployed, reviewable `tests/sandbox/renteon-demo-edge.ts` entrypoint. It reads existing Vault credentials through the established server loader, overrides only an in-memory copy to demo, uses a one-use expiring hashed token and writes only the existing test-job journal. It cannot update partner configuration. It is closed unless a separate expiry setting is explicitly configured. It has NOT been deployed.
- To run that entrypoint without exporting shared credentials, approval is required for adding this isolated temporary test endpoint and test journal rows to the production Supabase project (the user's no-production-changes instruction currently excludes that). Alternative: provision a separate test project with the same server-side Vault mechanism and test credentials. Never move or replace production Stripe secrets.
- The wrapper is a provider acceptance harness, not proof of the combined Stripe payment-first lifecycle. Actual Demo save/status/cancel and Stripe payment/refund/webhook delivery remain unperformed in this continuation. No fabricated test booking numbers.
- Historical references 26-P2-8302 and 26-P2-8303 remain unchanged. Reconciliation plan only: read current supplier state and associated Stripe session/payment; if unpaid, expire any still-open checkout and cancel the exact supplier reference only after explicit approval, verify cancellation by read-back, then retain an audit tombstone instead of deleting financial/history links. If a payment exists or outcome is unknown, stop and reconcile; never auto-delete/refund.

- Validation for this continuation: the current API compatibility command passed 245 tests, zero failures/skips. This includes eight isolation/cleanup tests and two new category-contract cases. These are automated doubles; no real demo save or Stripe test payment is counted as passed.
