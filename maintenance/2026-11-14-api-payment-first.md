# API payment-first reservation audit and staged implementation

**CURRENT STATUS (2026-11-14): PRODUCTION API PAYMENT-FIRST ENABLED FOR AVIA.** PR #88 was merged to `main` (squash SHA `f05746e05042fdc4c9d3330ad75799159e8cc8a7`), migration and matching Edge Functions were deployed, `api_payment_settings.enabled=true`, and AVIA `api_enabled=true`. The remaining historical sections below reflect checkpoints *before* activation, not current state. A fully paid end-to-end AVIA reservation and voucher has NOT yet been exercised with a live payment.

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


## Authorized real Renteon demo acceptance — 2026-11-14

Explicit user permission: temporary isolated endpoint and test journal only, maximum two hours, exact lowercase `demo`, Vault credentials server-side only, no production partner/payment changes. Deployed a NEW `ride24-demo-acceptance-20261114` function with a hard-coded two-hour expiry and exactly four allowlisted one-use jobs. No global secrets/settings were modified. Authentication replay returned HTTP 401 AUTH_REQUIRED.

Actual supplier results:

| Step | Observed result |
| --- | --- |
| Setup | 27 demo locations returned |
| Availability | GR-ATH-ATH to GR-ATH-ATH, 2027-03-01 10:00 to 2027-03-04 10:00: 11 categories |
| Base group quote | MDMR, EUR 29.76 |
| Optional services | Baby seat ServiceId 619: quantity 2, EUR 33.48 each for period; booster ServiceId 622: quantity 1, EUR 63.24 for period |
| Calculated amount | EUR 159.96; exact API calculation, no invented rate |
| Supplier save | Reference **26-ATH-207**, status confirmed, needs_manual_review=false |
| Status read | Same reference, confirmed |
| Cancellation | Cancellation call followed by read-back verified cancelled |
| Independent read | Separate final one-use job returned reference 26-ATH-207, status cancelled, zero active reservations created by this run |
| Token replay | HTTP 401 AUTH_REQUIRED |

No live AVIA reservation, Stripe payment/refund, ordinary booking record, customer email/push or PR migration was created. Historical references 26-P2-8302 and 26-P2-8303 were not touched. This is actual Renteon demo acceptance, **not** a combined Stripe payment-first E2E test.

Cleanup: all four tokens were invalidated and their expiries set to now; temporary function v3 was replaced with only HTTP 410 closed response and JWT verification enabled. Thus no demo/AVIA code or credential-loading path remains in that deployed function. Physical deletion is still pending Dashboard authentication because the connected Supabase tool does not expose function deletion. The Dashboard login encountered OAuth state expiry; do not mark physical deletion as complete until verified.

The runner's final result now explicitly reports cancelled, retaining the pre-cancellation status separately, so the terminal report cannot misleadingly say confirmed after successful cleanup. Existing cleanup tests assert both fields.

Not performed: actual Stripe TEST MODE checkout, signed webhook delivery/replay, refund, end-to-end voucher/email/push, native Android acceptance. Previously confirmed test account has no registered webhook; production Stripe configuration remains unchanged.


## 2026-11-14 independent read-only Stripe and legacy audit

- Production database confirms two legacy AVIA API bookings awaiting payment with real supplier references:
  - Ride24 `R24-7FE14B`, supplier `26-P2-8302`, stored Ride24 fee PLN 86.16;
  - Ride24 `R24-912461`, supplier `26-P2-8303`, stored Ride24 fee PLN 163.90.
- Both saved Stripe Checkout sessions use the `cs_live_` prefix, while the only connected Stripe account is `livemode=false`. Both have zero successful `payments` rows and no linked `payment_intent_id` in Ride24. **Missing database payments do not prove Stripe LIVE never collected funds.**
- Before any cancellation, refund, modification of historical records, or cutover, reconcile the exact live Stripe Checkout session and PaymentIntent from the correct Stripe LIVE account (read-only), and verify the specific supplier booking reference against AVIA; preserve the audit trail. Do not access or modify other customers.
- The two production records have not been changed, no Stripe LIVE APIs were invoked, and no new supplier saves were made.
- Added regression tests that a verified late payment for a booking with a legacy supplier reference enters `provider_pending` status reconciliation and cannot claim a second supplier dispatch.
- Test-mode Stripe account `acct_1TzZduCJpFkHpJqc` is separate and cannot validate `cs_live_` sessions. End-to-end payment/refund and webhook delivery still require a dedicated isolated test receiver and test-mode key; do not register a test webhook against the existing production handler.
- Functional acceptance gates for activation remain: separate Stripe TEST sandbox checkout/refund and signed webhook replay; fresh Renteon demo booking under that specific paid workflow; voucher/mail/push validation; Android test; legacy reconciliation; explicit cutover approval.


