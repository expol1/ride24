# Ride24 referral pilot

10% of actual PLN payment, after loyalty discount. Read-time calculation from bookings and payment rows, not a cron or trigger. No changes to Stripe, cancellation, refunds, prices or booking functions. No new cloud projects, Edge Functions, extensions, background jobs, analytics, external QR APIs or paid dependencies. Supabase organization verified Free on 2026-11-10, database approximately 263 MB before install (not a complete monthly usage audit).

## Operations

/admin/polecenia.html uses the existing admin session. Create an approved referrer, give them link/locally generated QR, then track referrals. Activate/deactivate a referrer separately. Programme switch blocks attribution, approvals and payout marking. Use `disable.sql` for immediate database rollback without deleting the ledger. UI changes can be reverted independently; no schema teardown is needed, and no original rows, columns or functions were modified (one additive payment lookup index). Keep the private schema for accounting history.

Referral links require explicit browser storage opt-in for 30 days. Manual code overrides saved code. No click collection; only an authenticated owner can attach a code to a newly created, unpaid booking (10 minutes). Code is immutable once attached. Self-referrals matching email are rejected; this is not identity verification. Initial integration is WWW only; native Android attribution is not implemented.

Admin sees up to 500 latest referrals and 100 payout records. This is a small pilot, not an unlimited dashboard. Before exceeding 500 referrals, add pagination; server rechecks the full approved balance and rejects a partial amount, so a truncated list cannot silently underpay. CSV has no renter personal data. Referrers receive no database access. Settle manually monthly from 100 PLN, after verifying realization and any disputes. No live Stripe dispute lookup is added: unresolved cases must be flagged via existing manual_review/refund handling. A payment record mismatch, foreign currency or mixed payments is held. Late cancellation of a marked payout becomes correction_required; never silently erase payout history.

A positive payment does not create a stored commission row: the separate immutable referral and rate plus existing payment produce the current commission in the report. Cancellation is reflected immediately on next read and rechecked under booking row locks when approving/marking a payout. No amount is trusted from the browser. No automated transfers. Banking/accounting documentation and partner agreement acceptance remain operational steps, not generated legal documents.

## Validation / revert

Run node tests/backend-hardening/test-affiliate-db.mjs and test-affiliate-ui.mjs. Tests use PGlite PostgreSQL and JSDOM. Production receives schema only, never test bookings/payments or emails. Install starts disabled. Run security advisors and verify anon/non-admin guards before activation. One server-side switch preserves history and disables the pilot. Revert only affiliate UI commit if needed; preserve concurrent unrelated changes.

## Deployment verification (2026-11-10)

Hosted migration 20261110192536. Installed disabled with zero referrers/referrals, anonymous RPC execution denied and authenticated direct-table access denied. Tests: 40 database checks, 25 UI checks, 17 existing client/custom-agreement regression tests. Interactive browser screenshot validation was blocked by the execution environment (no claim of real device validation). Frontend layout has responsive cards, filters, summaries and native accessible dialogs; QR generation is bundled locally.
