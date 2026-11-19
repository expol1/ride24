# Arvent / kolayCAR — decyzja przed uruchomieniem, 18.11.2026

**Wstrzymać sprzedaż.** Zgoda na kolejność Stripe → rewalidacja → Arvent otwiera drogę do certyfikacji. Potrzebny jest jeszcze dowód całego procesu na jednej uzgodnionej rezerwacji.

## Stan odniesienia

- Sprawdzony main: `35fbf056b420b30b0f58fe7838b967e6e850b041`. PR 119 i 120 scalone, PR 105 zamknięty bez scalenia. Lokalne odtworzenie polecenia z workflow API Compatibility QA: 300/300.
- Projekt Ride24: API Arvent wyłączone, provider custom, status draft. Zero rezerwacji i zero wycen Arvent. Konto aktywne, waluta EUR, rabat 0. Pole partners.commission wynosi 15. Sprawdzona ścieżka wyszukiwania bierze rabat partnera i globalną marżę; przy zerowym rabacie kwota partnera odpowiada całej cenie dostawcy. Przed startem sprawdzić także widok admina, dokument rozliczeniowy i końcową kwotę vouchera.
- 86 różnych, nieaktywnych kodów SIPP. A 15, B 12, C 16, D 18, E 13, F 12. Wszystkie zgodne ze wspólnym klasyfikatorem AVIA. Brak dodatnich cen katalogowych. Nieaktywne lotniska: SAW, IST, SZF, ASR, DLM, AYT, ADB, TZX. Kod WWW wiąże Turkey z TR i polską nazwą Turcja. Wyświetlanie ofert wymaga testu WWW i właściwego wydania Androida.
- Aktualne wskaźniki PDF prowadzą do wersjonowanych dokumentów właściciela konta. ETag i długości obu plików odpowiadają oryginałom EN/TR v1.3 wskazanym w README. Akceptacja zapisana jako custom_pdf_v1. Wymagana uzgodniona korekta kolejności w dokumentach klienta.
- Credentials: adres zgodny z adapterem, poświadczenia skonfigurowane, last_test_ok=true, last_sync_at=null. RLS aktywne, anon i authenticated bez prawa SELECT. W tym audycie nie powtórzono uwierzytelnionej wyceny u dostawcy. Historyczny test AYT/SAW opisano w README.
- Pakiety funkcji produkcyjnych pobrane z Supabase nie zawierały adaptera Arvent. Wersje: search-api 79, create-booking-request 36, booking-options 20, create_checkout_session 89, create-checkout 59, stripe-webhook 91, api-booking-dispatch 36, api-booking-status-sync 31, client-cancel-booking 30, generate-voucher 135, api-partner-admin 34. Zgodność samego index.ts nie obejmuje zależności. Przy checkout, webhooku i adminie sprawdzić dodatkowo rozbieżności punktów wejścia. Nie nadpisywać zmian innych integracji.
- Cron synchronizacji co 5 minut, 12 udanych wykonań zadania w badanej godzinie. Nie dowodzi to obsługi sprawy Arvent. Globalne API payments włączone. Kontrola sekretów Vault nie zwróciła wpisów obu bramek. Wartości Edge Secrets trzeba sprawdzić osobno, bez pokazywania wartości pozostałych sekretów.

## Zachowanie po poprawkach tej gałęzi

- Wyniki WWW dla Arvent biorą cenę całego okresu i kwotę przy odbiorze z wyceny serwera. Wybór oferty i backend rezerwacji wymagają potwierdzonego kursu NBP. Klasa F ma nazwę Van / Family.
- Checkout Arvent sprawdza własną wycenę SIPP oraz tokenową ofertę extras przed wydaniem linku Stripe. Po zapłacie powtarza kontrolę. Dostawca otrzymuje paidAmount=0 i paymentType=3 w ograniczonej ścieżce odbioru i zwrotu w tym samym miejscu, bez płatnych dodatków. Potwierdzić u Arvent, że cały najem jest płatny przy odbiorze.
- Przy rozbieżności SIPP, kwoty, trasy lub warunków brak automatycznego vouchera. Status wymaga zgodności numeru dostawcy. W odpowiedzi zapisu sprawdzana jest również referencja Ride24. Numer, PDF i dostarczenie wiadomości sprawdzić na rzeczywistym potwierdzeniu.
- Brak danych o wymaganym stażu, dodatni wymagany staż bez dowodu, nieznany minimalny wiek, niepotwierdzona trasa one-way i obowiązkowy dodatek bez jawnej zerowej ceny blokują ścieżkę. Profil kierowcy przechowuje wiek. Jeśli wymagane są staż lub DOB, uzupełnić źródło danych i oba klienty przed dopuszczeniem takich ofert. Uzgodnić dokumentowe minima również przy API zwracającym zero.
- Po godzinie od zweryfikowanej płatności stan provider_pending przechodzi przy następnym przebiegu do ręcznej kolejki. Osoba dyżurna sprawdza referencję u Arvent. Sam upływ czasu nie daje podstawy do zwrotu lub ponownego zapisu.
- Błąd przy końcowym przygotowaniu przed SaveReservation może uruchomić pełny zwrot. Niejednoznaczny wynik próby zapisu podlega ręcznemu uzgodnieniu. Odpowiedź 6 pozostaje do wyjaśnienia. Wcześniejszą próbę anulowania weryfikuje się odczytem statusu. Nowa tabela arvent_cancel_attempts wymaga osobnej migracji przed użyciem adaptera.
- Admin w main blokuje aktywację Arvent bezwarunkowo. Pozostawić blokadę do certyfikacji. Przed sprzedażą przygotować kontrolowaną zmianę tej blokady z testem. W żadnym kroku nie przełączać globalnych ustawień innych partnerów.