## 2026-11-14 production AVIA pause and legacy test cleanup — user-authorized

The owner confirmed that the two legacy supplier bookings were test cases and explicitly permitted removing them, while allowing AVIA offers to be hidden during final integration. The following safe production operations were completed, independently of PR #88:

- Only AVIA partner `91e04805-31da-4242-9e6f-b6075019d784` was updated to `api_enabled=false`. The deployed `search-api` filters `partners.api_enabled=true`, and the deployed `create-booking-request` requires it for API quotes, so new AVIA offers/requests are blocked. The partner, vehicles and credentials remain preserved for reactivation.
- Targeted two rows by both Ride24 reservation code and exact supplier reference, with `awaiting_payment` and no successful payment recorded: `R24-7FE14B` / `26-P2-8302`; `R24-912461` / `26-P2-8303`.
- Both were soft-cancelled, with `cancelled_at` set and `payment_deadline`/expiry cleared. The existing `api-booking-status-sync` cancellation mechanism was invoked (same secret/Vault-backed mechanism as scheduled cron) and both returned `api_status=cancelled`, `manual_review=false` and one provider cancel log each.
- Neither booking was hard-deleted. Their Checkout IDs have the `cs_live_` prefix; the connected Stripe account remains TEST MODE only. A missing database payment record does **not** establish Stripe LIVE settlement status. Hard deletion before resolving any open/late Checkout event would orphan webhooks or payment records. Preserve cancelled tombstones and original supplier references pending read-only Stripe LIVE session confirmation, session expiry and accounting reconciliation; then perform physical deletion only if safe and specifically desired.
- No Stripe LIVE API call, payment, refund or charge was made. No changes were made to production Stripe credentials, other partners, payment/booking Edge Functions, PR migration or the AVIA API server credentials.
- AVIA API supplier/provider cancellation was acknowledged via the verified aggregator cancel response; this is not an independent provider status read-back after cancellation.
- The Android integration is deliberately a separate future workstream at the owner's request. This does not waive the obligation to verify current legacy Android compatibility when activating production API checkout.

PR #88 remains unmerged and draft; the mandatory full Stripe TEST checkout / webhook / refund and end-to-end paid Renteon demo + voucher acceptance remain incomplete. Reactivation of `api_enabled` and production payment-first cutover both require a controlled release review.


## 2026-11-14 Stripe TEST secret validation and isolated webhook staging

- Owner saved `STRIPE_TEST_SECRET_KEY` into Supabase Ride24 Edge Function Secrets without sharing its value in chat.
- A new isolated read-only function `ride24-stripe-test-preflight-20261114` authenticated via the existing server-side cron secret and performed `GET /v1/account` from the Edge runtime. Result was HTTP 200: `configured=true`, `test_mode=true`, and the Stripe account ID matched expected `acct_1TzZduCJpFkHpJqc`. No secret content, payment, refund, booking, or customer payload was read or logged.
- Immediately after the successful preflight, this function was replaced by version 2: JWT required, closed stub returning only HTTP 410, with no code path to Stripe or any secret.
- A new isolated `ride24-stripe-test-webhook-20261114` Edge Function was deployed. It verifies Stripe HMAC-SHA256 raw-body signatures with dedicated `STRIPE_TEST_WEBHOOK_SECRET`, enforces timestamp tolerance and `event.livemode===false`, and only logs the verified event type/id. It never modifies Ride24 bookings/payments or API partner state. Its test receiver closes automatically at `2026-11-14T14:00:00Z`. This is **not** the live `stripe-webhook` function.
- Stripe TEST account `acct_1TzZduCJpFkHpJqc` registered test event destination `we_1UbeJACJpFkHpJqcnyLz9JkJ` for this isolated URL and only checkout/refund-related event types. Endpoint is currently **disabled**, awaiting separate configuration of its `whsec_` signing secret in Supabase as `STRIPE_TEST_WEBHOOK_SECRET`. Do not replace `STRIPE_WEBHOOK_SECRET` or `STRIPE_SECRET_KEY`.
- Once the signing secret is entered, first verify non-empty valid test signature handling and account mode, then enable this one test-only destination; perform test-mode Checkout/refund validation. Remember to disable/delete the destination and close the function after tests. Never use production booking rows or production AVIA for the test.
- No Checkout session has been created or paid in this step; no Stripe webhook delivery or refund has yet been accepted/verified. This staged receiver alone does not prove the PR #88 end-to-end flow.


