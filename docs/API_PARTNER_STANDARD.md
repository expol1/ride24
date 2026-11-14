# Ride24 API Partner Standard — one shared payment-first reservation model

**Production standard established for AVIA/Renteon on 14 November 2026.**
This is the reusable contract for all upcoming **API** integrations; manual Partner Accounts keep their separate existing workflow.

## Mandatory business model
1. Ride24 sells a **category/group of vehicles** (supplier SIPP/ACRISS code or validated group ID), not an individually guaranteed car, VIN or photograph. The supplier may provide a similar vehicle from the **same category** or a **higher category without any surcharge**; it must never downgrade the confirmed group.
2. The client pays **only Ride24's separate, transparently itemized booking fee** by Ride24 Stripe Checkout in PLN. The supplier's rental price, equipment and agreed local charges are **paid directly to the supplier on collection**, under the supplier's published rental conditions. Do **not** blend supplier rent with Ride24's fee.
3. The supplier receives a reservation only **after Ride24 has durably verified a genuine paid Stripe session**. Never reserve at the supplier just because the customer opened or returned from Checkout.
4. No unagreed deposit/credit-card hold or restriction may be hidden. Required cards, insurance, exclusions, age, fuel, minimum rental, delivery and cancellation terms must be shown before payment and carried into the booking snapshot.

## Single technical sequence — identical for all API partners
1. Search live supplier availability by date, times, pickup/drop-off location and **vehicle group**; normalize supplier location/group identifiers; capture supplier price, compulsory fees, chosen extras, protection and conditions, and an expiring offer fingerprint.
2. Customer accepts all conditions and selects a group and exact extras. Create a Ride24 **awaiting_payment** cart/quote with **no supplier reservation**. Store the customer's pricing snapshot and accepted terms.
3. Checkout authenticated Ride24 customer for the **server-calculated Ride24 fee only**, in a bound single Stripe session. Client-provided totals are never authoritative.
4. On a **signed Stripe webhook**, retrieve the Checkout Session from Stripe, match account mode, payment status, session, PaymentIntent, currency, exact amount, customer and booking IDs; record the paid event transactionally and idempotently.
5. Revalidate **current** supplier availability and booked group, route, dates/times, selected services/quantity, total rental, deposit, excess, insurance and documents; fail if the accepted commercial terms changed.
6. Atomically claim supplier dispatch once; save **the group**, not a particular model. Preserve the supplier booking number, status and complete internal audit log.
7. After supplier confirms the precise reservation, produce the Ride24 voucher and enqueue customer confirmation. The voucher explicitly identifies the group and permits same-group or complimentary upgraded vehicle.
8. If fulfillment **definitively fails before a supplier booking exists**, refund **100% of Ride24's collected fee** automatically and inform the client. If supplier save timed out or outcome is ambiguous, **never repeat save blindly** or double-refund; hold for read-only reconciliation and manual review.
9. Cancellation must verify the provider's actual cancellation response/status before final settlement. Paid confirmed reservations follow the applicable, previously accepted cancellation terms; local Partner Account behavior remains untouched.

## Adapter contract (the only supplier-specific code)
Each new API adapter must implement and independently test:
- `availability` / group and location normalization
- `quoteOptions` / authoritative total price and equipment reconciliation
- `createBooking` / exactly-once supplier save with group and reference
- `getBookingStatus` / verified confirmation with stable supplier number
- `cancelBooking` / verified cancellation and read-back

For suppliers without reliable idempotent create or a provably unique OrderReference lookup, **UNKNOWN is manual review, not a retry**.

**Capability gate:** `supabase/functions/_shared/api-provider-fulfillment.ts` currently enables payment-first fulfillment for `renteon_aggregator` (AVIA). Every future integration must explicitly add an implementation behind `hasPaidFulfillmentAdapter` with negative/positive contract tests. No supplier can bypass the shared Stripe/payment gate; unsupported adapters are not production-ready and must remain inactive.

## Release acceptance for the next API partner
- Confirm actual supplier credentials/production versus demo code and API permissions.
- Independently test group availability, quoted rental + extras, one supplier demo booking, status, cancellation and read-back.
- Verify the **same central Ride24 Checkout/webhook workflow** with test payment, duplicate event, failed payment, refund, expired/late session, price/terms change, unknown provider save, voucher and notifications.
- Verify WWW booking, read-only visibility and existing Android API contract; do not activate an unsupported adapter.
- Keep Stripe LIVE, legacy Partner Accounts and all other suppliers unchanged during supplier demo onboarding.
- Enable the partner only after the acceptance checklist and a controlled cutover.

**No one-off replacement of Ride24's global booking or payment model for an individual rental company.** An incompatible provider payment requirement is a commercial exception needing an explicit separate decision, not an undocumented modification to the common API engine.
