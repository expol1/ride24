## Przygotowania po ostatnim audycie — 17.11.2026

### Ostateczne sprawdzenie regulaminu
- Przesłany `rules.pdf` (676825 bajtów) ma MD5 `3b945c1a96f4473af18795ebe469415c`, identyczne z Supabase Storage `metadata.eTag` dla aktualnie podłączonego do profilu Caravel pliku. Potwierdzamy, że jest to ten sam dokument.
- PDF ujawnia 100 EUR opłaty za szkodę lub kradzież (§6.1), brak ochrony szyb/kół/podwozia (§3.1), wyjątek braku opłat za przestój dla szkód objętych Premium (§4.4), kary (§6.3) i klauzulę obciążania przedstawionej karty (§5.1). Numeracja różni się od e-maila Caravel; drugi PDF `terms.pdf` oraz API `GET /v1/reference/terms` nadal nieodczytane.
- Nie podmieniać istniejących dokumentów ani nie tworzyć drugiego mechanizmu dokumentów, zanim nie porównamy wersji.

### Dodatkowe izolowane zabezpieczenia
- Wykluczenie L2A na poziomie katalogu, wyboru Premium, budowy oferty i **tworzenia draftu rezerwacji** (ochrona przed starszą/spreparowaną wyceną). Pola wykorzystywane do oznaczenia L2A są warunkowe; trzeba potwierdzić właściwe pole identyfikatora na żywej odpowiedzi.
- Publiczne opisy Premium ograniczone do zweryfikowanego zakresu: bez obietnicy ochrony szyb/kół/podwozia; przestój tylko przy szkodach wyłączonych lub utracie ochrony; klucze 200 EUR plus dostawa; opłata administracyjna 100 EUR za zdarzenie.
- Nowy izolowany `checkCaravelLicenceEligibility()` sprawdza datę pierwszego uzyskania prawa jazdy względem początku najmu, minimalne lata dla **konkretnego dostawcy** i IDP dla uprawnień spoza UE/EOG. Nie jest jeszcze podłączony do formularza/booking flow.
- Aktualna tabela `public.drivers` ma `name`, `age`, `phone`, lecz **nie przechowuje** daty pierwszego wydania ani kraju wystawienia prawa jazdy. Na etapie produkcyjnego wdrożenia potrzebne będzie skierowane wyłącznie do Caravel potwierdzenie tych informacji; nie używać `profiles.country` jako kraju wydania prawa jazdy. Nie wprowadzać zmian w tabeli `drivers` bez osobnego przeglądu.
- Dotychczasowe bramki pełnej ochrony Ride24 pozostają niezmienione, a `api_enabled=false`.

## Aktualizacja warunków Caravel, 17.11.2026 — HARD BLOCKER dla produkcji

**Źródło: bezpośredni e-mail zespołu Caravel do Ride24 (17 listopada 2026), weryfikacja warunków produkcyjnych przez API nadal oczekuje na dostęp produkcyjny.** Poniższe dotyczy ich deklarowanego stanu, nie potwierdza wykonania testu API.

### Dane katalogowe i certyfikacja
- Sandbox `GET /v1/reference/extras`: `category=child_seat` i `additional_driver`; `other` nadal jest prawidłowym kodem i musi pozostać obsługiwany (bez zgadywania typu po nazwie).
- `GET /v1/reference/protections`: obaj dostawcy mają już podawać `product_type`, `covers`, `excludes` i `theft_excess`. W `GET /v1/reference/policies` mają być `conditions_of_hire` i `licence_rules`. Różnice między dostawcami są zamierzone — nie ujednolicać ich na stałe.
- W sandboxie kwoty depozytu i udziału własnego Premium nadal są **fikcyjne i dodatnie**. Nie oznacza to warunków produkcyjnych. Dla certyfikacji w fazie `opaque-id-tolerance` należy nadal wycenić **domyślny serwowany plan bez jawnego `plan`** — nie zamieniać go na Premium.

