# SEO automatic review and correction drafts — 24 October 2026

Published PL/EN pages are checked against their approved snapshot, sitemap and Google Search Console index inspection. Current-revision Business Profile posts are checked when they exist. Indexing delays, permissions, robots rules, canonical ambiguity and hosting failures remain distinct from justified editorial corrections. The monitor does not request or guarantee indexing.

Corrections remain unpublished drafts. Metadata repair reuses the existing content; content repair is limited to a rejected current Business Profile post or an exact substantial duplicate across different topics. AI must change the affected content, use current offer data, preserve paths and obey existing benefit safeguards. Manual drafts are never replaced. Original public snapshots and revision history remain intact until an administrator explicitly approves publication.

Limits: one automatic correction attempt per UTC day across workers, seven days between attempts for a document, at most two attempts against one published base revision, and a fresh diagnostic result within 48 hours. AI corrections share the original atomic daily generation quota. No daily counter, API credential or existing generation/recheck schedule is reset. The review worker checks up to two due documents every 15 minutes and normally schedules another check after 24 hours (six hours after a transient Google failure).

## Validation

- `npm run test:seo --prefix tests/backend-hardening`: 99 isolated scenarios across 57 passing Node test entries.
- Includes authorization, manual draft protection, shared quota, daily correction reservation, concurrency, cooldowns, upstream errors, unchanged AI output, historical post rejection, PL/EN metadata and admin DOM behavior.
- TypeScript semantic check for the handler dependency graph and `git diff --check` passed.
- Tests use isolated fixtures/JSDOM/PGlite. They do not claim authenticated visual testing or Google acceptance of production content.

## Staged rollout and recovery

Base: `a6da8f81a348a42ecaf990b38684af3dd643008a`; original production `admin-seo` version 12. Code recovery branch: `backup/before-seo-auto-review-20261024`.

The additive migration creates the review schedule and service-only daily correction reservation. `auto_review_enabled` defaults to false. Deploy the tested function, apply the migration, publish the admin assets, then enable only that flag and verify live diagnostics. Existing functions authenticate administrators or the existing cron secret; gateway JWT verification retains its previous setting.

A scoped status backup was saved before live review: `RIDE24-SEO-stan-przed-kontrola-20261024.zip` (79 SEO records, safe settings/schedules, guarded rollback SQL). It contains neither credentials nor partner/booking data and is not a full database backup. Verified Drive copy: https://drive.google.com/file/d/1fCalwJ7bLfPw5nsu1sUSL9cCQAA6SLEN/view?usp=drivesdk

Emergency stop: set `seo_settings.auto_review_enabled=false` for id 1. This stops automatic reviews/corrections while preserving manual actions and the original new-draft schedule. Unschedule only `ride24-seo-review` if needed. Restore only the modified function/admin files from the recovery branch; do not reset main or overwrite articles published afterward. Guarded status restoration from the ZIP applies only to unchanged document revisions/states, never deletes drafts and never resets AI quota.

## Production verification

PR #45 merged as `9164e788222e25b9e85db689a3f4c4cbbf2d5409`; all GitHub checks and the Cloudflare deployment passed. `admin-seo` version 13 and the additive migration were read back, then automatic review was enabled. All 55 published pairs were checked through the production function (110 managed page URLs). All checks returned HTTP 200; no page, metadata, sitemap or Google connection issue was recorded by the initial scan. Google reported 56 URLs indexed: 27 complete PL/EN pairs were healthy and 28 pairs still awaited confirmation for at least one language. No correction draft was needed.

The published-snapshot digest, all 79 document revision/state pairs, 48 historical revisions, six stored credential ciphertext fingerprints and the existing AI budget (5/5 on 24 October) remained unchanged. New review timestamps and Google diagnostics are the intended writes.

The scan also exposed a legacy Business Profile status `processing` with an empty post-ID map. A follow-up check reads Business Profile even in this case, can recover exact current-version matches without posting, and labels an unconfirmed publication accurately instead of claiming Google is processing it. Search indexing and Business Profile posts are separate services. Search Console inspection describes Google's stored index, rather than a real-time indexing promise.
