# Caravel — periodiczny odczyt sandboxa przy całkowitym braku webhooków

**Stan 16.11.2026: tylko kod w PR #84. Niczego nie uruchomiono w Supabase ani na prawdziwym API.**

## Mechanizm

1. Serwer pobiera listę dostawców z `GET /v1/suppliers` — nie zakłada z góry EUR/GBP ani nie pobiera jej z przeglądarki. Dla nowego dostawcy zakłada osobny monitor.
2. Co najmniej 5 minut po ostatnim ukończonym przebiegu może uruchomić nowy cykl. Pierwszy przebieg obejmuje tylko poprzednie **24 godziny**; kolejne startują **5 minut przed ostatnim ukończonym punktem**, aby objąć opóźnione aktualizacje. Dłuższych przerw dostawcy nie należy uznawać za pokryte bez osobnego backfillu.
3. W jednym wywołaniu sprawdza **maksymalnie jednego dostawcę i jedną stronę (do 100 rezerwacji)** z `GET /v1/bookings?updated_since`. Dla każdego otrzymanego `booking_id` pobiera aktualny stan przez `GET /v1/bookings/{id}`.
4. W prywatnych tabelach sandboxowych zapisuje jedynie `supplier_id`, `booking_id`, `revision`, `status`, znacznik obserwacji i ostrzeżenie, że webhook nie został jeszcze zaobserwowany lub ma niższą rewizję. **Nie zapisuje danych klienta i nie zmienia rezerwacji Ride24**.
5. Zapis całej strony wraz z nowym nieprzezroczystym `page_token` jest atomowy. `watermark_at` przesuwa się do godziny **rozpoczęcia skanu** dopiero po ostatniej stronie. Błąd, zerwane połączenie, błędne dane lub przekroczony budżet nie potwierdzają strony.
6. Maksymalnie 10 nieudanych prób jednej strony, leasing 120 sekund, budżet Edge 75 sekund, limit 30 stron na skan. Nadmierna liczba stron lub powtarzający się kursor kończy próbę błędem; wymaga przeglądu.
7. `webhook_missing_or_behind` jest **sygnałem do kontroli**, nie dowodem, że zdarzenie nigdy nie nadejdzie. Odbiornik webhooków i poller prowadzą odrębne ewidencje. Nie aktualizujemy automatycznie zamówień klientów ani nie wysyłamy zwrotów.

## Kod i dane

- `supabase/functions/_shared/caravel-sandbox-periodic.mjs` — logika per dostawca, jedno wywołanie, jedna strona.
- `supabase/functions/caravel-sandbox-periodic-poll/index.ts` — **niewdrożony** punkt wejścia z oddzielnym sekretem `CARAVEL_SANDBOX_PERIODIC_SECRET`; zakończy działanie 20.11.2026 o 20:00 UTC, jeśli nie zostanie jawnie zrewidowany.
- `supabase/functions/_shared/caravel-webhook-repository.mjs` — cztery nowe metody RPC.
- `docs/integrations/caravel-sandbox-periodic-reconcile.sql` — **niewykonany** projekt dwóch prywatnych tabel i czterech funkcji SQL `SECURITY INVOKER`, wyłącznie `service_role`, RLS włączony.
- `tests/caravel-sandbox-periodic.test.mjs` — symulacja dwóch dostawców, wielu stron, awarii w połowie strony, starszej rewizji, błędnego kursora i obsługi RPC.

## Przed uruchomieniem

- Konieczny przegląd SQL, RLS, uprawnień i testy transakcji na osobnym środowisku. GitHub CI testuje **mocki**, nie wykonuje SQL ani nie sprawdza Postgresa.
- Odbiornik, worker luki i nowy poller wymagają osobnej weryfikacji `deno check` i zabezpieczenia sekretami. `verify_jwt=false` bez prawidłowego, silnego `x-internal-secret` jest niedopuszczalne.
- Cron jest **nieutworzony**. Po zatwierdzeniu można użyć Supabase Cron/pg_cron + pg_net i Vault, aby wywoływać jedną funkcję co 5 minut; sekret musi pozostać poza SQL kodem i publicznym klientem. Dodatkowo należy przejrzeć kolejkę odpowiedzi błędnych, żeby dłuższa awaria nie przeszła niezauważona.
- Wysokie obciążenie: gdy jest więcej niż 100 rezerwacji na stronie lub ponad 30 stron, fail-closed i alarm, nie nieograniczona pętla. Monitor musi potwierdzić wykonanie skanu u **każdego** dostawcy.
- Test na rzeczywistym API EUR i GBP, weryfikacja opóźnienia webhooków, sztuczna awaria i wznowienie, brak wycieków danych, zamknięcie funkcji (410), a potem skasowanie testowej telemetrii.

## Ograniczenia

To jest wyłącznie **sandboxowy monitor** zapewniający dodatkowy kanał wykrywania zmian. Nie implementuje produkcyjnego przepływu Ride24 ani pełnej synchronizacji bez utraty zdarzeń przy dowolnie długiej awarii. Jeśli Caravel dostarczy rekord później niż pięciominutowe nakładanie, nie musi zostać automatycznie wykryty. Dokumentacja Caravel może wymagać silniejszych gwarancji; przed certyfikacją należy sprawdzić rzeczywistą semantykę `updated_since` i paginacji.

**Nie uruchamiaj `POST /_certification/start` ani żadnego harmonogramu bez osobnej decyzji.**
