# Caravel production optional extras — safe completion checklist (19 Nov 2026)

Status: **NOT LIVE**. This document is a technical handover; do not turn on selected extras until every acceptance test below passes. Existing compulsory fees and Premium price breakdown are live separately (PR #139). Keep other providers, Stripe and the public release flags unchanged.

## Confirmed existing contract

- Caravel OpenAPI v1.67.0: `GET /v1/reference/extras` from the *production* supplier account, `POST /v1/quote` with `extras:[{extra_id,quantity}]`, and `POST /v1/bookings` with the freshly verified `quote_id`.
- No independent Ride24 fee math: Caravel's `totals.grand_total` = rental + selected extras + provider mandatory fees. Partner collects the full supplier amount at pickup. Stripe takes only Ride24's separate reservation fee.
- Provider data is verified by `caravelQuoteFromApi` and `verifyCaravelQuotedExtras`; keep fail-closed zero-excess/zero-deposit, terms EN v5, currency EUR, quote expiry, location and age checks.
- The current `issueVerifiedCaravelQuote` **rejects selected extras** and the current customer option widget returns unsupported for Caravel; do not remove those guards prematurely.
- The current `revalidatePaidCaravel` sends a fresh quote with no extras; therefore merely exposing a picker would drop the customer's selection before the provider booking.
- Additional driver is separately blocked by `handleCaravelBookingRequest` and requires a verified additional person's name/age/licence before enabling; do not equate it to an anonymous quantity.

## Required transaction path

1. Read production catalog for the exact supplier ID and EUR. Require `active`, `payable='at_pickup'`, bounded quantities, valid EUR `unit_price` and `price_cap`, and confirmed Ride24 UI mapping. Do not copy sandbox data or assume `extra_id` across suppliers.
2. Expose authenticated, quote-scoped extra choices on WWW/Android with a provider-generated display name and pricing unit. Unmapped/unsupported extras remain unselectable. Do not write Caravel prices as active local `partner_extras`, because the shared Ride24 extras engine would double-price them.
3. On each selection change, issue a **new** Caravel `POST /v1/quote` using server-controlled location, vehicle, Premium package, main driver age and selected provider IDs. Validate duplicates/quantities, mutually exclusive choices and price caps. Verify all `kind='extra'` lines against the selection, and reject any missing or unselected line.
4. Persist the new quote ID and selected extras snapshot in `api_quotes.raw_response.provider_quote_data`. Bind exact extras ID/quantity/amount into the customer consent. Show rental, each voluntary extra, each mandatory fee, Caravel total, Ride24 fee separately. Reset all acceptance checkboxes after each re-quote.
5. On booking submission re-validate the user's driver age, inventory, quote validity, selected extras and consent. If any change, return new quote and require new acceptance. Never silently remove a selected extra.
6. At Stripe-first fulfilment, re-quote **the exact stored extras and age**; compare quote lines, totals, currency, protection, terms and pickup model before creating a booking. Reuse stable booking-derived idempotency keys. `POST /v1/bookings` must use the new verified `quote_id`, which is tied to those extras. Verify provider acknowledgement contains the same selected extras or obtain explicit supplier assurance in its confirmed booking representation before declaring success.
7. Persist selected extras in the Ride24 booking/voucher snapshot and make them visible in customer WWW and Android; preserve separate external provider reference. Keep refund/manual-review behavior unchanged on unknown outcome.
8. Additional driver only after Caravel and Ride24 have a tested main/second driver flow, including identity, age and licence tenure. Never silently encode a second driver as a charge-only extra.

## End-to-end release criteria

- €0 free extra, € per day extra for 3 days, one-time extra, optional quantity 2, max price cap, zero extras; assert exact totals in cents and never double-charge.
- Age 22 / age 76 and one-way return / out-of-hours tested separately and together; supplier mandatory fees appear only once in the final price.
- Deny duplicate extra, forged extra ID from another supplier, changed quantity, wrong EUR currency, expired quote, mismatched quote line, unknown fee, capped daily extra, changed terms.
- Confirm a non-paid sandbox booking with selected extras actually appears at Caravel with the same services; then perform a controlled production booking + cancellation only on operator approval.
- Test AVIA, local partners, and all other API providers for no changes; test WWW + Android parity.
- Confirm production catalog (currently **0** Caravel entries in Ride24 `partner_extras`; sandbox snapshots belong to sandbox supplier accounts and are not production price evidence).
- CI, server deployment, Cloudflare deploy and mobile release each require independent verification.

## Current preparatory PR

Draft PR #141 strengthens provider price-line verification. It does not enable customer selection or amend any payment/booking code. Keep draft until all requirements are implemented and tested.
