# Standard partnership agreement v2.0 — release candidate

Base production commit: `5ddd023d7da510a9c5e48c09d45d7bb5c1510842`.

The existing generator in `partner-dashboard.html` now contains all 17 sections supplied by the owner. The full supplied source is retained in `docs/standard-partnership-agreement-v2.0.txt`. Standard contracts use the English text in every panel language, with an explicit English-document notice. Individual PDF language routing remains unchanged. Standard acceptance submits v2.0 through the existing RPC; the exact displayed HTML, currency and existing electronic evidence are captured. Partner fields are HTML-escaped. No schema, RLS, RPC, account, discount, price, rental-document, payment, API, notification or Android change is included.

## Contracting-party identity confirmed

The owner confirmed that Emilia Sowa personally operates Ride24.pl as unregistered activity in Poland. The preamble now identifies Emilia Sowa as the contracting party operating under that brand, and section 1.4 states that both parties act independently and on their own behalf. No separate legal entity or registration number is invented.

## Consistency review (not a formal legal opinion)

- Sections 11.3–11.6 allocate responsibility mutually and preserve liability that mandatory law forbids excluding. The carve-out must control the indirect-loss exclusion. Polish Civil Code art. 473 §2 prohibits excluding intentional damage liability.
- Section 15 chooses Polish law, but leaves jurisdiction to applicable rules. It does NOT promise exclusive Szczecin jurisdiction. This follows the supplied text; do not silently reintroduce exclusive venue.
- Section 12 is a framework, not a substitute for identifying controller/processor roles, necessary processing arrangements, or safeguards for transfers outside the EEA. GDPR Chapter V remains applicable where required; no new data flows are introduced here.
- Section 16 appropriately avoids claiming a qualified electronic signature. The UI wording is aligned. Existing acceptance and evidence collection are unchanged.
- Individual arrangements prevail under section 17.2. Arvent already has an assigned individual PDF and must remain on that route; this change does not approve, replace or revise its exclusivity terms.

Sources consulted: https://api.sejm.gov.pl/eli/acts/DU/2026/795/text.html ; https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679 ; https://www.biznes.gov.pl/pl/portal/00120 . Supabase changelog checked; no dependency or Supabase implementation change required.

## Production read-only baseline

30 partner records: 24 accepted (13 v1.1, 10 v1.3, 1 individual PDF), 6 pending. Five pending standard partners are eligible: Mitrans Mobility, KKrental, Ruffo, AN GROUP, Legend World. Arvent has an individual PDF and is excluded. No production signature was executed and no account was reset. Production evidence hashes were read for comparison, not published with personal metadata.

## Validation completed locally

- 33 Node test-runner tests passed across standard agreement, custom PDFs, panel languages and onboarding; the onboarding suite includes 27 assertions/scenarios internally.
- Every numbered clause of the supplied document is compared against rendered text; all 17 section headings, zero discount, identity fields, country and currency are checked.
- Actual frontend signing function executes against an isolated test account with mocked Auth/RPC; verifies exact snapshot, version, timestamp, IP and user-agent.
- Isolated PGlite PostgreSQL test executes the current standard acceptance function from the migration (checked against the live definition): exact snapshot/version/time, duplicate rejection, existing v1.3 protection and both individual-document guards pass.
- Signed-preview code and individual-PDF implementation are unchanged. No live account signature or complete production browser acceptance test is claimed.
- `git diff --check` passed.

## Deployment and rollback

After successful tests, verify current main and production partner statuses, then use the existing GitHub/Cloudflare Pages pipeline. Check CI and the deployment check, retrieve the published dashboard and verify v2.0, then compare signed evidence hashes and individual-document checksums. Do not update pending database version fields: they record the accepted version only when acceptance succeeds.

Rollback: revert this release's frontend commit through the normal pipeline, preserving subsequent unrelated commits. The base commit above retains the prior generator. Never restore an old database or overwrite any snapshot, even if a partner has accepted v2.0 after deployment; historical previews use saved content and remain readable independently of the current generator.

## Existing unrelated CI failure

API compatibility checks fail in two adapter tests because the test sandbox does not handle the existing `./renteon-aggregator.ts` import. Both failures were reproduced on untouched production commit `5ddd023d7da510a9c5e48c09d45d7bb5c1510842` in a detached worktree. API implementation and tests are outside this change and remain untouched. Agreement, custom-PDF, onboarding and language tests passed after operator identity correction.
