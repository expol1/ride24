# Native modernization — 16 October 2026

Both uploaded source archives passed CRC: client 1.0.14/code15 and partner 1.0.5/code6. Existing truthful vehicle-feature handling and partner notification fixes were already present; they were preserved.

Consolidated patch against these exact archives: maintenance/proposed/android-current-archives.patch. Includes server quote/acceptance, extras breakdown, same-owner location filtering before car limit, scoped return suggestions, return reset, country/keyword search, stale suggestion guards and presentation-only rounding. Native draft versions: client 1.0.15/code16; partner 1.0.6/code7. Client Firebase recovered from its production AAB; unique API key/app ID and matching project verified without logging values.

Client compileDebugKotlin passed with production Firebase config before the final version bump and embedded local-provider filter. That filter was verified by a read-only production REST call (HTTP 200). Partner first compile revealed missing Receipt icon import; fixed. A locale-specific breakdown now reads the app configuration locale. Full debug/release builds are running; no APK/AAB is release-ready yet.

Seven actual booking-handler scenarios passed with simulated DB, NBP, email and push: accepted quote stores exact totals, stale location/catalog prices reject, legacy paid location requires upgrade, legacy free flow preserves amounts, emergency disable rejects v2 without dropping selections, and v16 owner validation works with extras disabled. No real booking or notification was generated. Full voucher rendered with production Roboto fonts and bez.png, QR generated locally; both pages visually reviewed. Existing first page layout retained; appendix is legible and amounts split correctly between PLN online and rental currency.

An environment reset removed intermediate outputs. Both attachments were recovered from the same user message without requesting reupload. Full restored native projects (including client Firebase config, excluding private signing keys) saved privately on user's Google Drive:
https://drive.google.com/file/d/1iASgJOpHlm6J5dHhJDN_TjKhpW2IjMV0/view

Fresh scope backup, metadata verified: full main web at 86b4535; live create-booking-request v16, generate-voucher v122, stripe-webhook v81, create-checkout v49; locations and selected DB function/column definitions. It is not a full Auth/Storage dump.
https://drive.google.com/file/d/1RIiSGW0CXi_hjq5XAUy7wCCjNMsg_78G/view
Backup branch: backup/before-extras-rollout-20261016.

Latest production precheck: no extras tables/snapshot/return fee migration; five paid local locations. No production mutation performed so far. Deployment plan: additive schema with feature disabled, quote/partner-items endpoints, compatible voucher/booking functions and web. Leave charging disabled pending device checks and signed Android rollout. Preserve all existing booking snapshots, Stripe logic, prices and insurance. Do not restore an old whole database over current partner data.

## Production preparation applied

Migration registered by Supabase as 20261016104125_priced_extras_v2. Local filename aligned with that recorded version. Additive schema only; priced_extras_enabled=false verified, catalog empty, no priced booking snapshots, all return fees still zero. Fleet still 55/55 full insurance. No historical booking or existing price modified. Common test:extras command passed 68 checks (45 regular tests plus 23 schema assertions).

Functions deployed after schema verification: booking-options v1, partner-booking-items v1, generate-voucher v123 (previous JWT setting retained), create-booking-request v17 (JWT retained; current import map explicitly included). First booking deployment failed because the old absolute import-map path was retained by the management API; no new version became active. Retried with the original deno.json at an explicit relative path and v17 deployed successfully. Charging remains disabled; existing bookings and fees are unchanged. Security advisor difference is only INFO for the intentionally private flags table with no client policies; anon cannot read the catalog and authenticated cannot enable charging.

Client complete build passed: assembleDebug, bundleRelease and lintVitalRelease, version 1.0.15/code16. Test APK 26,064,721 bytes; unsigned AAB 8,527,943 bytes; both ZIP CRC verified. Partner complete build still running.

Initialized return fees only for the five paid local points, while charging disabled: Madeira Airport 20 EUR, Lisbon Airport 20 EUR, Porto Airport 20 EUR, Ponta Delgada City 7.50 EUR, Ponta Delgada Airport 7.50 EUR. No free locations changed. Post-read: charging false; 55 insured cars; Cube sum of base prices 475 EUR.
Live HTTP requests without a user session to all four deployed functions returned 401 from their own guards; no server errors or booking records created.
Browser test on ride24.pl: country Albania lists four locations; Tirana airport to Durres city returns all four Sleid cars. Prices displayed as integers (119/149/208/208 EUR for three days); no booking submission or partner notification.
