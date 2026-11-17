# Caravel — wiążące wyjaśnienia techniczne dostawcy z 17.11.2026

Źródło: pełna treść odpowiedzi e-mail Caravel przekazana przez Ride24.
Nowsza odpowiedź zastępuje wcześniejsze domysły dotyczące L2A,
dostaw webhooków i reprezentacji regulaminu.

## 1. Webhooks — istotna zmiana procedury

- Self-service sandbox **NIE dostarcza webhooków na URL**. Zdarzenia
  utworzenia, aktualizacji i anulowania rezerwacji są przechowywane
  w inspektorze konta Caravel z dokładnym body i nagłówkami.
  Można je odtworzyć w izolowanym walidatorze używając rzeczywistego
  sekretu podpisującego; w typowej certyfikacji nie ma konieczności
  publicznego webhook receiver.
- Dostawy na żywy endpoint **przed produkcją** są opcjonalne i wymagają
  wcześniejszego zweryfikowania właścicielstwa URL według WEBHOOKS.md §7,
  po czym Caravel włącza je tylko dla jednego dostawcy sandbox.
- Portal nie pokazuje sekretu. Pierwsze `POST /v1/webhooks/test` z kluczem
  o uprawnieniu `write:webhooks` tworzy sekret, jeżeli go jeszcze nie ma.
  Rotacja przez `POST /v1/webhooks/secret/rotate` zwraca **nowy sekret
  jednorazowo**. Nie wywoływać tych operacji bez przygotowanego
  bezpiecznego i trwałego zapisu sekretu w Supabase Edge Secrets.
  Nigdy nie umieszczać sekretu w GitHub, raportach, logach ani czacie.
- Po rotacji Caravel może podpisywać starym i nowym kluczem. Kod
  `verifyCaravelSignature` poprawnie dopuszcza dowolny pasujący
  `v1=` z `X-Caravel-Signature` dla dostępnych kluczy. Gdy aktywny
  poprzedni klucz, przechowywać go jako osobny sekret tylko w okresie
  przejściowym, potem bezpiecznie wycofać.
- Rejestracja publicznego HTTPS URL:
  `PUT /v1/webhooks/endpoint` JSON `{"url":"https://..."}`,
  kontrola przez `GET /v1/webhooks/endpoint`. URL bez credentials.

### Certyfikacyjny HMAC self-test (bez sekretu konta)

1. Przeczytać dokładnie bieżący
   `fixtures/webhook-hmac-self-test.json` z paczki Caravel.
2. HMAC-SHA256 na dosłownych polach wzorca i **jego własnym** sekrecie,
   z `fixture.t` jako czasem obecnym, sprawdzić
   `expected_signature_hex`.
3. Weryfikator musi odrzucić `tamper_test.tampered_body`.
4. `POST https://sandbox-api.caravelway.com/_certification/hmac-self-test`
   z kluczem sandbox i JSON
   `{"signature_hex":"<64 lower-case hex>","tampered_rejected":true}`.
   Dopiero odpowiedź Caravel / portal potwierdza zaliczenie.
5. **Nie jest to** `/_certification/start`. Okna 24h nie uruchamiać
   automatycznie, dopóki warunki certyfikacji nie są spełnione.

W kodzie: `buildCaravelHmacSelfTestSubmission()` buduje i sprawdza
dane lokalnie z oficjalnego wzorca; `submitSandboxHmacSelfTest()`
to jawne, sandbox-only zgłoszenie wyniku z kluczem na serwerze.
Mockowane testy nie stanowią oficjalnego potwierdzenia.

## 2. Grupa L2A

Caravel potwierdził, że produkcyjny katalog Ride24 **nie będzie zawierał
L2A**, więc nie trzeba implementować odrębnego filtra. Jedynym
identyfikatorem grupy jest **opaque** `vehicle_id` na
`GET /v1/reference/vehicles`; produkcyjne identyfikatory nie są takie
same jak w sandbox. Nigdy nie parsować `vehicle_id` ani pola `name`
w celu odgadywania grupy. Poprzedni spekulacyjny filtr L2A usunięto
z izolowanego adaptera; ceny i ochrona nadal przechodzą niezależną
weryfikację.

## 3. Wiążące warunki najmu, data i wersja

- `GET /v1/reference/terms` → lista **metadanych aktualnego**
  dokumentu na język, BEZ treści:
  `document_id`, `language`, `version`, `title`, `format`,
  `content_hash`, `published_at`, `withdrawn_at`.
