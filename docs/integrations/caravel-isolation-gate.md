# Caravel — isolated integration gate (AVIA protected)

Scope: `feature/caravel-sandbox-integration` / PR #81. Do not modify `search-api`, `provider-adapters`, `partner-api`, AVIA/Renteon, production secrets, or partner activation while Work is implementing AVIA.

## Confirmed (13 Nov 2026)
- Caravel adapter and validation are isolated in `supabase/functions/_shared/caravel-*.ts`.
- Mocked API tests exist in `tests/caravel-*.test.mjs`; **mock tests are not live API certification**.
- Attempt from this environment to resolve `sandbox-api.caravelway.com` failed DNS. Do not infer provider outage.
- Supabase partner `Caravel Rent a Car` (`78721481-7619-44df-a9b7-5faa344b69bb`) is `api_enabled=false`, `api_status=draft`; no successful live test/sync timestamps.
- PR #81 is draft and unmerged; no GitHub workflow runs returned for the current head. Do not claim CI success.

## Independent checks still required
1. From a trusted server with access to the secret, confirm sandbox DNS, TLS, authentication and OpenAPI contract. Never print credentials or PII.
2. Validate endpoint methods/paths and payloads against the **actual** OpenAPI before trusting the adapter's assumed paths. Fail closed on unknown fields.
3. Read-only sandbox requests: capabilities, suppliers, locations, vehicle classes, availability for documented locations/dates.
4. Validate Premium only, zero deposit/excess, payable-at-counter model, payment methods, mileage and exclusions from provider source; preserve unsupported/unknown values as blocked.
5. Verify mandatory fees, night-hour fees, optional extras, rental minimum, age, currency and totals using provider's authoritative quote. No double counting and no guessed rental days.
6. Run local `node --experimental-strip-types --test tests/caravel-sandbox-adapter.test.mjs tests/caravel-verified-rules.test.mjs tests/caravel-quote-verification.test.mjs` and TypeScript checks; record actual results.
7. Only with validated sandbox contract, perform fake-customer quote, booking, status and cancellation; check idempotency, expiry and errors.
8. Prepare a documented Caravel->Ride24 normalized contract for existing `normalizeGroups`, `normalizeLocations`, `car_classes`, `partner_locations` and `search-api`. **Do not wire production dispatch until Work confirms AVIA stabilization and a coordinated integration window.**

## Release blockers
- Real sandbox access and verified OpenAPI mapping.
- Live sample offers, prices, fees, extras and rules.
- End-to-end sandbox booking and cancellation.
- CI passing and non-regression tests.
- Joint review of shared Ride24 integration points with Work.
- Explicit enablement decision; no automatic `api_enabled=true`.

## Conflict policy
No merge to `main`, no Supabase production deploy, no changes to AVIA/shared dispatch or schema in this isolated phase. Any shared-code changes require coordination with Work after AVIA is stable.
