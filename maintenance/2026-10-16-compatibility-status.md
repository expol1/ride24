# Compatibility checkpoint — 2026-10-16

Draft only. No production deployment, migration or fee backfill performed.

Merged main 50a2db0e7d037a4435d523d2d9b66b2b43affa5d into extras draft:
- Preserve same-partner pickup/return validation from live create-booking-request v16.
- Preserve country/city-scoped suggestions and pre-limit car filtering.
- Preserve result-only integer price display; settlement values retain cents.
- Read-only production verification found fullInsurance=true for all 55 cars and Cube prices 60,65,65,70,70,70,75 EUR. No price or fleet writes.

Android incremental patch follows android-priced-extras.patch. It scopes returns to pickup owners, intersects owners before limiting cars, resets stale return selection, guards suggestion races, searches country and dictionary keyword terms, and rounds result presentation only. The latest client archive already contains truthful-feature fixes also present in the older cumulative patch: do not blindly apply duplicate hunks. Native compilation and device verification remain outstanding. Partner source fallback exists, but newly uploaded partner ZIP is truncated and lacks its central directory. Do not describe either APK/AAB as release-ready.

Checks: 26 pricing/quote tests, 23 isolated schema/ownership checks, 7 DOM/script checks, 4 voucher checks pass. No real booking, email, push, Stripe payment or partner notification generated.

Publication verification: GET of both ride24.pl/ and results.html returned HTTP 403 from this environment; publication remains unverified.

Before deployment: build both Android projects, validate full booking/payment/voucher flow in isolation, take fresh backup of latest main and live server functions plus affected data; deploy schema/endpoints with flag disabled first. Never restore older full database over current partner data. Never change existing booking snapshots. Activation must wait for verified client compatibility.