- `GET /v1/reference/terms/{document_id}` → te same pola **oraz**
  `body`, które dla formatu `clauses/v1` jest drzewem
  ponumerowanych klauzul, zwykły tekst bez HTML.
- Dokumenty są niezmienne. Nowa wersja oznacza nowy `document_id`,
  wyższą `version` i `withdrawn_at` na starej. Numery klauzul
  nadają się do cytowania.
- Caravel wskazał aktualną wersję **EN v4, opublikowaną 17.11.2026**.
  Numer wersji dotyczy regulaminu, NIE wersji Channel API.
- `content_hash` to SHA-256 **kanonicznej reprezentacji** regulaminu,
  zgodnie ze schematem i umową §3.9. Bez odczytania tych konkretnych
  reguł nie wolno wymyślać algorytmu kanonizacji ani twierdzić,
  że hash został zweryfikowany.
- Na każdym sync odczytać bieżący `document_id`, wykrywać zmiany,
  nie nadpisywać automatycznie wersji zaakceptowanych przez klientów.
- Przed Stripe pokazać **pełny dokument Caravel pobrany z API**.
  Zapisać dokładny `document_id` i potwierdzenie akceptacji do
  każdej rezerwacji. Po zmianie `document_id` w czasie rezerwacji
  zablokować stare warunki i wznowić proces z aktualnym dokumentem.
- Stare `terms.pdf` i `rules.pdf` w Supabase istnieją i mogą być
  użyte **jedynie jako materiał do porównania**, NIE jako
  obowiązujący kontrakt, jeśli pochodzą spoza endpointu API.
  Odrębny PDF do klienta można wygenerować z dokładnie tej samej,
  zweryfikowanej treści `clauses/v1`, o ile nie zmienia klauzul.
- W repo dodano odczyt listy i konkretnego dokumentu
  `referenceTerms()` / `referenceTermsDocument()`. Dodano też
  isolated `CaravelBookingDraft.termsDocumentId` i porównanie
  identyfikatora pokazanego użytkownikowi z id w zapisanej wycenie
  i aktualnym identyfikatorem z API. **To nie jest jeszcze wpięte
  w wspólny formularz ani zapis do produkcyjnej tabeli `bookings`.**

## 4. Rzeczywisty stan dostępu i testów

- Testy mockowane oraz Ride24 API Compatibility QA potrafią działać
  bez klucza Caravel; nie oznaczają certyfikacji.
- 17.11.2026 uruchomiono przez etykietę PR test LIVE SANDBOX
  w GitHub Actions. **Pierwszy wynik: FAILURE bez wywołań API**,
  ponieważ repozytorium nie ma `CARAVEL_SANDBOX_API_KEY`
  w Actions Secrets. To nie był błąd API Caravel.
  Po naprawie workflow, kolejny przebieg
  [44184521369](https://github.com/expol1/ride24/actions/runs/44184521369)
  wykazał **SUCCESS ze wszystkimi etapami API SKIPPED**.
  Powód jest zapisany jawnie w raporcie; test zewnętrzny NIE odbył się.
  Istniejący klucz w Supabase Edge Secrets nie został przeniesiony
  do GitHub i nie wolno go tam ujawniać w logach.
- Nie robić `webhooks/test` ani `secret/rotate` w pośpiechu:
  sekret pojawia się jeden raz i wymaga bezpiecznego zapisu.
  Certyfikacyjny HMAC fixture używa **własnego testowego sekretu**,
  więc nie trzeba do tej czynności rotować sekretu konta.

## 5. Odrębny biznesowy NO-GO produkcyjny

Caravel w wcześniejszym e-mailu potwierdził brak pokrycia
**szyb, opon/kół i podwozia** w Premium i opłatę EUR100 przy
szkodzie/kradzieży także w Premium. Dokument API v4 wymaga
bezpośredniej weryfikacji. Dotychczasowe Ride24
`REQUIRED_PREMIUM_COVERS` odrzuca takie oferty.
Brak L2A nie usuwa wyłączeń ubezpieczenia.
Uruchomienie ofert wymaga produktu zgodnego ze standardem Ride24
albo odrębnej świadomej decyzji o zmianie standardu i uczciwym
wyświetlaniu ochrony klientowi. Bez niej `api_enabled=false`.

## 6. Trwały zapis regulaminu przy booking

Projekt migracji (NIE WYKONANO):
`docs/integrations/caravel-terms-booking-snapshot.sql`.
Przed użyciem trzeba zintegrować z `create-booking-request` i
`api_quotes`, zabezpieczyć zapisy wyłącznie po stronie serwera,
zweryfikować RLS oraz testy wyświetlenia przed Stripe i na voucherze.