### Oferta produkcyjna od Caravel — niezgodna z bieżącym progiem Ride24
- Premium: `product_type=waiver`, `theft_excess=0`, depozyt 0, udział własny 0 dla szkód objętych ochroną, bez obowiązkowej karty kredytowej; płatność gotówką / Visa / Mastercard (debit/credit).
- Ochrona obejmuje: nadwozie, kradzież, pożar, TPL, pomoc drogową, holowanie/odzyskanie auta.
- **Nie obejmuje szyb, lusterek, opon i kół, podwozia, wnętrza, dachu, kluczy, niewłaściwego paliwa ani opłaty administracyjnej**. Pełny wykaz należy odczytać na bieżąco z API. Odrębne ubezpieczenie szyb/podwozia jest oferowane dopiero przy stanowisku.
- **100 EUR opłaty administracyjnej za wynajem, gdy wystąpi szkoda lub kradzież, także Premium**. Mandaty/opłaty parkingowe oraz opłata manipulacyjna pozostają po stronie najemcy. Sprawdzić pełne warunki pod kątem kosztów przestoju.
- Prawko min. 1 rok; przy prawach jazdy wydanych **poza UE/EOG** wymagane IDP. Ograniczenia i wymagania odczytać dla każdego dostawcy z policy API.
- **Pełne warunki Caravel (GET /v1/reference/terms) mają pierwszeństwo nad skrótem zakresów ochrony (§2.4).** Ride24 ma JUŻ mechanizm wyświetlania dokumentów w `klient.html` przed potwierdzeniem rezerwacji/płatnością: `partners.rental_terms_url`, `partners.rental_rules_url`, checkbox `acceptTerms`, a backend zapisuje `bookings.partner_terms_snapshot` i `partner_rules_snapshot`. Nie tworzyć równoległego systemu. Profil Caravel odsyła do dwóch PDF w `partner-documents`, oba obiekty Storage istnieją (ostatnie aktualizacje 11.11.2026). **Treść plików NIE została jeszcze odczytana ani porównana z korektą Caravel z 17.11.2026**: przed publikacją potwierdzić aktualność, a w razie potrzeby podmienić dokumenty w istniejącym procesie i ponownie sprawdzić odnośniki.
- **Grupa L2A wyłączona z Premium dla Ride24**. Pozostałe grupy kwalifikują się do oferty Caravel, lecz niekoniecznie do rygorystycznego warunku Ride24.
- Po certyfikacji oficjalny dostęp produkcyjny przez przycisk `Request production` w portalu partnera.

### Co wolno zrobić już teraz
1. Utrzymać `REQUIRED_PREMIUM_COVERS` i fail-closed **bez osłabiania warunków**. Nowo zadeklarowane Caravel Premium należy odrzucić jako `COVER_MISSING_GLASS`, `COVER_MISSING_TYRES_AND_WHEELS`, `COVER_MISSING_UNDERCARRIAGE` (oraz inne błędy z faktycznych API danych).
2. Nie wyświetlać tekstu, że Premium obejmuje szyby, koła i podwozie; zaznaczyć wyłączenia oraz 100 EUR opłaty administracyjnej. Teksty to wyłącznie kopie pomocnicze — nie zastępują bieżącego `GET /v1/reference/terms`.
3. Dopisać testy dla `category=other` oraz jawnych kategorii dodatków, różnic polityk per dostawca, wyłączenia L2A i widoczności prawdziwych warunków przed Stripe.
4. Przed produkcją rozstrzygnąć z właścicielem Ride24: czy Caravel ma zapewnić szerszą ochronę bez dopłaty na miejscu, czy może wystąpić jawnie odrębna, zmodyfikowana polityka dla tego partnera. **Bez tej decyzji żadnych ofert.**
5. Nie podłączać aktywnego Caravel do wspólnego `provider-adapters.ts`, `search-api`, Stripe/booking flow ani APK do chwili pełnego zatwierdzenia wymagań; dopuszczalne są tylko izolowane przygotowania testowe.


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
