# Partner WEB panel — French and language audit, 2026-10-24

Base: `60ac141e09e681a73662ffd214f4bfb3c809bd77`.
Recovery branch: `backup/before-partner-french-20261024`.

The existing language release was present on current main. Its source files
matched the previous release, and Cloudflare reported a successful deployment
for the current base. The unmodified language and guide suite passed all 20 tests.

French is added as the eighth partner-panel language, alongside EN, PL, ES, EL,
IT, DE and RU. It has a local circular flag, a dropdown option and all 499 UI
catalogue entries. The existing illustrated guide already contains French and
follows the panel unless a separate guide language was explicitly selected.

The existing browser-language selection recognizes fr-FR, fr-CA and fr-BE.
The partner's saved choice still takes priority, is remembered in that browser
and is not written to Auth or database records. Unsupported languages fall back
to EN. No IP lookup or remote translation service is introduced.

The original source catalogue and all earlier language dictionaries are unchanged.
French preserves template parameters and displays partner names, entered data,
location identifiers, catalogue names and numeric amounts in their original form.
Legal agreement content remains the original PL/EN template; surrounding controls
and the explanation of the original document language are translated.

## Verification

All 74 tests in the language, guide, onboarding, extras UI, automatic time fees,
booking items and booking options suites passed. The onboarding suite also runs
14 isolated scenarios internally. Checks cover:

- Eight-language selection, browser variants, saved preference, denied storage,
  dropdown keyboard control and menu positioning in a narrow, short viewport.
- Complete catalogues, unchanged placeholders, safe plain-text output, local flags
  and the illustrated French guide.
- Unchanged actual vehicle/location form payloads across all eight languages,
  including exact pickup and return amounts.
- Unchanged extra names, unit prices, quantities and booking snapshot amounts.
- Preserved form nodes, typed values, stored Auth tokens and signed documents.
- Original legal template hashes and successful JavaScript syntax checks.
- Existing loyalty, optional-extra, night-fee, route-fee and unavailable-time tests.

These are isolated tests, without production bookings, payments, signatures,
emails, account changes or uploads. No database, Edge Function, Android project,
pricing rule or partner resource is modified by this change.

The production partner page redirected this browser to the public homepage
because it had no signed-in partner session. An authenticated visual check on
ride24.pl is therefore not claimed. Deployment checks verify publication through
the GitHub/Cloudflare result for the release commit.

## Recovery

Revert this feature's PR to restore the previous seven-language UI while retaining
subsequent work. The recovery branch preserves the original source for comparison.
No database restore or deletion of partner resources is required.
