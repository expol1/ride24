# Caravel — real sandbox evidence and remaining gates (18 Nov 2026)

All results below are from the **real Caravel sandbox** (`https://sandbox-api.caravelway.com`),
called server-side from the temporary Supabase function `caravel-sandbox-live-audit`
(sandbox-only client, one-time operator token + JWT gateway, expires 2026-11-20 20:00 UTC,
no Ride24 table writes except the private service-role-only `caravel_sbx_reference_*` RPCs).
Nothing here touched production Caravel, Stripe, customers or Ride24 bookings.

## 1. Canonical SHA-256 of terms (§3.9) — VERIFIED on real documents

Rule (verbatim in `TermsDocument.content_hash`, OpenAPI v1.67.0 / partner pack): serialise
`body` as JSON, object keys sorted at every level, arrays in order, no insignificant
whitespace, `JSON.stringify` escaping, UTF-8, SHA-256. Implemented in
`supabase/functions/_shared/caravel-terms-canonical.ts` (strict `clauses/v1` schema,
string leaves only; fail closed otherwise). `fetchCaravelCurrentTermsForReview()` now
re-hashes every fetched body and refuses on mismatch.

| Supplier | document_id | version | declared = recomputed |
|---|---|---|---|
| EUR `acct_eaa0…` | `50000000-0000-4000-8000-0000000000d1` | 1 | `73f6c68c…d403329` ✔ |
| GBP `acct_a714…` | `50000000-0000-4000-8000-0000000000d3` | 1 | `73f6c68c…d403329` ✔ |

Both sandbox documents are titled *"Caravel Sandbox — Certification Rental Terms (NOT A
CONTRACT)"*. **The production EN v4 document named by Caravel on 17 Nov is not in the
sandbox**; its id/hash/clauses must be read with the production key.

## 2. Official HMAC self-test — PASSED (recorded by Caravel)

