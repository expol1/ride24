# SEO draft automation and correction audit — 2026-10-24

Base: `46e03a3c7d215755c2e420aec12b948c21f3333d`.
Recovery branch: `backup/before-seo-queue-fix-20261024`.
Production baseline: `admin-seo` version 11. All six deployed source files were
compared byte-for-byte with this GitHub baseline and matched before editing.

## Cause

The enabled hourly draft job was completing its HTTP request, but its HTTP 200
body contained `generation_error`: the oldest queued topic referred to an
inactive/renamed location. The same item was selected every hour, so later active
destinations never reached generation. Three obsolete Montenegro topic keys were
at the front of the queue. Their records must remain available for manual review.

The module and automatic generation are enabled; Free confirmation and the stored
Gemini key are present. The configured daily limit is five attempts. At inspection
on October 24 all five had already been used. This limit is preserved and is not
reset to force a live generation test.

## Change

The cron synchronizes topics against active partner offers, selects only empty,
unpublished queued documents whose topic still exists, and skips live locks.
It examines the queue before choosing a document, rather than limiting it to the
oldest single row. Dismissed topics, existing drafts and published content remain
excluded. A failed attempt updates its retry ordering so another pending topic
can progress next time. Each run still performs at most one AI attempt.

Disabled automation, missing Free confirmation/key, an empty eligible queue and
an exhausted quota now have distinct response reasons. A quota pause reports the
next eligible document without consuming an AI request or marking that document
as failed. The database's existing atomic quota and document claim remain the
final concurrency guards.

The generated browser SEO module was stale compared with the deployed core.
It is regenerated from the unchanged server core, and its import cache revisions
are advanced. The manually copied instruction now includes current offer facts,
conditional deposit/insurance claims and refundable-cash safeguards. Public SEO
articles and the server's pricing/offer-fact logic are not rewritten.

## Corrections and Google

The existing flow is retained: record Google's feedback, edit or regenerate PL/EN,
save a versioned draft, review both languages, explicitly approve publication,
retain existing URLs, verify the published revision and resubmit the sitemap.
History can restore an older text only as a draft. Google Business Profile post
rejection is shown separately; revised approved post copy can be submitted without
duplicating an already confirmed submission.

Search Console's index status is distinct from publication or sitemap acceptance.
Submitting a sitemap is not a guarantee of indexing. An API permission error is
also distinct from a request to improve editorial content.

## Verification

All 62 isolated scenarios passed: 16 core/security, 19 full flow, 8 PostgreSQL,
14 automatic-queue and 5 actual admin DOM scenarios (22 Node test entries).
The regression coverage includes stale queue entries, locks, concurrent workers,
quota rollover, provider errors, manual/dismissed/published record preservation,
Google rejection → feedback → correction → approval → same-URL publication →
resubmission, historical recovery and duplicate-post prevention.

The admin tests use its real markup and module with isolated external services;
they are not authenticated visual tests on production. No test SEO article or
Google post is published. AI quota and credential values are never reset or
exported. The new SEO CI workflow runs these isolated tests on subsequent changes.

The broader Smart Search CI exposed an existing test expectation: a non-admin
DELETE with table privilege is filtered to zero rows by RLS, rather than throwing
a permission exception. The isolated check now asserts zero returned/deleted rows
and confirms the dictionary entry remains. No Smart Search application, policy,
grant or production dictionary data is changed.

No schema migration, cron schedule change, booking, payment, partner, Android,
uploaded-file or retention change is included. Existing credentials are retained.

## Recovery

Revert this PR for the browser and source changes. Redeploy `admin-seo` using the
six original files from the recovery branch, preserving its existing custom
authorization (`verify_jwt=false`). No database restore or partner-resource
deletion is required.
