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
