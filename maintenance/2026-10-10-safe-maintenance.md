# Ostrożna konserwacja Ride24 — 10 października 2026

Zakres zaakceptowany przez właściciela: punkty 2, 3 i 4 przeglądu. Nie zmieniono terminów płatności ani dostępu do publicznych voucherów.

## 2. Stary endpoint `create-checkout`

Przejrzano odwołania w aktualnym repozytorium i logi wywołań z ostatnich 24 godzin. Web używa `create_checkout_session`. W tym oknie nie znaleziono wywołań `create-checkout`; odnotowano jedno wywołanie aktualnego endpointu zakończone 401 podczas kontroli autoryzacji.

Nie wyłączono starego endpointu i nie zmieniono jego konfiguracji. Brak ruchu w ograniczonym oknie nie dowodzi, że żadna produkcyjna wersja Androida go nie używa. Aktualne źródła lub binaria obu produkcyjnych aplikacji nie były dostępne do analizy w tej sesji. Wyłączenie wymaga sprawdzenia ich rzeczywistych odwołań i przepływu płatności.

## 3. Zgodność źródeł płatności z produkcją

Pobrano aktualne źródła z Supabase i skopiowano bez zmiany treści:

| Funkcja | Wersja produkcyjna | Powód synchronizacji |
| --- | --- | --- |
| `create_checkout_session` | 79 | Stare źródło GitHub pomijało sprawdzenie użytkownika i właściciela oraz pobierało kwotę od klienta; produkcja sprawdza właściciela i kwotę z bazy oraz obsługuje przekierowania Androida. |
| `generate-receipt` | 36 | W GitHub brakowało obecnych na produkcji kontroli autoryzacji i właściciela oraz aktualnej obsługi danych nabywcy. |
| `stripe-webhook` | 81 | Ujednolicono zapis źródła z aktualnym eksportem produkcyjnym, bez projektowania nowej obsługi płatności. |

Nie wdrażano Edge Functions ani nie zmieniano ich ustawień JWT, sekretów lub zależności. W repozytorium nie znaleziono workflow automatycznie wdrażającego funkcje. Manifest `2026-10-10-production-source-manifest.json` zawiera wersje i SHA-256 treści plików źródłowych (nie skróty pakietów wdrożenia).

Stan GitHub sprzed synchronizacji pozostaje w historii: `cac50497fd9d3016e167f625771fafd37ac832ab`. To punkt porównania i przywrócenia plików Git, a nie zalecenie wdrażania starszego kodu płatności. Synchronizacja nie zmieniła działającej produkcji; nie wymaga przywracania bazy. Istniejąca pełna kopia RIDE24 pozostaje bez zmian.

Nowe testy izolowane można uruchomić poleceniem `npm run test:payments` w `tests/backend-hardening`. Weryfikują skróty źródeł, autoryzację, właściciela, statusy i kwotę rezerwacji, kontrakt URL płatności dla web/Android oraz wstępne zabezpieczenia rachunków i webhooka. Wszystkie usługi i dane są atrapami; testy nie wywołują Stripe ani produkcyjnej bazy. Nie są testem rzeczywistej płatności, generowania PDF lub aplikacji Android na urządzeniu.

## 4. Tabela techniczna `net._http_response`

Potwierdzono PostgreSQL 17.6, `pg_net` 0.19.5, włączony autovacuum, retencję odpowiedzi HTTP 6 godzin i brak oczekujących żądań w momencie kontroli. Tabela należy do infrastruktury HTTP bazy; nie zawiera rezerwacji lub plików partnerów.

Wykonano pojedynczą zwykłą konserwację:

```sql
VACUUM (ANALYZE TRUE, TRUNCATE FALSE, SKIP_LOCKED TRUE,
        PARALLEL 0, BUFFER_USAGE_LIMIT '256 kB') net._http_response;
```

Wyłączono skracanie pliku wymagające blokady wyłącznej. `SKIP_LOCKED` pozwala pominąć tabelę zajętą przez konfliktującą blokadę początkową; nie gwarantuje braku każdego możliwego oczekiwania. Mały limit bufora i brak równoległych workerów ograniczają wpływ konserwacji. Jest to zwykły VACUUM, który pozwala na bieżące operacje tabeli. Nie wykonywano `VACUUM FULL`, `TRUNCATE`, przebudowy, wymiany tabeli, zmiany retencji, restartu workera ani instalacji rozszerzeń.

Weryfikacja: `last_vacuum` = `2026-10-10 08:28:23.682784+00`, `last_analyze` = `2026-10-10 08:28:24.04409+00`; statystyka żywych wierszy została zaktualizowana z 414 do 200, martwych wierszy = 0. Rozmiar danych tabeli pozostał 215 523 328 bajtów; całkowity rozmiar z indeksami i metadanymi zmienił się z 218 521 600 do 218 546 176 bajtów. Nie odzyskano miejsca na dysku. Konserwacja udostępnia puste miejsce do ponownego użycia wewnątrz tabeli i odświeża statystyki. Odzyskanie około 208 MiB na poziomie pliku wymaga osobno zaplanowanej operacji uwzględniającej możliwe blokady; nie mieści się w tym ostrożnym zakresie.

Dokumentacja: [PostgreSQL 17 VACUUM](https://www.postgresql.org/docs/17/sql-vacuum.html), [Supabase pg_net](https://supabase.com/docs/guides/database/extensions/pg_net), [Supabase: nadmiarowe miejsce w tabeli](https://supabase.com/docs/guides/observability/advisors?queryGroups=lint&lint=0020_table_bloat). Sprawdzono bieżący changelog Supabase; nie wykonywano aktualizacji Postgresa lub rozszerzeń.

## Kontrola zachowania stanu

Przed pracami zapisano sumy kontrolne wierszy profili, partnerów, floty, lokalizacji, rezerwacji, metadanych Storage i konfiguracji wszystkich 14 zadań cron oraz metadane wszystkich 45 wdrożonych funkcji. Kontrola końcowa porównuje je z tym stanem. Nie odczytywano wartości zapisanego tokena GitHub; sprawdzano wyłącznie jego obecność. Zadania retencji rezerwacji i plików pozostają aktywne.

Wynik końcowego porównania: wszystkie sumy kontrolne powyższych zasobów identyczne przed i po konserwacji; 6 profili, 4 partnerów, 27 pozycji floty, 22 lokalizacje, 0 rezerwacji i 110 obiektów Storage. Wszystkie 45 funkcji zachowało status, wersję, skrót pakietu, konfigurację JWT i datę aktualizacji. Token GitHub nadal obecny. Pozostaje 12 aktywnych zadań cron, w tym oba zadania retencji. Ostatnie odpowiedzi HTTP w momencie kontroli: 8 sukcesów, 0 błędów serwera w oknie 15 minut, kolejka pusta.

Walidacja: 103 kontrole w `npm run test:payments` i 104 wcześniejsze kontrole w `npm test` przeszły. Poprzednie testy obejmują również izolowany scenariusz proponowanego czyszczenia indeksów; nie oznacza to wdrożenia tej propozycji. Kontrole HTTP produkcji potwierdziły 22 lokalizacje i 27 pozycji floty (200), dostępność ustawień Auth (200) oraz odrzucenie anonimowych prób checkoutu i generowania rachunku (401). Nie tworzono rezerwacji testowych ani nie wykonywano płatności. Nie deklaruje się pełnej walidacji natywnych aplikacji Android na podstawie tych kontroli API.
