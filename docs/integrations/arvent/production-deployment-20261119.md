# Ride24 × Arvent — wdrożenie techniczne produkcji i kontrolowana próba 10 EUR
**Data:** 19 listopada 2026 r.  
**Supabase:** `zwyerdeuvyzgkgwglowr`  
**Partner:** `bf29a373-c464-4cec-87a7-c3218ea1ea51`

## Status: technicznie wdrożone, bez publicznej sprzedaży

Partner Arvent pisemnie zaakceptował standardową kolejność:
**osobna opłata Ride24 Stripe → ponowne sprawdzenie ceny i warunków →
SaveReservation w kolayCAR → potwierdzenie DOPIERO przy Approved (1)**.
Zezwolił na końcową próbę rezerwacji i anulowania.
Partner przygotuje w swoim systemie **specjalną ofertę o kwocie wynajmu
10 EUR**; dopiero potem właściciel Ride24 wykona jedną rzeczywistą
rezerwację i ją anuluje. Na moment sporządzenia raportu nie wykonano
ani rezerwacji, ani płatności testowej.

### Potwierdzone produkcyjne Edge Functions

Wdrożenie celowo zachowało istniejące pakiety innych dostawców oraz
sprawdzoną wersję głównej funkcji webhook Stripe (m.in. osobna obsługa
`checkout.session.async_payment_succeeded`, której brakowało w
starszej wersji GitHub). Do pakietów dodano izolowany adapter Arvent,
normalizację SIPP, ponowną weryfikację prawa jazdy i najnowsze
bezpieczne reguły realizacji płatności.

| Funkcja | Wersja po wdrożeniu | Zakres |
|---|---:|---|
| `api-partner-admin` | 37 | Adapter, certyfikacja wymagana do publikacji i zachowanie wyniku certyfikacji po późniejszym sync |
| `search-api` | 80 | Znormalizowane oferty i pełna kwota okresu |
| `create-booking-request` | 37 | Prawo jazdy i zaakceptowana wycena |
| `create_checkout_session` | 90 | Weryfikacja przed Stripe |
| `create-checkout` | 60 | Kompatybilny alias płatności |
| `stripe-webhook` | 92 | Zachowano aktualną obsługę innych zdarzeń |
| `api-booking-dispatch` | 37 | Dostawca po Stripe, bez powtórzenia POST przy timeout |
| `api-booking-status-sync` | 32 | Received (0) oczekuje; Approved (1) potwierdza |
| `client-cancel-booking` | 31 | Trwała pojedyncza próba anulowania |

`booking-options` v20 i `generate-voucher` v135 nie wymagały
zmiany — ich główne pliki są zgodne z aktualnym `main` i
nie korzystają bezpośrednio z nowego adaptera.

### Smoke test bez jakiejkolwiek transakcji

Odpowiedzi HTTP po wdrożeniu:
- `search-api` GET → 405 `METHOD_NOT_ALLOWED`
- `create_checkout_session` GET bez autoryzacji → 401 `AUTH_REQUIRED`
- `stripe-webhook` GET bez podpisu → 400 `No signature`
- `api-booking-dispatch` GET → 405
- `api-booking-status-sync` GET → 405
- `api-partner-admin` i `client-cancel-booking` GET bez tokenu → 401

Wszystkie są prawidłowymi odpowiedziami ochronnymi; nie dowodzą
jeszcze pełnego działania transakcyjnego. Produkcyjny worker
`api-booking-status-sync` zwraca HTTP 200 podczas wywołań cron.
Zdalny, publiczny `https://ride24.pl/klient.html` zwrócił HTTP 200
i zawiera pole `arventLicenseSince` oraz
`main_driver_license_since`.

### Stan bazy — stan ochronny

- `partners.api_provider='arvent_kolaycar'`
- `partners.api_enabled=false`, `api_status='draft'`;
- `partners.commission=0`, `discount_percent=0`, waluta EUR;
- 86 grup SIPP — wszystkie `active=false`;
- 8 lotnisk — wszystkie `active=false`;
- `bookings` Arvent: 0;
- `partner_api_credentials.last_test_ok=true`,
  `last_sync_at=null` (nie fałszowano synchronizacji);
- `bookings.main_driver_license_since` istnieje;
- `arvent_cancel_attempts` istnieje, ma RLS i nie udziela dostępu
  klientowi/anon; `service_role` ma dostęp do zapisu.
- globalny przepływ płatności API działa dla innych partnerów.

### Kontrola kodu

- PR #121, #122, #123 i #124 scalone do `main`.
- Testy API na ostatnim PR #124: **319/319 przechodzi**:
  <https://github.com/expol1/ride24/actions/runs/44507130013>.
