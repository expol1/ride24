# Ride24 × Arvent / kolayCAR — integration gate (2026-11-16)

**Status:** technical discovery underway, NOT integrated, NOT live. This directory
documents the real production account and the contract requirements. It must not
be interpreted as permission to call Arvent booking endpoints.

## Verified Ride24 state (production, read 2026-11-16)

- Repository: `expol1/ride24`; production Supabase: `zwyerdeuvyzgkgwglowr`.
- Existing partner ID: `bf29a373-c464-4cec-87a7-c3218ea1ea51`.
- Partner: `provider_type=api`, `api_provider=custom`, `currency=EUR`,
  `discount_percent=0`, `active=true`, `profile_completed=true`,
  `account_status=active`, `agreement_accepted=true`.
- API remains `api_enabled=false`, `api_status=draft`. No Arvent API
  locations, classes, or quotes have been synchronized.
- `partner_api_credentials.api_url` set to
  `https://racapi.arventcarrental.com`. No successful API test recorded.
- Rental terms and partner agreement were already uploaded and must be retained.
- Credentials are stored/used only server-side. Never commit passwords or tokens.

## Current blocker

The partner-provided Postman page:
`https://documenter.getpostman.com/view/39642884/2sB3QDxDwM`
was not retrievable through the available automated fetch in this environment.
The publicly found *2018 kolayCAR 1.6 SOAP API PDF* describes a different host,
so it is **not the source of truth** for the Arvent REST host and must NOT be
used to invent endpoints, authentication headers, request bodies, or response keys.

Request from supplier: **an exported Postman Collection v2.1 JSON with all
required endpoints and example redacted responses**, plus an environment JSON
without real passwords if route variables are required. Confirm whether
`racapi.arventcarrental.com` is production or sandbox, and whether a separate
test environment can perform reservation create/cancel without real bookings.

## Offline API contract inventory

Do not publish/export collections containing live secrets. Use redacted copies.

```sh
node tools/arvent-postman-audit.mjs arvent-collection.redacted.json
node --test tests/backend-hardening/test-arvent-postman-audit.mjs
```

This script *only reads a local JSON file* and produces **unverified
operation hints**. It never sends requests, uses supplied credentials, or
authorizes live booking tests. Review all flagged hosts, auth methods, schemas
and mappings manually against the actual Postman examples.

## Integration order once real contract is verified

1. Resolve exact authorization, currency, category IDs, location IDs,
   availability date/time format, booking confirmation/cancellation semantics.
2. Add isolated `arvent_kolaycar` provider routing to existing
   `_shared/provider-adapters.ts` and explicitly whitelist it in admin API.
3. Normalize categories (never specific car VIN/model guarantees) and prices
   as Arvent net EUR; supplier receives **0% extra discount**.
4. Gate dispatch behind the existing paid Stripe → quote recheck → supplier
   booking → voucher workflow. Preserve idempotency and handle ambiguous
   supplier responses with manual review rather than duplicate requests.
5. Require confirmed supplier cancellation before a client-facing cancelled
   status; keep Ride24 refund queue behavior unchanged.
6. Add fixture-based unit/regression tests and READ-ONLY provider probes.
7. Do not activate Arvent `api_enabled` or publish offers without sign-off.

## Existing partners: non-regression boundary

Do not change AVIA Renteon Aggregator, Pegasus export, Erdem ADB/BJV inventory,
other API partners, Stripe accounting or vouchers. Test the existing workflows.

## Security

Never put usernames, passwords, API keys or sample customer personal details
in GitHub, logs, frontend, Android or test fixtures. The
`public.partner_api_credentials` table has RLS and `service_role` access.
Use the existing server-side credential-loader after exact auth type is confirmed.
The supplied credentials were shared by email; rotate when practical.


## Update 2026-11-17 — real Postman collection supplied

Received **Arvent - Ride24 Partner API** Postman Collection v2.1, 13 requests, synthetic examples (not production rates). Now verified:

- POST \`/users/authenticate\` JSON {username, password} -> \`data.token\` for Bearer authentication.
- GET \`/locations\`, GET \`/locations/cities\`, GET \`/vehicles/list\`.
- GET \`/vehicles\`: pickup/return IDs, dd.MM.yyyy dates, HH:mm times, currency and language; each current quote has a \`reservationToken\`.
- GET \`/extras\` with token returns the specific offer and \`extras[].code\`/\`isRequired\`.
- POST \`/reservations/save\` JSON is the chosen mutation method; the two other booking methods are alternatives and must never be called in parallel.
- GET \`/reservations\` requires supplier reservation number AND original customer email.
- POST \`/reservations/cancel\` returns a business response; require status evidence, not merely HTTP 200.

**Implemented only on the feature branch:** separate Arvent pure contract and HTTP adapter,
strict supplier-host allowlist, noauth token login + short token cache, business-response
validation, location/car metadata, EUR availability and quote mapping, booking payload,
status and cancellation handlers.

**Hard safety gates:**
1. Production remains \`api_enabled=false\`. Admin activation of \`arvent_kolaycar\`
   is explicitly blocked pending certification.
2. All provider mutations require the **unset** server-only
   \`ARVENT_KOLAYCAR_WRITE_ALLOWED=true\` flag; never enable it during read-only tests.
3. Arvent is *not* yet in the paid-provider fulfillment whitelist.
   Stripe money flow is unchanged and must not accept Arvent pending the full
   revalidation/options/booking/voucher test suite.
4. Only real EUR offers with explicitly zero deposit, no required credit card,
   and explicitly zero km cap are eligible. Any missing, positive or conflicting
   field causes an offer to be omitted, never silently overwritten.
5. Supplier status \`reservationStatusType=0\` is "received" (pending), **not**
   confirmation. \`-4\` is cancellation. Unknown status enums remain pending.
6. The file's example shows TRY, deposit=2000, card required, km limit=300.
   These are synthetic, not evidence Arvent actually violates its agreed terms.
7. Do not store supplier \`reservationToken\` in \`api_quotes\`: refresh it for
   price revalidation before booking. Don't put raw customer data in diagnostics.

**Confirmation needed from Mustafa or Ziya, not established by synthetic examples:**
- Is the supplied host production or sandbox? Is non-mutating auth/GET safe?
- Live returned EUR prices: are these Arvent's net prices to be paid on pickup,
  and can PayOnDelivery paymentType=3 and paidAmount=0 be used?
- Does vehicleId represent a booking category, or a specific vehicle? Ride24
  sells categories only and accepts equivalent-category substitutions.
- How are unlimited mileage, zero deposit, no card hold and full coverage
  represented for the agreed Ride24 tariff? What if a field is null?
- Exact status enum for confirmed/rejected/cancelled bookings; are received
  bookings automatically confirmed or approved later?
- Is customer.birthDay optional on /reservations/save? Ride24 currently
  stores driver age; supplying a fabricated DOB is forbidden.
- Does agencyReservationReference provide server-side duplicate prevention?
  How long is reservationToken valid? Is there a lookup by agency reference?
- How do mandatory and optional extras affect the grand total when selected?
  Can supplier provide a sandbox for safe end-to-end cancellation tests?

No live Arvent reservation, cancellation, catalog sync, API-auth test or payment
has been performed or claimed on the basis of these synthetic Postman examples.

## 2026-11-18 — Mustafa's confirmation (Indi Yazılım)

**Live-only endpoint:** there is NO sandbox. Read-only authentication, locations,
catalog and offers are permitted. Supplier-side booking tests are REAL, even if
test customers are used; use only short rentals 2–3 months in the future and
cancel them promptly in coordination with Arvent. The live reservation and
cancellation tests have NOT been run by Ride24.

**Supplier status enum:**
| Code | Meaning | Conservative Ride24 treatment |
| --- | --- | --- |
| 0 | Received | Pending; no voucher |
| 1 | Approved | Confirmed, subject to price/terms verification |
| 2 | Payment completed | Pending/manual; do not infer approval |
| 3 | Cancelled | Cancelled |
| 4 | Awaiting payment | Pending |
| 5 | Vehicle handed over | Pending/manual if not already finalized |
| 6 | Unapproved | Pending/manual; ask whether final rejection |
| -4 | Synthetic Postman example only; contradicts actual enum | Unknown/manual; never infer cancellation |

Birth date, **if required by a particular supplier/offer**, must use
`dd.MM.yyyy`. Do not infer it from driver age. `paymentType=3` (POA) is
permitted; `pricing.paidAmount=0` only where all rental-related charges,
including selected/mandatory extras and one-way fee, are payable on arrival.
The separate Ride24 Stripe booking fee NEVER enters the supplier payload.

The agency reference does NOT guarantee idempotency. The adapter now has
an explicit **read-only lookup by agency reference plus original email** to
assist reconciliation. After an ambiguous create response/timeout, absence
of a result is NOT proof that creation failed: do not retry POST until
supplier existence is conclusively resolved. This lookup is not yet wired
to the paid fulfillment workflow.

**Still requires written confirmation from Arvent (not from kolayCAR):**
1. EUR quotes are the agreed NET pickup-payable amounts; partner discount is 0%.
2. No deposit, no credit card/hold, unlimited mileage and full insurance are
   actually configured on the tenant for every advertised rate.
3. Exact category substitution policy (kolayCAR itself has no upgrade feature).
4. Are bookings auto-approved or does status 0 require human approval?
5. Does `6=Unapproved` mean definitively rejected?
6. Which offers require DOB; how to record it in Ride24 without inventing PII?
7. Whether required/selected extras and one-way fees are all POA and are
   included in `totalPrice` before a booking is created.

**Release gate remains intact:** Arvent is disabled in Supabase,
no credentials are currently persisted, admin activation is blocked,
provider write flag is unset, no paid-fulfillment integration or live
reservation has been certified.

## Follow-up safeguards — 18 November 2026

- Supplier `Approved` must match the exact original Ride24 pickup and
  return location IDs, calendar dates and local clock times, as well as
  rental total EUR / zero deposit / no credit-card hold / unlimited KM.
  A mismatch stays `pending` and requires manual review; never issue voucher.
- A supplier HTTP 401 on a booking/cancellation **POST** is not replayed
  automatically. Read-only GET may refresh the Bearer once.
- Initial location synchronization is restricted to the ten agreed airport
  IATA codes **SAW, IST, SZF, ASR, DLM, AYT, ADB, EDO, AOE, TZX**.
  Missing or ambiguous IATA/locationCode stays disabled until an explicit
  supplier-to-Ride24 location mapping can be verified. Existing Erdem at
  ADB/BJV remains untouched.
- These are static safety checks and mocked-contract tests, NOT a claim
  of actual live-catalog acceptance or of supplier booking certification.
- Temporary branch-only GitHub Actions `push` trigger is in place while
  draft PR #105 has a merge conflict. Remove this temporary trigger before
  final production merge.

## 2026-11-18 — verified actual rental documents from Supabase Storage

Read source: two PDF v1.3 attachments sent on 2026-11-12 with the subject
"ride24 contract and document templates." Confirmed that the Storage objects
in `partners.rental_terms_url` and `partners.rental_rules_url` have exactly
the same byte length and MD5/Storage ETag as these two originals:

| Exact Storage object | Bytes | MD5 |
| --- | ---: | --- |
| `partner-documents/f781c993-8b26-4209-b3b8-11d0b544e4e1/versions/9adb25e5-0c7a-4f4f-9d24-756d77c74b71/terms.pdf` | 60878 | `b0532a5c4f62e2c8aca99d54186d8091` |
| `partner-documents/f781c993-8b26-4209-b3b8-11d0b544e4e1/versions/4161c7aa-660e-4346-ae87-ba7cf5315838/rules.pdf` | 56058 | `c08065aa5eedfd71ec3a9b1fdfd6962c` |

The two PDFs are **Arvent-specific**, bilingual EN/TR, dated 12 November 2026,
version 1.3. The fact that the Storage directory starts with
`f781c993...` instead of the Arvent partner ID is not evidence of wrong
content; cryptographic hashes match the received Arvent files byte-for-byte.

### Confirmed by the *customer-facing written terms*, not yet by live API

- Special EUR net rental amount, supplier gets 100%; Ride24 partner discount
  is 0%; independent Ride24 service fee; rental paid to Arvent in cash at pickup.
- No security deposit, credit card, or preauthorization/card hold for agreed
  Ride24 pilot offers.
- Included comprehensive rental insurance for covered risks and **zero excess
  only when the policy requirements are met**. No mandatory insurance top-up
  for already included cover.
- Unlimited mileage. Complimentary minor cosmetic-damage cover up to
  TRY 10,000.
- **Tire punctures/damage are excluded** from comprehensive and minor damage
  insurance. Renter may owe actual, justified repair/replacement costs.
- Booking by vehicle category. Equivalent or higher-category vehicle is allowed
  under accepted terms without unexpected costs. Material substitution requires
  customer consent before charging Ride24's fee.
- Duration minimum billing unit 24 hours; return grace 2 hours, thereafter
  a full additional rental day.
- Driver guidance only (subject to category-level supplier confirmation):
  economy age >=21 and license >=2y; intermediate >=25 and license >=2y;
  upper classes >=28 and license >=5y.
- Arvent pilot rental cancellation: at least 24h before pickup is free;
  **no automatic Arvent penalty within 24h or for no-show** during pilot.
  Separate Ride24 service fee refund is governed by Ride24 customer terms
  and law, not automatically by Arvent's free cancellation.
- Rental handover requires authorization, relevant license/identity document,
  accepted fuel terms, and insurance exclusions/official accident documents.

### Launch blocker: payment sequence discrepancy

**Do not gloss over this conflict.** The documents say that Arvent receives
the API request, confirms or declines, and **the customer pays the separate
Ride24 online service fee after Arvent has confirmed** (Customer Policy
section 1; Rental Terms sections 2 and 5). The current API paid-fulfillment
design **takes the Stripe fee first, then rechecks the offer and creates the
supplier reservation**. These are materially different commitments.

Before launch, either:
1. Obtain written agreement from Arvent to the actual paid-fulfillment order
   and update the customer-facing policy and terms accordingly before
   accepting any bookings, **or**
2. Implement and thoroughly test a supplier-first (approved, unpaid), then
   Stripe, then voucher flow including expiry/cancellation/late payment.

The existing live adapter is gated and must stay gated until the documents
and actual process agree. Do not silently edit signed/accepted PDFs.

### Remaining supplier verification

The written PDFs resolve **what the commercial policy promises**, not **whether
the production easyCAR tenant actually returns the promised amounts/terms**.
Supplier still needs to confirm live EUR net pricing, insurance flags and
category-level eligibility, and whether status 0 requires manual approval.
Read-only authenticated API probes and a controlled real booking/cancellation
test remain required. Customer-facing tire exclusion must remain visible.


## 2026-11-18 — live, read-only supplier validation (NO booking writes)

Authenticated against the **live** Arvent REST host using the credentials
already supplied in the original user-provided integration materials.
The credentials were stored in Ride24's existing protected server-side
`partner_api_credentials` record. Neither credentials nor Bearer token
were sent to GitHub, logs or the client.

- `POST /users/authenticate`: HTTP 200, business success, Bearer returned.
- `GET /locations`: HTTP 200, **13** supplier locations.
  - Contracted available airport IDs: **SAW=1, IST=4, SZF=6, ASR=5,
    DLM=13, AYT=12, ADB=10, TZX=9**.
  - EDO and AOE were **not present** in the actual supplier response.
  - ESB, GZT, BJV and two Alanya locations are outside the rollout
    allowance; do not enable them. Preserve existing Erdem ADB/BJV.
  - Supplier IATA anomalies: `"(ADB)"` for Izmir and blank IATA but
    explicit `"(TZX)"` in the Trabzon airport name. The adapter now
    handles these exact cases without city-based guesses.
- `GET /locations/cities?countryCode=TR`: HTTP 200, **82** cities.
- `GET /vehicles/list?languageCode=EN`: HTTP 200, **415**
  catalogue items. Only **203** have complete four-letter SIPP codes;
  **212** have no code. Missing SIPP cannot be replaced by an invented
  class identifier.
- Live availability AYT, pickup/return **16–18 February 2027**,
  EUR, 10:00: HTTP 200, **78** offers. All 78 explicitly returned
  zero deposit, no card required and unlimited mileage; **55**
  offers also have a valid four-letter SIPP code.
- Same search SAW: the first 10-second call timed out; a 25-second
  read-only retry returned HTTP 200 with **68** offers; **46**
  with valid SIPP. All 68 had zero deposit/card hold and unlimited KM
  fields, in EUR.
- Live `GET /extras` for an AYT offer (vehicle 1, €58.76 total for
  two days): HTTP 200. Response was `{vehicle: {...}, extras: null}`,
  so the adapter was adjusted to accept this **only** with price,
  route and no-deposit/card/KM verification of the returned vehicle.
  This does not certify priced optional extras for other offers.

### Production database — safe, unpublished metadata stage

- Successful connection evidence recorded (`last_test_ok=true`).
- **8** real contracted airport records staged, `active=false`.
- **203** SIPP-mappable category records staged, `active=false`,
  `public_price=0`; static catalog prices are never fabricated.
- Partner remains `api_provider='custom'`, `api_enabled=false`,
  `api_status='draft'`; no full admin sync `last_sync_at` and
  no deployment. Other partners unchanged.
- No supplier booking or cancellation POST, no Stripe customer payment
  and no confirmed voucher have been executed.

### Hard launch blockers — signed/accepted flow and provider confirmation

The customer-facing EN/TR v1.3 documents (and the supplier's full B2B
draft) say **Arvent approval precedes Ride24's separate Stripe fee**.
The current Ride24 API paid fulfillment does **Stripe first, supplier
reservation second**. A signed/agreed policy amendment or a safely
implemented supplier-first branch is required. Do not enable selling
simply because live search works.

The full B2B agreement *draft* sent on 12 Nov also calls for end-to-end
acceptance and **mutual written launch confirmation**. The accepted
partner-agreement PDF on the account is a separate *temporary short
agreement*, so do not claim that draft was signed without checking.
Approval behavior of status=0 and definitive meaning of status=6,
supplier-supported timeout/duplicate recovery, optional extras,
one-way charges and passenger DOB requirements still require explicit
end-to-end certification.

Read-only test evidence is not a substitute for an actual reservation,
immediate confirmed cancellation, Stripe refund path, voucher/notification
and other-provider regression tests.

## 2026-11-18 — normalized ACRISS/SIPP group model on current main

The user requires **vehicle groups, not individual supplier cars**. Like
AVIA, Ride24 groups by stable **four-character SIPP/ACRISS group** and
assigns that group to its existing A-F taxonomy:
A Economy, B Compact, C Sedan, D SUV, E Premium, F Van / Family.
This preserves transmission/body differences that would be lost if all
groups were collapsed to only six prices.

The live supplier returned 415 vehicle catalogue entries, of which 203
had complete SIPP; these collapsed to 87 unique codes. One code
(`ODBD`) could not be mapped safely by the existing Ride24 taxonomy,
so **86 distinct groups** were staged in production Supabase under
Arvent only. Counts:
A=15, B=12, C=16, D=18, E=13, F=12.

The 203 previously staged individual model rows (with no linked bookings,
quotes, discounts or seasonal prices) were atomically replaced with
the 86 group rows. All remain **inactive**, with zero static prices;
real supplier EUR rates only come from live availability, not the
catalogue. Example model and representative photo are metadata only.
No exact make/model is guaranteed by a group booking.

`arventOfferRows` now emits **one eligible cheapest offer per SIPP**.
Its `external_id` is the SIPP group (not `vehicleId`).
The specific selected supplier `vehicleId`, quote price and
the SIPP remain in private `provider_quote_data`, and
`arventCreateBooking` rechecks that exact supplier offer
against the original SIPP and payment snapshot using a fresh
`reservationToken`. A category cannot silently change on checkout.
Within one SIPP there can be inconsistent representative seat counts;
class mapping therefore uses the SIPP code, not a single car's seats.

Normalized airport names are stable for the **8 actually returned**
contracted airports (SAW, IST, SZF, ASR, DLM, AYT, ADB, TZX),
independent of the supplier spelling and case.
EDO/AOE were not supplied and were not invented.

### Integration status and invariants

- New clean <https://github.com/expol1/ride24/pull/119> started from
  current `main`, resolving the original <https://github.com/expol1/ride24/pull/105>
  merge conflict without overwriting Caravel or AVIA.
- Run new PR CI including all original Caravel/voucher/payment tests,
  *plus* the three isolated Arvent tests. Do not merge with failing tests.
- `partner_api_credentials.last_test_ok=true` records real supplier auth/GET;
  `last_sync_at` stays null until certified admin synchronization.
- Arvent partner remains `api_provider=custom`, `api_enabled=false`,
  `api_status=draft`, with all 86 classes and 8 locations inactive.
- B2B/customer terms specify Arvent approval BEFORE Stripe charge,
  while the standard Ride24 API paid-workflow is Stripe-first. Do not
  bypass this contractual launch gate or the explicit supplier write
  guard. Obtaining mutually agreed payment ordering, then live
  supplier booking/cancellation and end-to-end voucher certification
  is mandatory before customer-facing activation.
