# Provider-calculated services — 2026-11-13

Renteon Aggregator documentation located at https://aggregator.renteon.com/swagger/docs/v1. `/create` returns an unsaved BookingModel; services are selected with IsSelected and Quantity and priced with `/calculate`. Only `/save` persists a booking.

Implemented: reconciled mandatory charges in availability; provider-priced service catalogue and quantities; driver-based recalculation; account/driver/selection-bound quotes and consent fingerprint; common Ride24 pricing snapshot for booking summary, partner items and EN/PL voucher; recalculation before provider save; exact supplier identifiers retained. The existing rental discount/margin/loyalty/PLN conversion model remains in use. No new schema or local-partner tariff changes.

Evidence: real sandbox reference 26-ATH-205, two baby seats, additional driver, EUR 148.80 supplier total, confirmed, status read, cancelled through shared Ride24 adapter. AVIA unsaved night quote: 25 offers; one baby seat, driver age 22, additional driver age 35, both out-of-hours fees. Supplier total EUR 456.65; selected services sum exactly to it. No production booking or payment created. 41 targeted tests passed before deployment (provider service reconciliation, selection limits, ownership, changed drivers, consent, common voucher validation, existing local/API contracts and web extras UI).

Current deployed backend: booking-options v11, create-booking-request v27, api-booking-dispatch v29, search-api v73. Original JWT modes preserved: true for first two, false with existing handler authentication/rate limiting for last two. Temporary sandbox acceptance function closed (v13, JWT required, HTTP 410).

Limits: Android source/runtime is not accessible; this does not certify native APK. An age-24 AVIA policy discrepancy (supplier 18–23 vs agreed 18–24) blocks options quote pending provider confirmation. Unmapped UNSPECIFIED optional services and insurance changes are not selectable. Seasonal/route restrictions remain provider-authoritative. Full payment, real-device push and customer email E2E are not certified. Caravel/Arvent live integration is not certified by these changes.

Rollback: restore task-owned code from prior main 5f2946f and matching complete function bundles; preserve subsequent/concurrent edits and original verify_jwt modes. Local predeployment complete function backups are retained in sibling live-backup/options-*.json. No table restore is needed.

## Supplier workbook audit (follow-up)

Source: user-supplied `T&C Avia 2027.xlsx`, sheet `Avia aditionals`, rows 55–60 and 70; workbook itself retains 2025/2026 headings. No blanket replacement of individual Ride24 terms.

Live unsaved AVIA quotes from Zadar Airport, starting 2027-03-01 at 10:00, for 1, 3, 7, 10, 11, 14 days: baby/child seats EUR 12.50/day cap125 each, booster7/day cap70, GPS8/day cap80, additional driver9/day cap90, winter tyres12.50/day cap125; all matched. Two baby seats at14days total250. Ferry50 per rental matched. API Amount is per unit for the entire period; AmountTotal includes quantity. Do not multiply either by rental days again. Evidence is in adjacent extras-audit JSON.

Conflict: snow chains API0 and maxdays0, with FreeOfCharge=false and no included-price flag, versus workbook10/day cap100. Universal optional-service guard rejects an unexplained zero and exposes price_requires_confirmation, preserving explicit free/included services. UI describes the amount as per unit for the entire selected period and lists unavailable service names/status. No tariff is fabricated or overwritten.

Live three-day time tests:06:59 pickup80+return80;07:00 pickup50+return50;08:00 zero;23:00 pickup80+return80. At exactly21:00 API returns no fee although workbook says21:00–22:59 EUR50: boundary requires supplier clarification.

Age tests at3days:18,22,70 each return37.50. Workbook instead specifies18–21=62.50/rental,22–24=37.50/rental,70+=62.50/rental; earlier Ride24 agreement12.50/day cap125 matches observed18,22,70 pricing. Age24 remains blocked because API age range differs. Do not replace earlier negotiated rates from this generic workbook. Kosovo both prohibited(row46) and priced155(row47); confirmation required.

No payment or production reservation was created by these quote-only tests. Temporary acceptance endpoint closed with HTTP410 and JWT. Native Android and full payment/notification E2E remain unverified; authenticated public-web quote selection was subsequently verified below.

## Final persistence and checkout-contract verification

User reports partner approval of the displayed screenshots/prices. No new rates are invented and this is not treated as permission for real bookings/payments.

Live quote-only persistence test, AVIA Zadar 2027-03-01 to03-04 at23:00 both ways, two baby seats: rental150.56 + seats75 + pickup80 + return80 = supplier385.56 EUR; gross424.12 EUR. `makeApiBookingOptions` inserted a new quote and `assertApiOptionsQuote` verified its customer/driver/selection/fingerprint binding against the stored record. Test quotes were expired immediately; no production booking exists. Temporary one-use endpoint closed (version13, HTTP410, JWT required).

Additional regression test executes the create-booking-request handler with a prepared extras quote and verifies exact pricing snapshot persistence, quote binding and the Ride24/partner split. Included supplier protection remains on the pricing summary but is excluded from the Your extras count. Unknown provider service names are represented by a general availability notice instead of presenting internal items such as No deposit as unconfirmed paid equipment. Confirmed mappings still show named unavailability.

83 automated checks passed across provider services, API compatibility, web extras UI, local booking items, local booking handler, native API contract and voucher PDF layout (including20extras). These are not a native device test or a production-payment E2E test. Provider-services checks added to the existing API CI workflow.

Remaining access limitation: Android client source/build and a connected Android runtime are absent. Authenticated public-web extras selection is verified below; payment/email/push E2E remain uncertified. Existing age24 guard remains because no specific age24 API quote was confirmed in the supplied evidence.

## Authenticated public WWW acceptance

Verified the deployed public site through browser interaction, from ride24.pl/results to ride24.pl/klient after secure user sign-in. Zadar Airport (ZAD) returned 20 cards. Opened the first Fiat 500 offer and its real provider-priced extras catalogue. The three-day quote included both out-of-hours charges. Observed server recalculation after every quantity change:

| Selection | Customer total EUR | Partner amount EUR | Ride24 online amount PLN |
| --- | ---: | ---: | ---: |
| No optional extras | 313.04 | 284.58 | 125.42 |
| Two baby seats | 395.54 | 359.58 | 158.48 |
| Two baby seats and one booster | 418.64 | 380.58 | 167.73 |
| One booster after removing both baby seats | 336.14 | 305.58 | 134.68 |
| All optional extras removed | 313.04 | 284.58 | 125.42 |

The catalogue labels prices per unit for the entire selected period and displays maximum chargeable days. Snow chains are unavailable with price confirmation required. Included protection does not count as a selected optional extra. The physical named debit-card explanation states no credit-card, deposit or preauthorisation requirement; no referral-code field was visible.

Closed the extras dialog and cancelled the unsent booking form. Final customer panel showed zero bookings and no new bookings requiring action. Terms were not accepted; no production booking or payment was submitted. This proves actual public-WWW selection and recalculation, not native Android or payment/notification E2E. Additional-driver provider pricing was verified separately; this browser account did not provide a second real driver for that UI case.
