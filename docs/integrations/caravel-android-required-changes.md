# Caravel — required changes in the Ride24 Android client app (spec, NOT built)

## Source availability (checked 18 Nov 2026)

- GitHub: account `expol1` has one repository, `ride24` (web + Supabase). It contains no
  Android project (`AndroidManifest.xml` / Gradle); only screenshots and CSS showcases.
- Google Drive: only binaries — `Ride24_Klient_1.0.27_TEST.apk` (2 copies, 14 Nov 2026).
  No source archive is reachable (the 16 Oct 2026 delivery archive
  `RIDE24-Android-dodatki-1.0.16-1.0.7-2026-10-16.zip` is stored privately, not in Drive search).
- This workstation: no Ride24 Android project.

**Therefore no APK was built and none is claimed.** Decompiling the APK is not a source.

## Why the app is safe today without changes

- Search: `search-api` returns Caravel offers only while the release gate is open.
- Booking: the generic `create-booking-request` (which the app calls) **always refuses Caravel**
  (`CARAVEL_CERTIFICATION_PENDING`, HTTP 409) before any quote claim, booking row or Stripe.
- So an app without the consent screen can never book or pay for Caravel. When Caravel goes
  live, the current app must show the 409 message (`error` / `error_en`) instead of a crash.

## Changes needed so the app can show and record the consent (client 1.0.28+)

1. **Detect Caravel offers.** In the search result card, an offer is Caravel when
   `features.caravel_consent_required === true` (also `partners.id ==
   78721481-7619-44df-a9b7-5faa344b69bb`). Keep `features.api_quote_id`.
   - Do NOT show "no credit card" / "no card hold" for it (`noCreditCard=false`).
   - Show "Premium included, deposit 0, excess 0" and, when
     `features.caravel_excluded_codes` is non-empty, "not full insurance — exclusions apply".
2. **Booking summary screen → consent block** (before the "Book" button):
   - `POST /functions/v1/caravel-booking-request` with the user JWT:
     `{"action":"consent-view","api_quote_id":"<features.api_quote_id>","lang":"pl"|"en"}`.
   - Render from the response `consent`:
     - every string in `consent.statements` (money split, category-not-model, exclusions, admin fee);
     - `consent.coverage.excluded[].label`;
     - `consent.terms.title`, `version`, `language`, short `content_hash`;
     - `consent.terms.html` in a scrollable **WebView with JavaScript disabled**
       (`settings.javaScriptEnabled=false`, `loadDataWithBaseURL(null, html, "text/html", "utf-8", null)`);
       the HTML is server-escaped clauses/v1 text with only `<strong>/<em>`.
   - Two separate unchecked checkboxes (texts identical to WWW `assets/caravel-consent.js`):
     terms acceptance and exclusions/admin-fee (or money-split) acknowledgement.
     The Book button stays disabled until both are checked.
   - On HTTP 409 show `error`/`error_en` and disable booking.
3. **Book through the Caravel entry, not `create-booking-request`:**
   `{"action":"book","api_quote_id":…,"driver_id":<uuid|null>,"consent":{
   "terms_document_id","terms_content_hash","terms_language","excluded_codes","damage_admin_fee_minor"
   (copied verbatim from consent.echo),"accepted":true,"coverage_acknowledged":true},"lang":…}`.
   - Additional driver is not supported for Caravel: hide the selector for these offers.
   - `409 CARAVEL_REQUOTED_FOR_DRIVER_AGE`: replace the stored quote id with
     `api_quote_id`, re-render the returned `consent` (new price), **uncheck both boxes**.
   - `409 CARAVEL_TERMS_CONSENT_STALE_OR_MISSING`: reload consent-view and require re-acceptance.
   - `200 {success:true, booking:{id}, payment_required:true}` → existing payment step:
     `create_checkout_session` with `client:"android"` (unchanged return URL handling).
4. **Payment/booking status:** unchanged shared statuses. Show "awaiting supplier confirmation"
   while `api_status` is `payment_paid`/`payment_dispatching`/`payment_provider_pending`;
   "manual review" on `payment_unknown`; refund messages on `payment_refund_*`. The voucher is
   only available after `status=paid`, `api_status=confirmed` (it carries the Caravel booking number).
5. **Never** compute or display a price on device: all money comes from the server responses.

## Acceptance tests to run on the app before Play release

- Non-Caravel offers (AVIA and others) unchanged: same screens, same request to `create-booking-request`.
- Caravel with gate closed → 409 message, no Stripe.
- Consent: both boxes required; echo equals the response; terms version change → re-acceptance.
- Driver age different from the quote → new price shown, boxes reset.
- Stripe test card paid → status flow → voucher only after confirmation; declined card → booking stays unpaid.
- Physical device run with test signing keys (previous TEST APKs must be uninstalled).
