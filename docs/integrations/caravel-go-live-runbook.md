# Caravel go-live runbook (admin tools ready; NOTHING here has been executed)

Prerequisites from Caravel: certification verdict PASS for the hosted run, production
approval + key, current EN v4 terms in the production API, written answers on exclusions,
admin fee, card at pickup, payment model (see `caravel-message-2026-11-18.md`).

**Admin panel stays as simple as AVIA:** everything is done in the existing
Partners → "Konfiguracja Partnera API" modal. Choose provider *Caravel Channel API*, save the
API key, then use the ordinary buttons: *Test połączenia*, *Synchronizuj lokalizacje i grupy*
(catalogue + current terms), *Aktywuj API* (opens sales; needs the certification date),
*Wyłącz API* (kill switch). A small Caravel-only field panel (certification date, admin fee,
exclusion codes, clause numbers) appears in that modal only for Caravel. No new tabs, no extra
buttons. Bookings appear in the existing Rezerwacje section; cancellations and refunds use the
existing flows. Catalogue and terms then sync automatically every hour (`ride24-caravel-auto-sync`
cron → `caravel-admin` `auto-sync`); a new terms version is verified and stored, and sales pause
until an admin presses *Aktywuj API* again.

The same operations also exist as backend actions of `caravel-admin` (verify_jwt + profiles.role=admin).
It is committed but NOT deployed; deploy it together with migration
`20261118190000_caravel_release_switch.sql` and `20261118200000_caravel_auto_sync_schedule.sql`
(both NOT applied yet) at go-live review; set Edge secret `CARAVEL_AUTO_SYNC_SECRET` equal to the
vault secret `caravel_auto_sync_cron`. Redeploy `api-partner-admin` and `admin/index.html` after the merge.

1. **Store the production key** in `partner_api_credentials` for partner
   `78721481-7619-44df-a9b7-5faa344b69bb` with `api_url = https://api.caravelway.com`
   (owner action in the existing partner admin; never in chat, GitHub or logs).
2. **status** — `{"action":"status"}`: shows gate reason, reviewed terms, catalogue counts,
   credential presence and server flags (booleans only).
3. **terms-ingest** — `{"action":"terms-ingest","input":{"supplierId":"…","language":"en",
   "documentId":"<current EN document_id>","excludedCodes":[…exact Premium excludes…],
   "damageAdminFeeMinor":10000,"exclusionClauseRefs":["…"],"adminFeeClauseRef":"…"}}`.
   Fetches the current document, re-hashes it (§3.9), checks the clause numbers exist and the
   fee clause states the amount, stores it immutably. Does not open anything.
4. **catalog-sync** — `{"action":"catalog-sync","supplier_id":"…"}`: merges production
   locations (timezone required) and vehicle groups; new rows INACTIVE; nothing deleted.
5. **Supervised checks** (still closed): `status` again; compare stored terms with the
   operator's reading of the clauses; confirm `excludedCodes` equal the Premium `excludes`
   returned by production availability (offers with any other set are refused automatically).
6. **release-open** — `{"action":"release-open","certified_at":"<verdict time>",
   "document_id":"…","content_hash":"…","reason":"…","confirm":"OPEN_CARAVEL_SALES"}`.
   One transaction: checks reviewed terms, credentials, catalogue; sets
   caravel_release_control, partner `caravel/enabled/synced`, activates Caravel rows; logs.
7. **Server flags** for supplier bookings after payment (Edge secrets):
   `CARAVEL_PRODUCTION_WRITES_ALLOWED=true`, `CARAVEL_STRIPE_FIRST_APPROVED=true`.
8. **Deploy** (after PR #84 is merged): `search-api`, `create_checkout_session`,
   `stripe-webhook`, `create-booking-request`, `api-booking-dispatch`, web `klient.html`
   + `assets/caravel-consent.js`.
9. **Monitored smoke**: one real low-value booking by staff, cancel per terms; verify voucher,
   Caravel booking number, refund path; then keep monitoring.

**Kill switch at any time:** `{"action":"release-close","reason":"…"}` — stops new offers,
consent and checkout immediately (paid bookings continue in the shared workflow), logged.
Or unset either server flag to stop supplier booking creation after payment.