## 2026-11-14 actual Stripe TEST acceptance and final cleanup

The Stripe connector repeatedly requested reauthorization. Testing instead used temporary, strictly TEST-only Supabase Edge Function `ride24-stripe-test-acceptance-20261114`, authenticated with the existing server-side cron secret and `STRIPE_TEST_SECRET_KEY`; no Stripe connector API writes or live payments.

Verified actual Stripe TEST results:

| Check | Observed result |
| --- | --- |
| Isolated event delivery | `customer.created` delivered to `ride24-stripe-test-webhook-20261114` with a verified Stripe HMAC signature; event `evt_1Ubeb8CJpFkHpJqcCeF5JOcD` in Supabase `function_logs` |
| Test PaymentIntent | PLN 12.34 (`1234` cents), `pi_3UbebdCJpFkHpJqc0mjXWzrF`, `succeeded`, `livemode=false` |
| Full test refund | `re_3UbebdCJpFkHpJqc0vPZgJM3`, full PLN 12.34, `succeeded` |
| Refund event delivery | Signed `refund.created`, `refund.updated` and `charge.refunded` verified in Supabase `function_logs` |
| Isolated Checkout | `cs_test_a0Bn84IPkRf3bqZQaXLKrpqt47yPiIUs8F5a4Ao65455G94HqdC5wfs2O2` for PLN 12.34 created `open` and explicitly expired `expired/unpaid` via Stripe TEST API |
| Checkout expiry delivery | Signed `checkout.session.expired` event `evt_1UbedBCJpFkHpJqcH7BE1gSu` verified in Supabase logs |

Cleanup performed and verified:
- Temporary Stripe test customer `cus_VcuPzCUZVI3iTh` deleted (API response `deleted=true`).
- TEST webhook `we_1UbeJACJpFkHpJqcnyLz9JkJ` disabled and temporary `customer.created` subscription removed (eight checkout/refund event types remain for future controlled testing).
- Temporary isolated Stripe acceptance function redeployed as JWT-protected, no-secret/no-Stripe-access HTTP 410-only stub (v3).
- Temporary isolated test webhook receiver redeployed as JWT-protected, no-secret/no-Stripe-access HTTP 410-only stub (v4).
- Test-mode key and signing secret remain in Supabase Secrets for a future isolated acceptance run; existing production `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` untouched.
- No production booking/customer/partner state changes from this test, no real funds, no Renteon save, no voucher/email/push. AVIA still paused (`api_enabled=false`).

**Scope and remaining blocker:** These are *real* Stripe TEST API/payment/refund/signature tests, **not** a paid Stripe Checkout session or a combined Checkout -> Ride24 database atomic payment -> Renteon demo save/status -> voucher/email end-to-end test. The staged PR #88 migration and payment-first Edge Functions are NOT deployed; a safely isolated integration acceptance environment and live-account settlement reconciliation are still required before a production cutover. Android changes are a separate user-requested workstream, but preserve backward compatibility.


## FINAL LIVE CUTOVER — 2026-11-14 (current state)

