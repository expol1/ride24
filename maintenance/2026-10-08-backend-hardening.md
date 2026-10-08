# Backend hardening — 2026-10-08

The deployed changes prevent profile role escalation, restrict administrative data, and authenticate scheduled email and voucher cleanup requests. Existing Android booking RPCs, search, the active checkout, payment return and push APIs retain their implementations and response formats. Website HTML/CSS/JavaScript and APKs are unchanged.

## Applied
- Preserve server-managed profile roles while retaining ordinary profile updates and Android-compatible upserts.
- Enable admin-only RLS on transactions and marketing_queue; restrict contact-message read/delete and marketing settings to admins.
- Make v_inactive_partners obey the underlying partners RLS, preserving administrator access.
- Add authorization gates to admin-refund, marketing-engine, generate-marketing-content, generate-marketing-image, publish-x and whatsapp-alert. The business code behind the gates is unchanged. Internal marketing calls retain service-key authentication; WhatsApp retains the worker's x-internal-secret.
- Authenticate email-worker and cleanup-storage cron calls through the existing Vault credential without embedding its value in SQL.
- Retain the original retention schedules: email logs 30 days; cancelled/rejected/payment_expired/expired bookings older than 180 days; vouchers under the existing 180-day/orphan rules. Paid booking rows are outside the current booking cleanup filter; that filter has not been broadened. Cleanup targets vouchers only, never partner vehicle images or documents.
- Keep a new private recovery bucket inaccessible to anon and authenticated roles.

The six SQL migration filenames match the production migration history. The transient suspension of retention jobs is recorded and followed by their resumption.

## Validation
Local PostgreSQL fixtures verify role protection, ordinary user/partner upserts, admin access, rollback and cron configuration. Authentication gates and original voucher retention/path validation are tested with isolated mocks. Production checks verify real role/RLS behavior in rolled-back transactions; email-worker and cleanup-storage return HTTP 200. The cleanup probe scanned/deleted zero records. Anonymous sensitive endpoint probes correctly return 401. No real booking, charge, refund, message publication or notification was triggered by the tests.

All existing booking/partner/pricing rows and the 112 original Storage objects were retained. A partner last_seen timestamp changed during normal activity. Eleven Android partner RPC definitions and the other 37 Edge Function versions were unchanged.

## Recovery
The website baseline is commit 0d500b7ddd0bf45f8aa3ba86f779036048c996e1, preserved on backup/before-backend-hardening-20261008.

A private encrypted recovery archive in bucket ride24-recovery, prefix 20261008-before-hardening, contains the pre-change data export/catalog, all 44 deployed Edge Functions with 78 source files, and all 112 original Storage files. AES-256-GCM parts and manifest were read back and SHA-256 verified. The Base64 key is in Vault under ride24_recovery_backup_key_20261008. No key, personal data, archive or credentials belong in this public repository. Library retention was blocked by its quota; no existing files were deleted to free space.

This recovery point supports reversing these changes in the same project. It is not a full pg_dump/PITR backup: Auth sessions and Edge environment-variable values are not exported. Keep the separately downloadable ZIP outside the project for independent recovery.

The ChatGPT ZIP download was not successfully retained and cannot currently be delivered through that link. For independent download from the private Supabase bucket and offline decryption, follow [the Polish download instructions](backup-download-pl.md). The offline restore utility verifies all part checksums, AES-GCM authentication and the original ZIP hash before saving any result.

Use maintenance/rollback scripts to undo the corresponding database configuration only; do not overwrite current business rows with old exports. Restore an Edge Function from the private snapshot using all its files and original verify_jwt setting. SQL role/RLS rollback intentionally restores the original weaker permissions and should be an explicit recovery action.

The cleanup function keeps an isolated copy of its deployed dependency under _live_shared so future selective deployment cannot accidentally substitute the older repository-wide helper. Other functions using the global helper are unaffected. The remaining deployed function sources are retained in the private archive; do not bulk-deploy the older repository without reconciliation.

## Prepared, not applied
The duplicate-index cleanup in maintenance/proposed was tested with rollback, but the connector twice returned invalid_request_state. A read-back confirmed that both duplicate indexes remain intact; no production migration was recorded.

Changes to payment processing, public voucher access, legacy checkout removal and OAuth integration are deferred pending compatibility/end-to-end checks on the existing production Android builds. No global JWT/RPC revocation or broad code deletion was performed.

## Reproduce the isolated checks
Use Node 22 or newer; run npm ci and npm test in tests/backend-hardening. These tests use synthetic fixtures and mocks, never production credentials.

Follow-up checks are recorded in [the Polish test report](2026-10-08-testy-pl.md). The suite now includes the actual deployed booking acceptance, rejection and partner-list RPC bodies in isolated synthetic fixtures.

Supabase references:
- https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public
- https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view
- https://supabase.com/docs/guides/database/database-linter?lint=0009_duplicate_index

