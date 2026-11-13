# Caravel Channel API v1.67.0 — sources and gap analysis (13 Nov 2026)

Branch `claude/caravel-finish`. Read-only analysis: no API key used, no booking, quote or write call made, no shared Ride24 code or Supabase touched.

## 1. What we have

| Question | Status | Source |
| --- | --- | --- |
| OpenAPI v1.67.0 | **Yes, public**: `GET https://sandbox-api.caravelway.com/v1/openapi.json` (OpenAPI 3.1.0, 33 paths, 67 schemas, served without a key). Not in the repo; a working copy was read outside the repo. | sandbox host |
| Full integration guide | **Yes, public**: partner pack `https://sandbox-api.caravelway.com/docs/packs/caravel/` (v1.67.0, incl. certification and settlement chapters). | sandbox host |
| Working sandbox | **Yes**: DNS resolves; `GET /health` → `{"ok":true,"api_version":"1.67.0"}`; `GET /v1/capabilities` → `environment: "sandbox"`. Earlier DNS failure (isolation gate) no longer reproduces. Authenticated calls → `401 unauthenticated` without a key (expected). | live probe, no key |
| Authentication spec | **Yes**: header `X-API-Key`; per-operation scopes (`read:reference`, `read:availability`, `write:quotes`, `write:bookings`, `read:settlements`); `Idempotency-Key` (client UUID) required on quote, booking create and cancel; webhooks signed with `X-Caravel-Signature` (HMAC-SHA256). | OpenAPI `securitySchemes` |
| Ride24 sandbox key | **Unknown / not available here.** Not in the repo (correct). Supabase secrets were not inspected (out of scope). Keys are self-service via `/portal/` or from Caravel. | — |
| Example responses | **Documentation examples only**: 230 response examples in the spec (locations, vehicles, extras, protections, fees, policies, availability, quote, bookings, cancel, errors). **No live responses for the Ride24 account** (needs a key). | OpenAPI examples |
| Settlement / Ride24 fee | **Not confirmed.** The API models commission the operator owes the partner (`/v1/settlements`: expected/received/adjusted/outstanding) and payment models `pay_on_arrival` / `partial` / `prepaid` per agreement; the guide states commission rates and the operator's net are *not* on the API surface. The Ride24 agreement terms are not in any project source. | partner pack, OpenAPI |

Other project sources checked: all branches and history of `expol1/ride24` (only the Caravel files on this branch, `maintenance/*` status notes "Caravel … disabled API drafts", `CLAUDE.md` on `chore/claude-agent-safety-setup-20261113`), PR #81 (draft, no reviews, no attachments), local Desktop/Documents/Downloads (nothing), Google Drive (nothing), Gmail (only a GitHub CI notification).

## 2. Differences: real API vs prepared code

### Adapter (`caravel-sandbox-adapter.ts`)
| # | Code today | Real API | Impact |
| --- | --- | --- | --- |
| A1 | `vehicleClasses()` calls `/v1/reference/vehicle-classes` | Path is **`/v1/reference/vehicles`** | Would 404. The existing test asserts the wrong path. |
| A2 | Error `requestId` read from top-level `request_id` | Error envelope is `{error:{code,message,request_id,doc_url}}` | Request id lost on errors. |
| A3 | Any non-empty `Idempotency-Key` | Must be a client-generated **UUID** | Possible `422`. |
| A4 | `availability()` sends no `driver_age`, `plan`, `currency` | `driver_age` prices age fees into the row; `plan` selects the price book | Indicative prices may omit age fees. |
| A5 | `quote()` input shape | Matches (`pickup/dropoff {location_id, at}`, `vehicle_id`, `protection_id`, `plan`, `drivers[{age, role, country?}]`, `extras[{extra_id, quantity 1–9}]`) | — |
| A6 | `bookSandbox()` `{quote_id, external_ref, drivers, customer}` | Matches the quoted-create shape; `customer {first_name*, last_name*, email*, phone, country, locale}`; drivers need names | Draft fields map 1:1. |
| A7 | `bookingStatusSandbox()` `GET /v1/bookings/{id}?ref_type=booking_id` | Matches (`ref_type` ∈ `external_ref` \| `booking_id`) | — |
| A8 | `cancelSandbox()` body `{expected_revision, reason}` | Matches | — |
| A9 | `isPremiumZeroRisk()` checks `plan` + `protection.excess/deposit` | Fields exist on availability rows; the guide warns tier names are **nominal** ("read the numbers, not the word"); `theft_excess` is a separate Money | Numbers already checked; `theft_excess` not checked (business decision). |

