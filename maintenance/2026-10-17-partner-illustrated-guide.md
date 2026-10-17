# Illustrated partner guide — 17 October 2026

The partner dashboard's existing guide modal now contains the supplied eight-language
manual, with native chapter navigation and screenshots rather than a 193-page PDF embed.
The modal's outer size, blue header, overlay and existing open/close entry point are retained.
On narrow screens, a chapter selector replaces the long sidebar. Screenshot enlargement
stays inside the same modal. Language selection is independent of the dashboard PL/EN
setting and persists under `ride24_partner_guide_language` only.

## Source and scope

- Baseline main: `8bea5ec4867c729612316c1926e5406152dae1d7`.
- Backup branch: `backup/before-partner-manual-20261017` at that exact baseline.
- Source: `Ride24_Partner_Manual_FINAL_8_languages.pdf` (193 pages).
- Source SHA-256 is recorded in `assets/partner-guide/manual.json`.
- Languages: PL, EN, IT, FR, EL, RU, ES and DE.
- All 21 instructional screenshots and the sample voucher are shared across translations.
  Test contact details visible in source screenshots are obscured in published derivatives.
  The unmodified PDF and temporary previews are not included in the repository.
- Corrected the PDF descriptions of company-wide extras and their actual form fields;
  clarified separate pickup/return fees and English location names in all eight languages.
- Retained API-partner guidance and filtering of manual fleet/location configuration.
- No database, Auth, Storage, Edge Function, booking, payment, pricing, Android or token changes.

## Validation

- `node --test tests/backend-hardening/test-partner-guide.mjs`: 7/7 passed.
  Includes all languages and chapters, screenshot existence, independent preferences,
  API/local filtering, failed/malformed response recovery, keyboard/focus/scroll handling,
  screenshot enlargement/retry and dashboard JavaScript syntax.
- `node tests/backend-hardening/test-partner-onboarding.mjs`: 14/14 passed.
  Isolated tests; no production accounts, signatures, files or emails created or changed.
- Compared the complete dashboard with the baseline after excluding only the manual
  markup, its two hooks and its stylesheet/script imports: all other bytes are identical.
- `node --check assets/helper/partnerGuide.js` and `git diff --check`: passed.
- Responsive CSS was reviewed. Full real-browser visual review of the local fixture was
  unavailable in this environment; no authenticated production partner session was used.

## Rollback

Revert the guide PR/commit, resolving any later edits to the dashboard rather than
resetting `main`. The backup branch contains the old guide and complete original HTML.
Unused new guide assets can remain during an urgent rollback; no data restore is needed.
