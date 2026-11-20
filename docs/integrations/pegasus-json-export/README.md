# Pegasus-only JSON Export — current implementation (14 November 2026)

## Status
- Dedicated database registry **installed** in Ride24 Supabase; no triggers or modifications to shared booking, Stripe or partner API logic.
- Dedicated Edge Function `pegasus-booking-export` **deployed, operational access disabled**.
- A credential and the explicit `PEGASUS_EXPORT_ENABLED=true` switch are required before any partner data can be exported. Neither has been configured or shared.
- This feature branch/PR remains isolated from `main`; do **not** merge until the existing Ride24 compatibility checks complete and operational acceptance is documented.
- No real Pegasus booking exists yet, so end-to-end Paid → modification → cancellation with real booking records is **not tested**. Fleet-side scheduled polling is not implemented by Ride24.

## Architecture
- `public.pegasus_export_page(p_after_booking_id UUID, p_limit INTEGER)`: service_role-only invoker RPC.
- `pegasus_private.export_state`, `export_control`, `location_codes`: RLS-protected private export state. Anonymous and ordinary authenticated roles have no schema/table/RPC access.
- Each poll observes current `public.bookings` restricted to one hardcoded Pegasus UUID, status `paid` or `cancelled`.
- On changes between polls, a monotonic **observed snapshot revision** increments. This is not an event for each intermediate database write; it transports latest confirmed state.
- If a previously observed paid record disappears, a durable cancellation tombstone replaces it. Existing cancelled records remain in the registry.
- Pagination by booking UUID, max 100 per page, 30 requests/min, cache refresh at most once per 30 seconds; bookings ending more than 180 days ago are omitted from the export window.
- Partner receives only vehicle **category**, never a specific car.
- Current paid/confirmed workflow for free Partner Accounts: `pending` → accepted in Partner App → `awaiting_payment` → Ride24 fee paid → `paid`. Pegasus must continue accepting requests manually.
- Rental `amountPayableToPartner` from source `pickup_payment_partner_currency`. Extras are informational; `extrasIncludedInAmount=null` is intentional pending first real Pegasus booking pricing reconciliation. Fleet must not add extra line items to amount total.

## Endpoint
`GET https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/pegasus-booking-export?limit=100&after=<UUID>`
- `x-pegasus-export-token: <secret>` (server-to-server ONLY).
- `after` omitted on first page.
- `nextCursor` returned only when `hasMore=true`.
- `PEGASUS_EXPORT_TOKEN_CURRENT` (at least 32 URL-safe chars) must be set securely in Edge Function secrets.
- `PEGASUS_EXPORT_TOKEN_PREVIOUS` optional for rotation.
- `PEGASUS_EXPORT_ENABLED` must be explicitly set to `true` after readiness.
- Per-function `verify_jwt=false` because authentication is enforced by the dedicated token in the handler.
- Never send secrets in GitHub/email/chat/URLs. Never give Pegasus a Supabase service_role key.

## Acceptance performed
- 27 local Node tests passed (12 contract + 15 HTTP security/validation).
- Database role test confirmed `anon` and `authenticated` cannot call the RPC or read private state.
- Service-role RPC returned valid empty export (Pegasus has 0 bookings).
- Synthetic transaction tested pagination, cancellation tombstone and rollback; private registry empty after rollback and other partners' 6 booking records unchanged.
- Edge Function deployed and code verified with Supabase connector.
- Runtime HTTP invocation with real token, partner's Fleet import and real payment workflow **still pending**.
- Supabase advisor's INFO `rls_enabled_no_policy` on private Pegasus tables is intentional deny-all for user roles; service_role bypass is explicit. Other pre-existing security/performance advisories not altered.

## Safety rule
Do not modify shared bookings, triggers, Stripe, AVIA, Caravel or other provider APIs for Pegasus. Stop and review if any shared business-logic change is suggested. Disable exporter by setting `PEGASUS_EXPORT_ENABLED=false` without affecting Ride24 bookings.

## Handoff
Send the partner technical specification, three dummy JSON examples, import guide and test checklist *only* as technical implementation material until a live test is agreed. No credentials are included.