## Kolejność następnej sesji

1. Odczytać ten PR, jego końcowy SHA i CI, bieżący main i wersje wdrożeń. Potwierdzić pisemne uzgodnienie Stripe-first oraz aktualne dokumenty dla klienta. Pozyskać szczegóły stażu i DOB, pokrycia ubezpieczenia dla taryfy, płatnych dodatków, one-way i ostateczności statusu 6. Uzyskać przykładową odpowiedź zatwierdzenia ze wskazaniem SIPP i referencji, bez danych klienta.
2. Uzupełnić pozostałe wymagane pola i reguły. Odtworzyć pełną ścieżkę WWW i Android na mockach, w tym odmowę po zmianie ceny, voucher, e-mail/push i zwrot. Sprawdzić rozliczenie 100% EUR dla Arvent.
3. Po przeglądzie scalić zatwierdzony kod, sprawdzić plan migracji i pakietów, różnice względem produkcji i możliwość powrotu. Wdrażać tylko zatwierdzone wersje przy wyłączonej sprzedaży i wyłączonych bramkach. Sprawdzić wersje, zależności i odczyty u dostawcy.
4. Uzgodnić z Arvent konkretny termin, dane, cenę i natychmiastowe anulowanie kontrolowanej rezerwacji. Uzyskać osobne upoważnienie do rzeczywistej płatności, zapisu, anulowania i zwrotu. Przygotować dostęp wyłącznie dla certyfikowanej próby; nie otwierać publicznych ofert w celu testowania. Dla tego konta przełączyć provider na arvent_kolaycar w kontrolowanym trybie. Nigdy nie wysyłać próbnego POST na ślepo.
5. Zachować dowody jednej opłaty Stripe i jednej rezerwacji Arvent, statusów 0/1 odpowiednio do rzeczywistej odpowiedzi, niezmienionych SIPP/trasy/kwoty/warunków, numeru Arvent na PDF i doręczeń. Następnie potwierdzić status 3 tej samej referencji, rozliczenie uzgodnionego zwrotu i powiadomienia. W razie timeoutu uzgodnić istniejącą rezerwację.
6. Dopiero po podpisaniu wyniku certyfikacji dopuścić sprawdzone lotniska i grupy, monitorować kolejkę i pierwsze rezerwacje. Przy problemie zatrzymać nową sprzedaż Arvent, zachowując obsługę już pobranych płatności i istniejących rezerwacji.

Żadnego wdrożenia, publicznej aktywacji, rzeczywistego zapisu Arvent ani operacji finansowej nie przeprowadzono w ramach audytu.

## Aktualizacja 19.11.2026 — zgoda Arvent na kolejność Stripe-first

Właściciel Ride24 przekazał pisemną wiadomość partnera (adresowaną do
Krzysztofa) z następującym potwierdzeniem:

> "We confirm that the proposed booking and payment process is acceptable
> to Arvent. You may proceed with the final booking and cancellation tests.
> Please ensure that reservations are only considered confirmed after
> Arvent's approval."

**Konsekwencje**:
- Otwarty punkt zgody partnera na proces `Stripe (opłata Ride24) →
  kontrola dostępności i ceny → zapis rezerwacji Arvent → potwierdzenie
  dopiero po statusie zatwierdzonym przez Arvent` został **potwierdzony
  na poziomie komunikacji partnera**.
- Nie traktować `Received (0)`, HTTP 200 ani samej zapłaty Stripe jako
  zatwierdzenia; voucher potwierdzający dopiero przy zweryfikowanym
  `Approved (1)`.
- Wiadomość **nie zmienia automatycznie** istniejących wersjonowanych
  regulaminów EN/TR, w których opisano wcześniejszą kolejność opłaty.
  Przed pierwszą transakcją trzeba uzgodnić/jasno udokumentować aneks
  lub nową zaakceptowaną wersję warunków dla klientów i zachować historię.
- Zgoda na testy ze strony Arvent nie zastępuje osobnej kontroli po
  stronie Ride24 dla realnej płatności, stworzenia i anulowania
  rezerwacji w systemie produkcyjnym.
- Brak potwierdzenia stażu prawa jazdy, DOB, pokrycia ubezpieczenia dla
  konkretnych taryf, dodatków, opłat one-way i statusu `6` nadal
  wymaga ograniczenia zakresu ofert/wyjaśnienia przed sprzedażą.
- Dwie bramki serwerowe pozostają wyłączone; publiczna widoczność
  Arvent pozostaje wyłączona do zakończenia certyfikacji.