### Released
- PR #88 merged to `main`, squash SHA `f05746e05042fdc4c9d3330ad75799159e8cc8a7`; all five pre-merge GitHub CI checks succeeded, including 248/248 automated API compatibility tests with 0 failures.
- Production Supabase additive migrations recorded as `20261114110526_api_payment_first_workflow_20261113`, `20261114111238_admin_api_refund_settlement_guard_20261114`, and `20261114112855_admin_refund_rpc_execute_acl_20261114`. GitHub filenames were reconciled with those applied migration versions to avoid replay on later schema deployment.
- Supabase function versions after aligned production deployment: `create-booking-request` v32, `create_checkout_session` v86, `create-checkout` v56, `stripe-webhook` v88, `api-booking-dispatch` v34, `api-booking-status-sync` v29, `client-cancel-booking` v28, `generate-voucher` v132, `email-worker` v90. `search-api` v77 unchanged.
- `api_payment_settings.enabled=true`; AVIA partner `91e04805-31da-4242-9e6f-b6075019d784` (`Avia d.o.o.`) `api_enabled=true`, active and synced.
- Live WWW canonical `https://ride24.pl/klient` served updated `klient.html` (209,692 bytes), including `payment_required` handoff to `goToPayment(...)`, verified by cache-busting Cloudflare HTTP 200 fetch. Older cached response was observed at first and resolved after cache-busted retrieval.
- Production Stripe LIVE account `acct_1TEm7p67UAIA6d2h`: charges and payouts enabled, live secret and live webhook signature secret configured, signed event endpoint `we_1TIUq767UAIA6d2hyuhAYMkg` enabled for completed and expired Checkout sessions. A one-off PLN 12.34 **LIVE Checkout session was created and explicitly expired UNPAID** (`cs_live_ac6OPXUHPZcbFUPl0u0Re9uTLSv472f9OBhRv89VF6VwsHIqC1EZdWvkSl`), no money collected.
- Actual production `search-api` supplier call for Zadar airport (`HR-ZAD-ZAD`), 2027-03-01 23:00 -> 2027-03-04 23:00, returned HTTP 200, 25 AVIA group offers, `partial=false` and zero supplier errors. Example group `MCMR`, period supplier total EUR 310.56. Search wrote only normal expiring quote records, no bookings.
- Production `api-booking-status-sync` previously returned HTTP 200 with zero phase errors and no unexpected dispatch. Both historical AVIA test bookings `R24-912461` and `R24-7FE14B` have confirmed supplier cancellations and are retained as audit tombstones, not duplicated.
- Manual-refund admin RPC anonymous EXECUTE revoked; authenticated caller remains subject to explicit `profiles.role='admin'` check, service role still allowed. Security advisor shows two INFO RLS-no-policy notices for workflow/settings tables intentionally service-only and one authenticated security-definer notice for the explicitly admin-protected refund function.
- All temporary LIVE diagnostics, compilation, Checkout smoke and WWW fingerprint Edge Functions were replaced by JWT-protected HTTP 410 closed stubs; no secret-bearing test handler remains enabled.

### Universal API partner architecture (mandatory)
- The **same Ride24 payment-first workflow, Stripe LIVE checkout and signed webhook, group-based booking, supplier status, voucher, notification, definitive-failure full Ride24-fee refund, and ambiguous-save manual review** apply to all API partners.
- Reusable formal standard is `docs/API_PARTNER_STANDARD.md` on `main`.
- **ONLY** `renteon_aggregator` currently passes `hasPaidFulfillmentAdapter`; new suppliers (Caravel, Arvent, Pegasus, etc.) must implement and validate the documented five-method provider adapter before their API account may accept payments. This is supplier mapping, not a different business/payment model. No global Ride24 workflow rewrite or partner-by-partner Stripe changes permitted.
- Ordinary non-API Partner Accounts retain their existing booking and payment workflow.

### Residual acceptance caveat
- **Not observed or proven:** one **completed actual paid live** Checkout tied to a Ride24 API cart, followed by supplier AVIA production save/status and generated client voucher/email. The real Renteon `demo` booking/save/cancel, Stripe TEST card payment/refund and signed events, LIVE Checkout opening/expiry and 248 regression tests succeeded separately.
- Therefore this is a production **enabled release with an outstanding first-paid-transaction acceptance check**, not a fully witnessed real end-to-end paid booking. An operator should verify and monitor the first live paid API reservation before treating go-live acceptance as exhaustive. If dispatch result is ambiguous, put the booking in manual review without resending `save`.
- First-response rollback for new AVIA offers: `update public.partners set api_enabled=false where id='91e04805-31da-4242-9e6f-b6075019d784';`. Emergency pause for **all new API reservations**: `update public.api_payment_settings set enabled=false where id=true;`. **Do not** revert the no-unpaid-dispatch guard, delete paid workflow rows, or roll back to the unsafe legacy function.
- Android feature/UI changes remain a separate owner-requested workstream; existing native contract tests passed but actual APK compatibility should be validated prior to promoting Android API booking UX as verified.