### Normalizer (`caravel-normalize.ts`, `caravel-booking.ts`)
| # | Code today | Real API | Impact |
| --- | --- | --- | --- |
| N1 | Location requires `active: boolean` | No such field; withdrawn records are simply not served | Mapper must set `active: true`. |
| N2 | Location `type`: airport/city/port/station/hotel | `airport`, `port`, `office`, `city`, `hotel`, `address` | `office`/`address` need a Ride24 mapping; `station` never occurs. |
| N3 | Country from `countryCode` (required) | `address.country` is **optional** | Locations without it are rejected (fail closed) — may drop desks. |
| N4 | Model shown as `makeModel + " or similar"` | `display_name` is already "model or similar" | Would duplicate "or similar" → use `display_name` as is. |
| N5 | One `bags` integer | `large_bags` + `small_bags`, both optional | Mapping rule needed; never default. |
| N6 | `seats` required | Optional ("never defaulted") | Reject vs show without seats: decision. |
| N7 | Fuel: petrol/diesel/hybrid/electric/lpg | petrol/diesel/hybrid/**plugin_hybrid**/electric (no lpg) | `plugin_hybrid` currently rejected. |
| N8 | Single `imageUrl` | `images[] {url, role}` (optional) | Pick rule (first / hero role). |
| N9 | Mileage `{unlimited}` or limit per day/rental | `meta.policies.mileage {type: unlimited\|limited, included_km_per_day}` | Fits; per-rental branch never used. |
| N10 | `creditCardRequired` / `cardHoldRequired` booleans | Not in API. Sources: `protection.deposit`, `policies.deposit_payment_methods`, conditions of hire `deposit_card_rules` | Badge rule must be derived and agreed. |
| N11 | `roadsideAssistance` boolean | No field (maybe protection `covers` codes) | Stays false until mapped. |
| N12 | Quote components rental/extras/mandatory/total | Quote returns `line_items[]` (`kind`: base_rate, protection, extra, fee, **discount** = negative) + `totals` (subtotal_ex_tax, tax_total, grand_total, **pay_now**, **pay_at_pickup**) | Components must be summed from lines by kind; negative discount lines are rejected today. |
| N13 | Fee categories out_of_hours_pickup/return, one_way, location, other | Fee `type`: young_driver, senior_driver, one_way, out_of_hours, premium_location, cross_border, delivery, … (no pickup/return split; refusals name the end) | Category model must be reworked; the out-of-hours check can use location `hours` + `timezone` + `out_of_hours {available, fee}`. |
| N14 | Extras `chargingUnit` rental/day/quantity | `pricing_type` per_day/per_rental; countability via `requires_quantity` + `quantity {min,max}`; **`price_cap`** per unit per rental; `payable` prepaid/at_pickup | Capped daily extras cannot use Ride24's local day×price formula; booster seats are inside `child_seat`. |
| N15 | Booking statuses incl. on_request/declined/rejected | `confirmed`, `pending`, `cancelled`, `no_show`, `completed` (open list) | Remove invented values; decide `no_show`/`completed` mapping. |
| N16 | — | Supplier has `currency`, `tax_inclusive`, `payment_models`; booking has a `payment` block (`amount_prepaid` / `amount_on_arrival`) | Needed for the Ride24 payable split. |

No code was changed for these items: fixes wait for the sandbox key (live examples) and the commercial terms below.

## 3. What actually blocks stage B
1. **No Ride24 sandbox API key** in this environment (self-service `/portal/` or from Caravel).
2. **Commercial terms unknown**: payment model, commission rate and settlement, whether Ride24 may add its own fee on top of `grand_total`, who collects which amount (online vs at the desk).
3. **Badge and deposit policy**: how `deposit`, `deposit_payment_methods` and `deposit_card_rules` translate into Ride24's "no credit card / no card hold".
4. **Premium definition**: zero `excess` and `deposit` confirmed in the API; `theft_excess` and exclusions need a decision.
5. **Certification**: the hosted certification run must be scheduled with Caravel before production.

## 4. Message to Caravel (draft, English)

> Subject: Ride24 — Channel API v1.67.0 sandbox access and commercial terms
>
> Hello Caravel team,
>
> We are integrating Ride24 with the Caravel Channel API v1.67.0 and have reviewed the public OpenAPI document and the partner pack on the sandbox host. To start sandbox testing and plan certification, could you please help with the following:
>
> 1. **Sandbox access** — please issue (or approve our portal request for) a sandbox API key for Ride24 with the scopes `read:reference`, `read:availability`, `write:quotes`, `write:bookings` and `read:settlements`. Please also tell us whether `partner_ip_allowlist` will apply to our account and, if so, how we register our server egress addresses.
> 2. **Suppliers** — which `supplier_id`(s) we will sell in sandbox and production, with their currency and `tax_inclusive` setting.
> 3. **Payment model** — which `payment_model`(s) our agreement permits (`pay_on_arrival`, `partial`, `prepaid`), and for each one which party collects `pay_now` and `pay_at_pickup` from the customer.
> 4. **Commission and settlement** — our commission rate and basis (grand total incl./excl. tax, extras, fees), the settlement period and remittance terms, and whether we may charge the customer a separate service fee on top of the supplier `grand_total`.
> 5. **Premium plan** — please confirm that on the `premium` plan `excess`, `theft_excess` and `deposit` are all zero for every vehicle group we may sell, and list any exclusions customers should see.
> 6. **Deposit and card requirements** — for zero-deposit protections, does the desk still require a credit card or place any card hold? How should `deposit_payment_methods` and `deposit_card_rules` be read in that case?
> 7. **Booking lifecycle** — the full current list of booking `status` values and recommended handling of `no_show` and `completed`; whether webhooks are recommended for status changes.
> 8. **Certification** — the steps and timeline for the hosted certification run and the criteria for production access.
>
> We will only use invented customer data in the sandbox and will not create production bookings before certification.
>
> Kind regards,
> [Name], Ride24
