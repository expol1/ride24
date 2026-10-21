# API readiness review — 2026-10-21

## Verified production state

GitHub base: a07c8f8d5084d97e7a46ff035c1505e105762b3d.
Supabase project: zwyerdeuvyzgkgwglowr.
No enabled API partners, saved API credentials, API quotes, API bookings or
API-managed locations were present at the start of this review.

Current local partners continue using the existing WEB/Android pricing engine.
The API path has preliminary provider adapters and conservative guards. It does
not yet implement full optional-service selection, supplier repricing and API
line-item snapshots. Local advanced fee rules remain blocked on that path.

## Narrow corrections

1. Easy Web Rent location normalization now preserves return_fee_amount
   independently of extra_fee_amount. Missing fees stay unknown; invalid,
   negative, boolean, array and object amounts reject the import.
2. API search includes return_fee_amount in both location queries and response
   metadata. It does not add that fee to supplier totals or bypass existing guards.
3. Admin GET/test/sync responses include a factual capability matrix. A successful
   technical connection is not labelled as full-price or production certification.
4. The existing API modal displays this matrix, missing adapter work and blocking
   local supplement configuration. No secrets are included in this response.
5. The requirements and supplier acceptance cases are specified in
   docs/API_MODERN_PRICING_ACCEPTANCE.md. Easy Web Rent endpoint presets are now
   explicitly labelled preliminary rather than publicly verified contracts.

## Remaining integration work

For a chosen supplier, implement and verify complete tax-inclusive quotes,
mandatory location/time/route fees, closures, an optional catalogue with prices
and quantities, supplier repricing and consistent snapshots for WEB, Android and
PDF. For Renteon, the ExBooking/Create and Calculate stages must be incorporated
before customer quote acceptance, using that tenant's API model and pricelists.
Availability alone does not establish full supplement support.

This is not completed by entering credentials or by marking a checkbox. A
provider-specific adapter implementation plus sandbox acceptance is required.
No integration or full-feature readiness was certified during this task.

## Validation and deployment

- 107 automated tests cover API, current supplements, night/route charges,
  booking acceptance, ownership, loyalty, WEB, native contracts, vouchers and
  payment return. The schema suite includes 23 isolated ownership checks.
- Supplier requests, notifications and payments in those tests are simulated.
- Production search returned 200 with an empty list (no API partners enabled).
  The admin endpoint rejected an unauthenticated request with 401.
- Fleet, location, extra, time/conditional fee and partner commercial
  fingerprints matched before/after the change.
- No database migration, partner activation, credential write, account change,
  Storage change or production reservation was performed.
- Updated functions: api-partner-admin v17, search-api v56.
  JWT/import-map settings and unmodified production dependency files were retained.
- WEB publication and GitHub checks are recorded in api-readiness-verification.json.

## Recovery

Code backup branch: backup/before-api-readiness-20261021.
Exact original function bundles are in backups/api-readiness-20261021.
Redeploy the corresponding saved files and original JWT/import-map settings to
restore only a function. Revert this task's PR to restore the WEB change while
preserving later work. No data rollback is needed; do not restore older partner
prices, locations or financial records.