`POST /_certification/hmac-self-test` with the signature our verifier computed from the
official `fixtures/webhook-hmac-self-test.json` (fetched from Caravel's pack):

```
check: webhook.hmac_self_test   verified: true   signature_matches: true
tampered_rejected: true         attempts: 1
recorded_at: 2026-11-18T15:49:18.455Z   request_id: req_LrHmSwCowGN6twkc
```

Locally the same fixture is a CI test (`tests/caravel-terms-canonical.test.mjs`): signature
reproduced, tamper rejected, replay window (±300 s), wrong path rejected, rotation overlap.
No account webhook secret was created or rotated.

## 3. Real sandbox end-to-end (our adapter code) — 26/26 per supplier

`runCaravelAcceptance` (booking=true, Premium, invented data, `pay_on_arrival`):

| Step | EUR | GBP |
|---|---|---|
| capabilities (with key), whoami, suppliers, constants, reference sync | OK | OK |
| quote served plan / premium; replay same key → same quote; same key + other body → 422 `idempotency_key_reused` | OK | OK |
| unknown vehicle → 422 `validation_error` (stop) | OK | OK |
| `POST /v1/bookings` → `confirmed` rev 1 (`e02bffd8…` / `285b8009…`), replay → same booking | OK | OK |
| same quote, new key → 409 `quote_consumed` (requote) | OK | OK |
| cancel with wrong revision → 409 `revision_conflict`, state preserved | OK | OK |
| cancel → `cancelled` rev 2, fee 0; second cancel idempotent; GET confirms | OK | OK |

Sandbox Premium totals: EUR 132.00 (3 days), GBP 114.00. Sandbox protections carry
fictional non-zero deposit/excess (shared fixtures) — Ride24's publishability guard
correctly refuses them; production must be confirmed with a real quote.

## 4. Hosted certification run — all 10 phases executed

`POST /_certification/start` → run `15adba20-a018-4398-b460-4e335e846059`
(started 15:52:49 UTC, finished 15:56:07 UTC, status `done`, 10/10). Every phase ran the
full flow for both suppliers with the key on every request, then `advance`:

| Phase | What Caravel injected | Our client |
|---|---|---|
| baseline | nothing (bookings created + cancelled) | 30/29 steps OK |
| unknown-enum-value | location type `cert_zone_x` | kept record, quoted at it |
| unknown-error-code | one-shot 422 `cert_probe_unrecognized` on locations | degraded softly, next sync OK |
| unknown-response-field | unknown fields everywhere (booking + cancel) | all OK, nothing copied back |
| unknown-feature-code | unknown capability | ignored |
| opaque-id-tolerance | vehicle → `crt_v_dbef7aa4`, protection → `crt_p_ddaf4d96` (EUR) | re-synced, quoted with the new ids, no plan |
| shrunk-reference-refresh:1 | EUR refresh 3 of 4 vehicles | kept `veh_31b9eef9d3be` from stored catalogue and quoted it |
| shrunk-reference-refresh:2 | vehicle back | quoted under original id |
| deprecation-notice | deprecation + Sunset headers | kept using route |
| version-format | `api_version` `1.68` | accepted |

(The local runner's "ERROR SHRUNK_VEHICLE_OR_CONTROL_MISSING / RETURNED_VEHICLE_NOT_PRESERVED"
lines for **GBP** only mean Caravel injected the shrink on the EUR supplier; GBP had
nothing to shrink. No client break.)

**The verdict is not available through the API** — Caravel publishes it on the sandbox
account page. It must be read there (or requested from Caravel) before any claim of
"certified". `caravel_release_control.certified` stays `false` until then.

## 5. Ride24 integration state after this session

- Merged `origin/main` (145 commits incl. Stripe-first API payments and Arvent) into
  `claude/caravel-finish`; Caravel holds kept **before** main's logic in
  `create-booking-request`, `create_checkout_session`, `api-booking-dispatch`,
  `search-api`, `stripe-webhook`.
- Caravel now plugs into the **shared** Stripe-first fulfilment
  (`api-provider-fulfillment.ts` → `caravel-paid-fulfillment.ts`): revalidate (accepted
  quote + consent + current terms + fresh identical Premium quote) → one
  `POST /v1/bookings` with a booking-derived Idempotency-Key → verified confirmation →
  voucher via the existing finalisation. Ambiguous create → `unknown` + review queue,
  never re-sent. Terms changed after consent → refund of the Ride24 fee, never booked.
  Disabled unless `CARAVEL_PRODUCTION_WRITES_ALLOWED=true` **and**
  `CARAVEL_STRIPE_FIRST_APPROVED=true` (neither is set).

## 6. Still NOT done / NO-GO items

Caravel side:
1. Certification verdict for run `15adba20…` (account page) and production approval
   ("Request production" — a Ride24 owner action naming the legal/trading entity).
2. Production key (revealed once in the portal, stored only in
   `partner_api_credentials` with `api_url=https://api.caravelway.com`).
3. Production EN v4 terms via API (document_id, content_hash — we will re-verify),
   exact clause numbers for glass / tyres & wheels / undercarriage exclusions and the
   EUR 100 damage/theft administration fee.
4. A real production Premium quote proving deposit 0, excess 0, theft excess 0,
   pay_on_arrival, tax-inclusive, and the deposit/card rule (sandbox EUR policy lists
   `deposit_payment_methods: ["credit_card"]`, which contradicts "no credit card").
5. Production catalogue (supplier ids, locations, vehicle groups) to sync.

Ride24 side (cannot be finished without the above, or not available here):
6. WEB consent screen showing the verified `clauses/v1` body + exclusions + admin fee
   before Stripe, persisted into `bookings.caravel_terms_* / caravel_coverage_*`
   (columns and `caravel_commit_pending_booking` already deployed; renderer
   `renderCaravelTermsHtml` ready). Not wired: no Caravel offer exists to show.
7. Android: the Ride24 Android source is not in this repository/workstation, so no APK
   was built. Server-side enforcement means an app without the consent step cannot
   book Caravel (fail closed).
8. `search-api` → `issueVerifiedCaravelQuote` wiring, release-control switch, limited
   monitored production smoke, then partner activation through the reviewed admin route.

**Release decision: NO-GO** for Caravel offers or customer payments until 1–8 are done.
