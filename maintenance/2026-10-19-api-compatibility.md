# Ride24 — kontrola zgodności API, 19.10.2026

## Stan rzeczywisty przed zmianami

- Punkt odniesienia GitHub `main`: `6db745a2fb1a77075280acbbaeba3a8e50b3f80b` (PR #37).
- Supabase: `zwyerdeuvyzgkgwglowr`.
- 0 partnerów z włączonym API; 0 rekordów danych dostępowych; 0 rezerwacji, wycen i lokalizacji API.
- Wszystkie aktualne rezerwacje obsługuje tor lokalny. Produkcyjne `booking-options` v2 i
  `create-booking-request` v18 zawierały już nowe obowiązkowe dopłaty.
- 62/62 pojazdy miały `features.fullInsurance = true` podczas tego odczytu.
- RLS jest włączone dla danych dostępowych, wycen, logów API i tabel dodatków/dopłat.
  Polityki dostępu do danych dostępowych, wycen i logów API dopuszczają wyłącznie `service_role`.
- Harmonogram synchronizacji statusów API jest aktywny co 5 minut. Odczyt logów przed zmianami:
  249 odpowiedzi 200 dla tego harmonogramu w oknie ostatnich 24 godzin.

## Wykryte różnice i ograniczone poprawki

1. API nie używa lokalnego katalogu płatnych dodatków ani lokalnych reguł dopłat. Dodano
   kontrolę przed aktywacją, wyszukiwaniem, utworzeniem rezerwacji i wysłaniem do dostawcy.
   Jeśli te reguły są skonfigurowane, oferta zostaje zablokowana zamiast pomijać opłaty,
   oferować niedostępne godziny lub doliczać drugi raz opłatę zawartą w cenie dostawcy.
2. Wycenę dostawcy powiązano po stronie serwera z godzinami i dokładnymi punktami odbioru
   i zwrotu. Zmiana wymaga nowego wyszukania. Daty, grupa auta, partner, ważność i jednorazowe
   zużycie wyceny nadal są sprawdzane w bazie.
3. Gdy dostawca poda cenę za cały okres, rozliczenie korzysta z tej kwoty. Nie mnoży
   zaokrąglonej ceny dobowej. Zachowano kolejność rabat partnera → marża Ride24 i dokładność
   rozliczeń do groszy; zaokrąglanie wyświetlania w `results.html` pozostaje bez zmian.
4. Import lokalizacji zachowuje oddzielną opłatę za zwrot `return_fee_amount`.
5. Ogólny komunikat utworzenia rezerwacji dla zewnętrznego systemu zawiera tylko dozwolone
   pola. Nie zawiera końcowej ceny klienta, marży Ride24, płatności online ani rabatu lojalnościowego.
6. Nieznany dostawca nie jest automatycznie traktowany jako integracja `custom`.
7. Kod wycofanego `sync-api-locations` zsynchronizowano z już działającą, chronioną wersją
   produkcyjną (administracyjny endpoint 410 wskazujący `api-partner-admin?action=sync`).

## Co zostało zachowane

Nie wykonano migracji, aktualizacji ani kasowania danych partnerów, floty, cenników,
ubezpieczeń, lokalizacji, dopłat, dodatków, kont lub Storage. Nie zmieniono obliczeń lokalnego
wynajmu, rabatu lojalnościowego, Stripe, webhooka, voucherów ani powiadomień. Testy odtwarzają
te ścieżki na izolowanych danych. Kod obu Androidów pozostał bez zmian; nowa wersja aplikacji
nie jest wymagana do obsługi tych zabezpieczeń serwera i komunikatów PL/EN.

## Granice gotowości integracji zewnętrznych

Kod posiada adaptery `ride24_standard_v1`, `custom`, `renteon` i `easy_web_rent`.
Nie posiada dedykowanych adapterów KolayCar ani Wheelsys. Nie wolno wybierać dla nich
`custom` bez potwierdzonej zgodności z opisanym protokołem Ride24.

**Nie potwierdzono gotowej integracji produkcyjnej z żadnym zewnętrznym dostawcą.**
W szczególności wybór lokalnych płatnych dodatków i automatyczne reguły obowiązkowych dopłat
nie są obsługiwane przez ten tor API. Są teraz jawnie blokowane, nie automatycznie przenoszone
do innego systemu cenowego. Opłata już zawarta w kompletnej wycenie dostawcy może pozostać
częścią tej wyceny, lecz jej zakres trzeba potwierdzić podczas odbioru konkretnej integracji.

Przed uruchomieniem pierwszego dostawcy potrzebne są jego rzeczywista dokumentacja i dostęp
testowy. Należy potwierdzić pełną kwotę należną partnerowi po rabacie, zakres ubezpieczenia
i opłat, dostępność, referencję rezerwacji, późniejszy status, voucher oraz anulowanie.
Szczególnie Easy Web Rent i adapter ogólny wymagają potwierdzenia, że system dostawcy
honoruje rabat i kwotę partnera; sam test połączenia ani test z atrapą nie stanowi takiego potwierdzenia.
Nie jest to ponowna modernizacja działającego toru lokalnego, tylko odbiór nowego połączenia.

## Testy i ochrona stanu

- Automatyczne testy kalkulatora, czasu i tras, rezerwacji, wyboru dodatków, widoku WEB,
  kontraktu Android, ochrony kwot partnera i powrotu z płatności.
- API: pełne kwoty okresowe, lojalność, zmiana godzin/miejsc, ważność i jednorazowe użycie,
  blokada pominięcia opłat, błąd odczytu katalogu, aktywacja, wysyłka i ponowiona wysyłka,
  prywatność danych finansowych, oddzielny zwrot oraz odrzucanie adresów prywatnych.
- Wszystkie zewnętrzne rezerwacje, e-maile i płatności w tych testach są atrapami. Nie utworzono
  testowej rezerwacji produkcyjnej ani nie wysłano powiadomień do partnerów.
- Dodano workflow GitHub uruchamiający te testy przy zmianach funkcji.
- Wyniki wdrożenia i końcowych odczytów: `2026-10-19-api-verification.json`.

Przegląd advisorów nie jest poświadczeniem całkowitego braku ryzyk. Zastany advisor
`security_definer_view` wskazuje `public.active_promotions`, zawierający nagłówki i terminy
publicznych promocji, poza zakresem API. Nie zmieniano go ani pozostałych zastanych advisorów.

## Szybkie przywrócenie

Gałąź kodu sprzed prac: `backup/before-api-compatibility-20261019`.
Dokładne kopie 10 funkcji przed pracami (plik wejściowy, pliki zależne, mapa importów i
ustawienie JWT) są w `maintenance/backups/api-compatibility-20261019/*.json`.

Aby wycofać wdrożenie funkcji, należy ponownie wdrożyć oryginalne pliki z odpowiedniego
JSON-a, zachowując `verify_jwt` oraz oryginalny plik `deno.json` jako mapę importów,
jeśli `import_map` jest włączone. Samo cofnięcie gałęzi GitHub nie cofa funkcji Supabase.
Nie ma migracji ani danych do cofania. Kopie nie zawierają wartości zmiennych środowiskowych
ani prywatnych kluczy dostępu. Nie należy resetować cenników do starszych kopii z 15 października.
