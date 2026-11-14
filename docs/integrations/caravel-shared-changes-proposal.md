# Caravel — propozycja zmian we wspólnym kodzie Ride24 (dla ChatGPT Work)

Status: **propozycja, nic z tego nie jest wdrożone.** Gałąź `claude/caravel-finish`.
Wdrażać dopiero po stabilizacji AVIA, w uzgodnionym oknie integracyjnym (patrz `caravel-isolation-gate.md`).

## Co jest gotowe w izolacji (etap A)

| Plik | Rola |
| --- | --- |
| `supabase/functions/_shared/caravel-normalize.ts` | Zweryfikowane dane Caravel → standard `ride24_standard_v1` (ten sam format, który przyjmują wspólne `normalizeLocations()` / `normalizeGroups()`); wiersze `partner_locations` / `car_classes` w kształcie obecnej synchronizacji API; katalog dodatków w kształcie `partner_extras` (nieaktywny); przeliczanie jednostek groszowych wg ISO 4217. |
| `supabase/functions/_shared/caravel-booking.ts` | Wspólny `ProviderBookingInput` → szkic rezerwacji Caravel; uzgodnienie kwoty dla partnera z wyceną Caravel; mapowanie statusów. |
| `supabase/functions/_shared/caravel-sandbox-adapter.ts` | Klient sandbox (cache `capabilities`, status rezerwacji). |
| `tests/caravel-*.test.mjs` | Testy przepuszczają wynik przez **prawdziwe** `normalizeGroups()`, `normalizeLocations()` i `apiPriceTotals()`. |

Cena: suma wyceny Caravel trafia jako `price_is_total` / `public_price_total`, więc wspólne `apiPriceTotals()` liczy opłatę Ride24 i kwotę dla partnera dokładnie tak jak dla innych partnerów (test: 150 EUR, rabat 10 %, marża 20 % → partner 135, klient 162, opłata Ride24 27).

## Wymagane zmiany wspólne

### 1. `provider-adapters.ts` — nowy dostawca `caravel`
- Dodać `"caravel"` do `ProviderKey`.
- `fetchProviderLocations` / `fetchProviderGroups`: `CaravelSandboxClient.locations()` / `vehicleClasses()` → mapper surowego JSON (etap B, po OpenAPI) → `normalizeCaravelLocation()` / `normalizeCaravelVehicleClass()` → `normalizeLocations()` / `normalizeGroups()`.
- `searchProvider`: `availability()` → dla każdej oferty Premium `quote()` → `buildCaravelOffer()` → `normalizeGroups()`. Odrzucone oferty logować tylko kodami błędów (bez PII).
- `createProviderBooking`: `buildCaravelBookingDraft()` → `bookSandbox()`; przy niezgodności kwoty — nie rezerwować.
- `getProviderBookingStatus` / `cancelProviderBooking`: `bookingStatusSandbox()` / `cancelSandbox()` + `caravelCanonicalStatus()`; wartość `null` = ręczna weryfikacja, nie zgadywać.
- Produkcyjny URL: osobna, jawna decyzja (klient jest dziś twardo ograniczony do sandboxa).

### 2. Odznaki „bez karty / bez blokady” — ryzyko wprowadzenia klienta w błąd
Dziś trzy miejsca wymuszają `true` dla każdego dostawcy API innego niż AVIA:
- `partner-api.ts` `normalizeGroups()` — `features: {..., noCreditCard: true, noCardHold: true}`;
- `api-partner-admin/index.ts` (synchronizacja `car_classes`) — `noCreditCard: true`, `noCardHold: … : true`;
- `search-api/index.ts` (scalanie `mergedFeatures`) — `noCardHold: … : true`.

Propozycja: dla `caravel` brać flagi wyłącznie z danych dostawcy (tak jak wyjątek `renteon_aggregator`). Gotowe wiersze z prawdziwymi flagami: `caravelSyncRows()`.

### 3. Wiek kierowcy
`search-api` czyta `car_classes.min_driver_age`; obecna synchronizacja API go nie zapisuje. `caravelSyncRows()` już go ustawia — przy wpięciu użyć tych wierszy albo dodać kolumnę do wspólnej synchronizacji.

### 4. Moment wyceny
Wiążąca cena Caravel pochodzi z `POST /v1/quote` (wymaga wieku kierowcy i `protection_id`). Wyszukiwarka Ride24 nie zna wieku kierowcy.
Propozycja: wycena w `search-api` dla ograniczonej liczby ofert (istniejący `QuoteBudget`) przy wieku mieszczącym się w limitach; w `create-booking-request` ponowna wycena z prawdziwym wiekiem i odrzucenie, jeśli suma się różni (`assertApiQuoteContext` już wymusza ponowną wycenę przy zmianie terminu/miejsc).

