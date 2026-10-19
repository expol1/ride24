# Android payment return compatibility — 2026-10-19

Stripe's existing Android return URL sent the browser to a Supabase function
that immediately redirected to a custom scheme. Some Android browsers left a
blank tab when that external-protocol navigation was blocked.

The return function now redirects to the static HTTPS page
`https://ride24.pl/auth/payment-return.html`. It provides an explicit app button,
a browser fallback, Polish and English text, and an automatic app-open attempt
on Android. Chrome's intent URL targets the requested production or TEST
package; Firefox uses the existing `ride24://` link.

`create_checkout_session` accepts the optional allowlisted `return_app` and
`language` parameters for Android. Existing Android callers default to the
production app. WEB return URLs are unchanged. Stripe session identifiers are
not forwarded to the public return page.

The page and native return link only navigate. The Stripe webhook and the owned
booking row remain the source of truth for payment status. Ownership checks,
saved payment amounts, currency, Stripe metadata and payment creation rules
are unchanged. No reservations, partner settings or data are migrated.

## Validation

- 9 callback/handler tests, including old clients, TEST vs production, PL/EN,
  Firefox, malformed IDs, GET/HEAD/405 handling and no arbitrary redirects.
- The real checkout handler is executed with isolated Auth/database/Stripe
  stubs: a forged client amount is ignored and a foreign booking is rejected
  before Stripe is invoked.
- 64 WEB regression tests pass, including booking quotes, mandatory fees,
  ownership, legacy bookings, snapshots and PDF voucher rendering. The schema
  test additionally performs 23 isolated checks without production writes.
- Android client 1.0.17 (18): 41 automated tests cover HTTP refresh/retry,
  concurrent UI/FCM access, persistent login, loyalty counters and the production
  pricing snapshot contract.
- Partner 1.0.8 (9): 26 tests pass, including the 19 October mandatory-fee
  fixtures. Production Partner sources remain byte-for-byte unchanged.

The native client reads an exact count of its authenticated user's `paid`
bookings for loyalty presentation, matching WEB. Monetary discounts still come
from `booking-options`; no Android pricing engine is added.

Actual card payment and installation on a physical Android device require
release acceptance testing. No real payment, booking or notification is created
by these automated checks.

## Rollback

WEB baseline: `backup/before-android-payment-return-20261019` at
`bb14c6d06a2e727135f33ef3141f2ddfa6b0f4b7`.

Exact pre-change production function source, versions, entrypoints, JWT settings
and SHA256 hashes are in
`maintenance/backups/android-payment-return-20261019.json`:

- `payment-return`, version 7, `verify_jwt=false`;
- `create_checkout_session`, version 79, `verify_jwt=true`.

Revert the WEB change and redeploy those source payloads to roll back. Supabase
increments the deployment version even when previous source is restored.
The charging calculator, booking creation, vouchers and Stripe webhook do not
need to be rolled back for this change.
