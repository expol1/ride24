# Caravel sandbox — odzyskiwanie pominiętych webhooków

**Stan na 16.11.2026: przygotowane wyłącznie w PR #84; nie wdrożono.**

## Zakres
Zdarzenie webhook jest weryfikowane HMAC, a jego dane nie są stosowane jako stan rezerwacji. Po odczycie rezerwacji przez API Caravel, atomowy zapis zdarzenia tworzy **zadanie odzyskiwania**, gdy numer `sequence` przeskakuje w obrębie danego operatora.

Kod:
- `caravel-sandbox-reconcile.mjs` — jedną stronę `GET /v1/bookings?updated_since=...` na jedno wywołanie, wraz z paginacją po niezmienionym `page_token`. Dla każdego identyfikatora ze strony oddzielne `GET /v1/bookings/{booking_id}`.
- `caravel-webhook-repository.mjs` — serwerowe RPC `claimJob`, `commitPage` i `releaseJob`.
- `caravel-sandbox-reconcile-worker/index.ts` — **niewdrożony** worker, działający tylko dla sandboxa, chroniony sekretami Supabase. Nie aktualizuje rezerwacji klientów Ride24.
- `caravel-sandbox-webhook-reconcile.sql` — projekt prywatnej kolejki i atomowych funkcji SQL, stosowany **po** `caravel-sandbox-webhook-state.sql`.

## Odporność
1. Trigger `AFTER UPDATE` po zakończeniu webhooka zapisuje zadanie w tej samej transakcji co finalizacja zdarzenia. Zadanie jest unikalne dla zdarzenia odkrywającego lukę.
2. Worker otrzymuje zadanie z leasingiem, więc równoległe instancje nie powinny zapisywać tego samego kursora.
3. Strona jest najpierw w pełni pobierana i wszystkie jej rezerwacje weryfikowane przez GET. Następnie **jedna transakcja** zapisuje podwyższone rewizje, a dopiero po powodzeniu zapamiętuje następny `page_token`.
4. Awaria w środku strony zostawia ten sam kursor. Rewizje są monotoniczne: starsze statusy nie zastąpią nowych.
5. Bezpieczeństwo: maks. 100 wierszy na stronę, jedna strona na uruchomienie, 80 sekund budżetu pracy, do 10 prób zadania, brak nieskończonych pętli lub zgadywania tokenów. Po 10 awariach zadanie trafia do `error` do ręcznej kontroli, **nie jest oznaczane jako wykonane**.
6. Ewidencja zawiera wyłącznie operatora, dostawcę, identyfikatory rezerwacji, statusy, rewizje, kursory i metadane przetwarzania. Nie zawiera nazwisk, numerów telefonów, adresów e-mail, voucherów, płatności ani sekretów.
7. Worker ogranicza się do `environment: "sandbox"`. Sekrety wyłącznie server-side.

## Czego brakuje do uruchomienia
- Kontroli SQL i testów transakcyjnych w izolowanym środowisku Supabase. Node/GitHub Actions sprawdza logikę na mockach, nie jest testem Postgresa.
- Osobnej zgody na utworzenie prywatnych tabel/funkcji, wdrożenie nowych Edge Functions i konfigurację sekretów. **Nie zmieniać istniejących partnerów ani `main`.**
- Przed wdrożeniem: `deno check` z importami przypiętymi do pełnego SHA i analiza zasad gateway. Odbiornik i worker korzystają z `verify_jwt=false` wyłącznie dlatego, że Caravel i planowany scheduler nie mają JWT; dostęp wymaga odpowiednio HMAC i silnego `x-internal-secret`.
- Osobnego, zatwierdzonego harmonogramu uruchomień workera (np. jeden `POST {"action":"tick"}` co 5 min). **Nie skonfigurowano cron, nie uruchomiono monitoringu.** Sam zapis kodu w GitHub nie stanowi automatyzacji.
- Testu na prawdziwym webhooku i jego podpisie, w tym duplikatów, kolejności i utraty środka sekwencji. `/_certification/hmac-self-test` nie został jeszcze wywołany.
- Widoczności zadań `error` i ręcznego mechanizmu diagnostycznego/ponowienia po usunięciu przyczyny.
- Osobnego okresowego odpytywania API w razie **całkowitego braku webhooków**, gdy nie pojawi się żaden kolejny numer sekwencji do wykrycia luki. Obecny system odzyskuje **wykryte luki**, nie nieobserwowalne milczenie strumienia.

## Kolejność bezpiecznych testów (dopiero po zatwierdzeniu)
1. Uzgodnić zakres i terminy testów; nie uruchamiać oficjalnej certyfikacji.
2. Sprawdzić SQL, RLS, uprawnienia; przetestować w transakcji konflikt kilku zapisów, crash/lease i atomiczny checkpoint.
3. Wdrożyć wyłącznie sandbox receiver i worker; zweryfikować HMAC, brak JWT dla providera, sekret schedulera i czas wygaśnięcia.
4. Wysłać fikcyjne zdarzenia podpisane prawidłowym sekretem i wywołać `tick` ręcznie. Zbadać oba dostawcy sandbox.
5. Sprawdzić kolejkę: `pending` → `running` → `done`, starszą rewizję, zapętlenie kursora, celową awarię między dwiema stronami i odzyskanie.
6. Zamknąć Edge Functions, potwierdzić 410, sprawdzić brak zmian we wspólnych tabelach Ride24 i rozliczeniach.

## Niewdrożone i niewykazane w certyfikatorze
Oficjalna 24-godzinna certyfikacja nie była uruchamiana. Testy CI są mockami. Funkcje `caravel-sandbox-acceptance` i przyszłe odbiorniki pozostają oddzielne. Nic z tego nie służy do produkcyjnego wystawiania ofert ani do tworzenia rezerwacji klientów.