### 5. Dodatki
`assertApiRequestedOptions()` i `assertApiPricingCompatible()` blokują dziś dodatki u partnerów API. Caravel na razie odrzuca wyceny z wybranymi dodatkami (`SELECTED_EXTRAS_NOT_SUPPORTED`).
Propozycja: ścieżka „dodatki wyceniane przez dostawcę” — katalog z `caravelExtrasCatalog()` jako wiersze zarządzane przez API (nie wyzwalające blokady), wybór dodatków przekazywany do `quote()`, a w booking items pozycje z wyceny Caravel zamiast lokalnego przeliczenia.

### 6. Konfiguracja i dane
- `partners.api_provider = 'caravel'` — sprawdzić ograniczenia/triggery (`20261006121500_api_partner_admin_guard.sql`).
- Klucz API wyłącznie jako sekret Edge Function / vault; `X-Supplier-Id` = zakres jednego dostawcy na partnera Ride24.
- Partner `Caravel Rent a Car` pozostaje `api_enabled=false` do decyzji o włączeniu.

### 7. Model płatności (decyzja Ride24, 13.11.2026)
- Caravel sprzedawany wyłącznie jako `payment_model = pay_on_arrival`: Caravel pobiera od klienta na miejscu dokładnie `grand_total`.
- Ride24 pobiera osobno wyłącznie własną opłatę rezerwacyjną przez Stripe; opłata nigdy nie jest doliczana do `grand_total`.
- Dla partnera Caravel `partners.discount_percent` musi wynosić **0** (w `apiPriceTotals()` partner net = `grand_total`, prowizja Ride24 = marża). Moduł `caravel-booking.ts` odrzuca rabat (`PARTNER_DISCOUNT_NOT_ALLOWED`).
- `pay_now` / `pay_at_pickup` to podział ceny produktu, nie informacja, kto pobiera płatność. Bez prowizji i `settlements` w tym etapie.

### 8. Kolejność rezerwacji ze Stripe
- Rezerwacja u Caravel (`POST /v1/bookings`) może powstać **dopiero po potwierdzeniu płatności opłaty Ride24** (webhook Stripe), na podstawie zapisanej wyceny (`api_quotes.provider_quote_data`, `quote_id`, `expires_at`).
- Przed rezerwacją: ponowna wycena, jeśli wycena wygasła (`quote_expired`/`quote_consumed`/`price_changed`/`availability_changed` → akcja `requote` w `caravelErrorAction()`), i zgoda klienta na nową kwotę.
- Po rezerwacji: `verifyCaravelBookingAgainstQuote()` (ta sama kwota, `pay_on_arrival`, depozyt/udział własny 0); przy niezgodności anulowanie i zwrot opłaty Ride24 zgodnie z istniejącym procesem.

### 9. Tylko Premium
- Publikować wyłącznie oferty, dla których `evaluateCaravelPremium()` zwraca `ok` (depozyt 0, udział własny 0, `theft_excess` 0, `product_type: waiver`, `covers` ⊇ theft/fire/glass/tyres_and_wheels/undercarriage, depozyt wyceny 0). Medium i pozostałe plany nie są publikowane.
- Odznaka „bez karty kredytowej” = wynik tej oceny (zerowy depozyt / brak pre-autoryzacji); nie wymuszać jej w `normalizeGroups()` / sync / `search-api` (pkt 2).
- Teksty warunków Premium (PL/EN) gotowe w `CARAVEL_PREMIUM_TERMS` do późniejszego wyświetlenia w WWW/APK.

### 10. Webhooki i synchronizacja statusów
- Odbiornik (osobna funkcja, po AVIA): `verifyCaravelSignature()` przed parsowaniem, `decideCaravelWebhookEvent()` (deduplikacja `event_id`, rosnąca `revision`, luka w `sequence`), zawsze ponowne pobranie rezerwacji, `caravelBookingStatus()` (no_show/completed/nieznany → przegląd ręczny, nigdy automatyczne potwierdzenie).
- Odzyskiwanie po przerwie: `listBookings({updated_since})` + `POST /v1/webhooks/redeliver`.

## Poza zakresem etapu A (blokuje etap B)
Prawdziwe nazwy pól i jednostki kwot z OpenAPI v1.67.0, wartości statusów, ścieżka statusu rezerwacji, kształt `customer` / `drivers` przy rezerwacji, dostęp DNS do `sandbox-api.caravelway.com`.
