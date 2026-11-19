# Caravel sandbox — trwały odbiornik webhooków (PR #84)

**Stan: kod przygotowany, CI mock zaliczone; brak wdrożenia, brak rzeczywistej dostawy webhooka i brak certyfikacji.**

## Dlaczego osobny odbiornik

Wcześniejszy `caravel-sandbox-webhook-probe` potrafi sprawdzić HMAC, ale nie zachowuje stanu między instancjami. Nowy `caravel-sandbox-webhook-receiver` ma osobną, prywatną ewidencję zdarzeń, dostępną wyłącznie z serwera. Nie zmienia produkcyjnych rezerwacji Ride24.

### Co robi

1. Odbiera tylko POST, maks. 32 KiB, z dokładnym surowym body. Odrzuca brak/zły HMAC, błędną ścieżkę i timestamp poza oknem 300 sekund. Obsługuje rotację sekretu.
2. Po weryfikacji HMAC waliduje `event_id`, `operator_id`, `booking_id`, `supplier_id`, rewizję i sekwencję. Bez `supplier_id` nie wykonuje odczytu.
3. W prywatnym SQL wykonuje atomowe zajęcie `event_id` z leasingiem (przeciw równoległej dostawie).
4. Pobiera `GET /v1/bookings/{booking_id}` **z prawdziwego sandboxa Caravel** w zakresie tego samego dostawcy. Nie stosuje treści webhooka jako prawdy.
5. Atomowo zapisuje wyłącznie obserwowany status i najwyższą rewizję (starsza nigdy nie cofa stanu), numer sekwencji i fakt obsługi zdarzenia. Nie zapisuje danych osobowych ani klucza API.
6. Jeśli API lub zapis zawiedzie, zwraca 503 i zwalnia zajęcie zdarzenia (lub po 120 sekundach może je odzyskać kolejna instancja); dostawca powinien ponowić dostawę.
7. Identyczne `event_id` po zakończeniu obsługi zwraca HTTP 200, bez powtórnego pobrania rezerwacji.
8. Jeśli istnieje luka sekwencji, wynik zwraca `needs_reconciliation=true`. **Nie jest jeszcze automatycznym wykonaniem odczytu `GET /v1/bookings?updated_since`**.

### Ochrona Ride24

- Kod nie zawiera ścieżki do `provider-adapters`, `search-api`, AVIA, Stripe, voucherów, profili klientów ani aktualizacji prawdziwych rezerwacji.
- Ten receiver **nie służy do produkcyjnego sterowania stanem rezerwacji**. To izolowany i certyfikacyjny odbiornik sandboxowy.
- Nowa funkcja ma krótki termin wygaśnięcia i nie została wdrożona. Gdy wygasa, odpowiada 410.
- Pierwotny `caravel-sandbox-acceptance` pozostaje zamknięty (410).
- Sekrety `CARAVEL_SANDBOX_WEBHOOK_SECRET`, opcjonalny `_OLD` i `CARAVEL_SANDBOX_API_KEY` muszą znajdować się wyłącznie w Supabase Edge secrets; nie wysyłać ich do przeglądarki ani Github.

## Warunki pierwszego wdrożenia (dopiero po kontroli bezpieczeństwa)

1. Zweryfikować ręcznie zawartość `docs/integrations/caravel-sandbox-webhook-state.sql` (plik **NIE jest migracją zastosowaną w bazie**).
2. Utworzyć i przetestować trzy prywatne tabele z RLS oraz trzy funkcje RPC `caravel_sbx_webhook_*`, dostępne tylko dla `service_role`. Sprawdzić, że `anon` i `authenticated` nie mają `SELECT` ani `EXECUTE`.
3. Skonfigurować osobne sekrety webhooka i sandboxowy klucz API. Potwierdzić zgodność kluczy z właściwym kontem Caravel.
4. Sprawdzić `deno check` obu nowych entrypointów z importami przypiętymi do dokładnego SHA. Testy Node/GitHub CI nie zastępują sprawdzenia Deno.
5. Wdrożyć WYŁĄCZNIE `caravel-sandbox-webhook-receiver` z `verify_jwt=false`: Caravel nie wysyła JWT, więc funkcja odrzuca weryfikację JWT na rzecz HMAC. Bez skonfigurowanego HMAC i atomowego SQL funkcja ma zwracać **nie-2xx**.
6. Wskazać Caravel dokładną ścieżkę HTTPS webhooka (ścieżka jest częścią podpisu) i przetestować dostarczenie zdarzenia na sandboxie, tampering, duplikat i dostawę po błędzie.
7. Po teście zweryfikować brak zmian w produkcyjnych tabelach Ride24, status zdarzeń w izolowanych tabelach i wyłączenie funkcji przed terminem. Skasować testowy stan z izolowanych tabel po zakończeniu certyfikacji, zgodnie z zatwierdzoną polityką retencji.

