# Smart Search: mapping queue and unsuccessful searches

## Scope

- Admin maps every country, region, city and exact pickup-point name to Polish.
  The list includes inactive/new partner locations and deduplicates shared names
  within their country/region. A missing Polish value remains in the queue.
- Exact airport/office/hotel names use the new dictionary category location.
  Partner location records and their original booking identifiers are untouched.
- “Tłumacz” opens the existing mapping form. “Przypisz” on a failed query carries
  that spelling into the selected existing entry's aliases. Saving updates by ID
  and retains the previous slug and aliases, preventing duplicate-slug failures.
- Search remains based on the same public dictionary. Rome → Rzym, for example,
  expands a Polish search back to the partner's original name.

## Logs

The homepage waits 1.5 seconds after a no-match result before reporting a stable
phrase, and cancels the report when the user continues typing or selects a point.
The same spelling is reported at most once per browser session per 30 minutes.
Inputs under 3 or over 80 characters and likely contact details are skipped.

The new dependency-free record-search-miss Edge Function validates the public
client API key, origin, method and input, limits requests to 30/IP/hour using an
irreversible keyed digest, and independently checks the dictionary and active
locations before inserting a phrase. A location filtered out only by return
partner eligibility is therefore not recorded as an unknown spelling.
Technical failures and lack of cars for a selected date are not spelling logs.

Only query, UUID and server timestamp are stored in search_logs. The existing
rate-limit store gets the keyed digest, never the raw IP. Log reads require the
stored admin role. Clients and partners cannot read or directly write logs.
The top-30 aggregate covers the last 90 days; resolved aliases disappear from
the admin queue without deleting their original logs. Existing retention jobs
are unchanged. This adds WEB collection; existing native Android binaries are
not modified and do not automatically gain this new telemetry.

The function handles publishable keys, not JWTs, so gateway verify_jwt is false
and the public key is explicitly checked in the handler. If the public site key
is rotated, update the allowlist in record-search-miss/index.ts together with
assets/helper/supabaseConfig.js. No service key is embedded in browser files.

## Verification

- npm run test:smart-search in tests/backend-hardening: DOM and handler tests,
  real migration in isolated PGlite, allow/deny checks for all affected roles.
- Existing native-booking contract regression covers price breakdowns, extras,
  loyalty and ownership; none of those implementations are changed here.
- Every inline script in the homepage/admin page is syntax checked by the suite.
- Production permission checks run inside a transaction that is rolled back:
  supabase/tests/smart_search_permissions.sql.
- Production checks and fingerprints are recorded in smart-search-verification.json.
- Chromium download was unavailable in the execution environment; DOM tests use
  jsdom and do not claim visual/device validation.

## Recovery

Code backup: backup/before-smart-search-repair-20261020 at
e4b73410a7cfc65b170e0391ee0f334832df6681.
The previous dictionary, policies and function definitions are in
backups/smart-search-20261020/database-before.json. Unrelated pricing/location
fingerprints are in the same directory.

To stop/revert the new UI and reporting, revert this change through its GitHub
pull request and publish that revert. Do not reset main to an old backup branch,
because that would discard later unrelated changes. The additive database
category/policies remain compatible with the old UI; preserve newly entered
translations and logs. No partner data, resources, booking/price changes or
existing cleanup jobs need to be restored or deleted.