Kolejny krok: bezpieczny merge PR #121, kontrolowana migracja tabeli
anulowań i przygotowanie aktualizacji dokumentów przy wyłączonych
ofertach; następnie certyfikacja jednej rezerwacji i anulowania.

## Aktualizacja wykonawcza 19.11.2026 — po pisemnej zgodzie Arvent

### Zakończone (potwierdzone)
- Arvent napisał: "We confirm that the proposed booking and payment process is
  acceptable to Arvent. You may proceed with the final booking and cancellation
  tests. Please ensure that reservations are only considered confirmed after
  Arvent's approval." Ta zgoda dotyczy **Stripe-first** jako osobnej opłaty
  Ride24, bez uznawania samej płatności lub statusu Received za zatwierdzenie.
- PR **#121** został scalony do `main` jako
  `18ac4e354e64af7811dae0581142a5e07ad68943`.
  Ponowny pełny CI **312/312**:
  <https://github.com/expol1/ride24/actions/runs/44499046154>.
- Migracja `arvent_cancel_attempts` wdrożona w produkcyjnym Supabase.
  Potwierdzono RLS, brak INSERT dla anon/authenticated, INSERT wyłącznie
  dla service_role. Konto Arvent nie zostało aktywowane.
- Świeży **read-only** request bezpośrednio z Supabase do live Arvent API:
  auth HTTP 200; AYT, 16–18.02.2027, 10:00, EUR: **78 ofert**;
  każda z brakiem depozytu/karty i nieograniczonym kilometrażem,
  **55 z kodem SIPP**; każda z wymaganym stażem prawa jazdy od
  **1 do 5 lat**. Brak taryf o stażu =0; dawny warunek
  `min_license_years===0` nie pozwalałby zarezerwować żadnej z tych
  ofert. Tymczasowe odpowiedzi pg_net, w tym Bearer, usunięto.
- PR **#122** został scalony do `main` jako
  `66814119f302093e301adcfac2c090acda177c40`.
  Wdrożono izolowany dla Arvent formularz WWW z **datą pierwszego
  uzyskania prawa jazdy** (nie nowej karty), walidację daty przed
  stworzeniem zamówienia, ponowną kontrolę pełnych lat stażu przed
  Stripe i przed supplier SaveReservation. Pozostali partnerzy
  nie dostali nowego obowiązkowego pola.
  CI pełne **317/317**:
  <https://github.com/expol1/ride24/actions/runs/44501406282>;
  pozostałe workflow obowiązkowych opłat, min. dni i UX także sukces.
- Migracja dodająca opcjonalne pole
  `public.bookings.main_driver_license_since date` wdrożona do
  produkcyjnego Supabase; sprawdzone istnienie kolumny.

### Nadal ZABLOKOWANE — nie uruchamiać sprzedaży
- `api_provider='custom'`, `api_enabled=false`,
  `api_status='draft'`, 86 nieaktywnych grup i 8 nieaktywnych lotnisk.
- **Edge Functions na Supabase NIE zostały zaktualizowane** do nowych
  commitów; nie wolno utożsamiać merge GitHub z aktualizacją pakietów
  produkcyjnych. Wdrażać selektywnie, porównując z wersjami działającymi
  dla AVIA/Caravel/Pegasus. Nie przełączać dwóch bramek
  `ARVENT_KOLAYCAR_WRITE_ALLOWED` i `ARVENT_STRIPE_FIRST_APPROVED`
  przed wspólną certyfikacją.
- Wersjonowane, zaakceptowane PDF-y EN/TR nadal zawierają wcześniejszą
  kolejność płatności. Zgoda Arvent to dowód handlowy, ale należy
  sporządzić/zaakceptować aktualizację warunków widocznych klientowi
  przed pierwszym Stripe charge.
- Rzeczywiste **1× Stripe → 1× Arvent create → zatwierdzenie (1) →
  voucher/e-mail → Arvent cancel (3) → uzgodniony refund** jeszcze
  nie zostało przeprowadzone. Partner zezwala na końcowe testy;
  do operacji na realnych płatnościach i rezerwacjach trzeba uzyskać
  zgodę/plan kontrolowanej próby po stronie właściciela Ride24,
  używając rzeczywistych, uprawnionych danych testowego kierowcy.
- Wciąż trzeba sprawdzić, czy pole `birthDay` jest wymagane dla wybranej
  taryfy, zweryfikować flagi `fullCredit`/`excess`, ubezpieczenie
  w zwracanym pakiecie, płatne dodatki, one-way oraz semantykę statusu 6.
- Brak źródeł aktualnie wydanej aplikacji Android w tym repo;
  klient Android musi otrzymać pole daty pierwszego uzyskania
  prawa jazdy albo nie może sprzedawać Arvent do chwili aktualizacji.
  Obecny backend zablokuje taki niekompletny request przed opłatą.

**Stan:** kod i obie migracje przygotowane; marketingowo i transakcyjnie
Arvent pozostaje wyłączony. Nie deklarować ukończenia integracji
produkcyjnej bez powyższej certyfikacji i wdrożenia Edge.