- Aktywacja administracyjna Arvent wymaga **wszystkich** warunków:
  `ARVENT_KOLAYCAR_WRITE_ALLOWED=true`,
  `ARVENT_STRIPE_FIRST_APPROVED=true`,
  oraz `partners.api_settings.arvent_certified=true`.
  Ostatni znacznik wolno ustawić **dopiero po** prawdziwej,
  udokumentowanej próbie i weryfikacji zwrotu.
- Aktualnych wartości Edge Secrets nie można zweryfikować poprzez
  dostępne narzędzia. NIE zakładać, że są włączone lub wyłączone
  wyłącznie na podstawie bazy. Przed próbą sprawdzić je ręcznie w
  Supabase Dashboard → Edge Functions → Secrets.
- Publiczne oferty są nadal wyłączone w bazie niezależnie od sekretów.

## Plan kontrolowanego testu 10 EUR

1. Arvent potwierdza w API ofertę **10 EUR za cały okres** (nie za dzień),
   grupę SIPP, lotnisko, godziny, długość najmu, kwotę płatną przy
   odbiorze, minimum wieku i lat prawa jazdy, warunki pełnego
   ubezpieczenia, depozytu, karty, kilometrów, obowiązkowych dodatków
   oraz zasady anulowania. Daty powinny być za 2–3 miesiące.
2. Potwierdzić w systemie Ride24 zaakceptowaną aktualizację informacji
   dla klientów: własna opłata Stripe przed potwierdzeniem Arvent,
   zwrot 100% przy nieudanej rezerwacji, brak vouchera przy Received (0).
   Oryginalnych zatwierdzonych PDF-ów nie nadpisywać potajemnie.
3. Zweryfikować w Dashboard oba sekrety, włączyć kontrolowane zapisy
   **dopiero po** pozytywnym read-only preflight i przed prawdziwą
   płatnością. Kontrolować status samej aktywacji i dostępu
   do oferty; podczas próby udostępnić tylko wybraną grupę i
   lokalizację oraz ograniczyć czas testowego okna.
4. Wybrać uprawnionego, rzeczywistego kierowcę (wiek i faktyczna data
   pierwszego uzyskania prawa jazdy). Nie wymyślać daty urodzenia
   ani numerów dokumentów. Upewnić się, że wszystkie taryfowe
   pola wymagane przez kolayCAR są zebrane.
5. Wykonać JEDNĄ opłatę Stripe i JEDEN supplier SaveReservation.
   Sprawdzić: dokładną kwotę i SIPP, brak podwójnego POST,
   `Received (0)` ≠ potwierdzenie,
   `Approved (1)` = potwierdzenie po kompletnym sprawdzeniu,
   numer Arvent, voucher i doręczenie powiadomienia.
6. Anulować dokładnie tę samą rezerwację, potwierdzić status Arvent 3,
   skontrolować zwrot opłaty Ride24 i logi e-mail.
   Zablokować ponawianie supplier POST po niejednoznacznym timeout.
7. Wyłączyć okno testowe. Po kompletnej certyfikacji i sprawdzeniu
   dokumentów/UI Android ustawić
   po rzeczywistym sync katalogu ustawić
   `api_settings.arvent_certified=true` świadomą decyzją
   właściciela; dopiero wtedy administracyjnie aktywować
   publiczną sprzedaż. Kolejne synchronizacje zachowują
   certyfikację, ale aktualizacja konfiguracji API może wymagać
   ponownej weryfikacji.
   Bez tego testu i zgody nie zmieniać `api_enabled=false`.

## Nadal do zweryfikowania przed pełną publiczną sprzedażą

- Zaakceptowana przez partnera aktualizacja dokumentów EN/TR,
  które zawierały poprzednią kolejność płatności;
- rzeczywisty obowiązek `birthDay`/`personalNumberRequired` dla
  wybranej taryfy, ubezpieczenie przy danej stawce,
  dodatki i one-way; status 6;
- zachowanie wydanej aplikacji Android (nie ma jej kodu/APK
  w tym repo). Backend zablokuje Android bez daty pierwotnego
  wydania prawa jazdy przed płatnością, ale UX Android wymaga wydania
  zgodnej aktualizacji lub świadomego ograniczenia dystrybucji.

**UWAGA:** merge do GitHub to nie wdrożenie; wymienione wyżej wersje Edge
zostały oddzielnie wdrożone do `zwyerdeuvyzgkgwglowr` i poddane
nieinwazyjnym testom HTTP. Transakcyjne potwierdzenie pozostaje
do przeprowadzenia na ofercie 10 EUR.