## Nie zaliczamy jeszcze

- `webhook.live_delivery_certified`: brak rzeczywistego wywołania Caravel.
- `webhook.hmac_self_test`: nie został wysłany.
- Synchronizacja po wykrytym `sequence_gap` jest już przygotowana w PR (worker + kolejka SQL + paginacja i checkpoint), ale **nie jest wdrożona ani uruchomiona**. Brak także okresowego odpytywania w razie całkowitej ciszy webhooków. Szczegóły: `caravel-sandbox-webhook-reconcile.md`.
- Pełnego adaptera produkcyjnego do Ride24 — wymagane odrębne wdrożenie po zakończeniu AVIA.
- Pomiary z prawdziwego ruchu 429/503, expired quote i direct `expected_price` guard — CI symuluje odpowiedzi, a nie wystawia Caravel certyfikatu.

**Nigdy nie uruchamiać `POST /_certification/start` tylko dlatego, że testy CI są zielone.**

## Bieżący stan środowiska po rzeczywistych testach — 16.11.2026

> Powyższe historyczne fragmenty o niewdrożonych tabelach i workerach
> pochodzą z wcześniejszej fazy. Poniżej opisano stan zweryfikowany
> bezpośrednio w Supabase `zwyerdeuvyzgkgwglowr`.

- Trzy tabele `caravel_sbx_webhook_*` już istnieją. RLS aktywne,
  `anon` i `authenticated` nie mają uprawnień `SELECT`.
- Trzy RPC `caravel_sbx_webhook_claim/finalize/release` już istnieją.
  `SECURITY DEFINER=false`, brak `EXECUTE` dla klientów,
  `service_role` ma dostęp.
- `caravel-sandbox-reconcile-worker` v1 i
  `caravel-sandbox-periodic-poll` v2 są wdrożone i mają sprawdzone
  zabezpieczenia nagłówkiem `x-internal-secret`.
- Jeden ręczny skan GBP i jeden EUR na rzeczywistym sandboxie zaliczone:
  2 skany `idle`, 6 obserwacji (po 3 na dostawcę), wszystkie
  `cancelled` w rewizji 2. Brak aktywnych blokad i Cron.
- **Odbiornik `caravel-sandbox-webhook-receiver` nadal niewdrożony**.
  `CARAVEL_SANDBOX_WEBHOOK_SECRET` i opcjonalny `_OLD` nie były
  skonfigurowane w ostatnim administracyjnym preflight. Ich bieżący
  stan wymaga ponownego sprawdzenia przed aktywacją.

### Blokada: rzeczywisty sekret i potwierdzenie semantyki dostawy

Przed wdrożeniem trzeba uzyskać od Caravel lub z ich portalu:

1. Prawdziwy **sandboxowy sekret podpisu HMAC** dla rejestrowanego webhooka
   i bezpieczny sposób jego uzyskania; nie tworzyć go lokalnie w zastępstwie
   sekretu, którego używa nadawca.
2. Potwierdzenie, że Caravel podpisuje dokładną ścieżkę
   `/functions/v1/caravel-sandbox-webhook-receiver` razem z metodą POST,
   timestampem i niezmienionym body, tak jak określa ich Webhook Receiver Guide.
3. Potwierdzenie, czy `supplier_id` jest obecny we **wszystkich** webhookach;
   parser dopuszcza jego brak, lecz odbiornik celowo odrzuca brakujące
   `supplier_id` przed pobraniem rezerwacji z API.
4. Sposób rejestracji adresu webhooka i wykonania rzeczywistej dostawy
   sandboxowej oraz `/_certification/hmac-self-test`.
5. Czy każda ponowiona dostawa otrzymuje **nowy podpis z aktualnym
   timestampem** (odbiornik odrzuca podpis starszy niż 300 s).

Docelowy adres **dopiero po konfiguracji i zatwierdzeniu**:
`https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/caravel-sandbox-webhook-receiver`

Nie przekazywać sekretu przez GitHub, e-mail z plaintextem lub czat.
Wprowadzić go tylko w serwerowej konfiguracji Supabase Edge Secrets
bez wypisywania jego wartości. Samo HTTP 503 bez HMAC nie jest certyfikacją.

### Następna kolejność

1. Weryfikacja preflight sekretów i dokładnego kontraktu podpisu.
2. Po otrzymaniu sekretu, osobna decyzja o wdrożeniu receivera
   `verify_jwt=false` ze sprawdzeniem odmowy 401/503 bez podpisu.
3. Dostawa prawdziwie podpisanego webhooka i audyt w prywatnych tabelach:
   deduplikacja, rewizja, 5-minutowe okno, retry, luka sekwencji.
4. Dopiero później self-test i 24-godzinna certyfikacja po osobnej zgodzie.

