# Caravel — audyt przed certyfikacją, 16 listopada 2026

## Zakres i werdykt
Audyt statyczny repozytorium `expol1/ride24` PR #84 oraz odczytowy przegląd wdrożeń i tabel Supabase Ride24 `zwyerdeuvyzgkgwglowr`.
**NO-GO dla oficjalnej certyfikacji oraz włączenia ofert dla klientów.**
**GO dla dalszych izolowanych testów sandboxowych po kontroli i zgodzie na każdą operację wdrożeniową.**
Nie wykonano migracji SQL, wdrożeń nowych Edge Functions, merge, startu certyfikacji ani rezerwacji produkcyjnych.

## Potwierdzone fakty
- PR #84 `claude/caravel-finish` pozostaje draft, bazą jest `feature/caravel-sandbox-integration`; produkcja Ride24 / AVIA / Stripe nie jest częścią tego PR.
- Na rzeczywistym sandboxie (wcześniejszy raport operatora testowego) EUR/GBP: 25/25 kroków `failed:false`, w tym Premium quote/book/cancel i aktywny `409 revision_conflict`. Rezerwacje testowe anulowane.
- Odczyt bieżącego Supabase: `caravel-sandbox-acceptance` v12 i `caravel-sandbox-diagnostics` v6 mają entrypoint `closed.ts` i `verify_jwt=true`. **Starsza, osobna** `caravel-sandbox-diagnostic` v8 ma nadal aktywny read-only kod diagnostyczny i `verify_jwt=true`; należy ją zamknąć po potwierdzeniu, że nie jest potrzebna.
- Bieżąca lista tabel `public.caravel_sbx_%` jest pusta. Wszystkie pliki SQL w `docs/integrations` są **projektami, nie wdrożeniami**.
- Odbiornik HMAC, worker luk, okresowe odpytywanie i repozytorium stanu faz są przygotowane w kodzie, ale nie działają w środowisku.
- Brak realnego `/_certification/hmac-self-test`, dostawy webhooka i 24-godzinnego `/_certification/start`. Nie ma produkcyjnego klucza potwierdzającego zerowy depozyt i udziały własne Premium.

## Poprawki dokonane w trakcie audytu
1. SQL odzyskiwania luk: `caravel_sbx_reconcile_apply_page` resetuje teraz `attempts=0` po udanym atomowym zatwierdzeniu strony. Wcześniej licznik był zwiększany również za udane kolejne strony i mógł zablokować skan po 10 stronach.
2. GitHub Actions obejmuje teraz także `caravel-*.mjs`, nowe `caravel-sandbox-*/index.ts` i projekty SQL. Dodano osobną kontrolę `deno check` dla pięciu izolowanych entrypointów. Dotychczasowe zielone testy Node nie obejmowały tych źródeł.
3. Pierwsza kontrola Deno ujawniła błędy typowania wywołań. Dodano izolowaną konfigurację audytową (bez modyfikowania wspólnego `ride24-security.ts`) i doprecyzowano parametry wywołań sandboxowych.
4. W żadnym kroku nie zmieniono aktywnych rezerwacji, danych klientów, Stripe ani AVIA.

## Wysokie ryzyka do usunięcia przed uruchomieniem
1. **SQL nieprzetestowany w PostgreSQL.** Same mocki Node nie sprawdzają RLS, `SECURITY INVOKER`, przyznanych praw ani atomowości przy równoległych transakcjach. Przed deployem uruchomić pliki w odrębnej bazie/staging, sprawdzić role `anon`, `authenticated`, `service_role`, blokady i rollback.
2. **Dwa typy Edge Functions bez JWT.** Odbiornik webhooków musi poprawnie weryfikować rzeczywisty HMAC po surowych bajtach i mieć bezpieczne sekrety; workery muszą wymagać długich wewnętrznych sekretów. Brak konfiguracji = odpowiedź nie-2xx. Obecnie niewdrożone.
3. **Słaba gwarancja częstotliwości.** Jedno uruchomienie workera obsługuje tylko jednego dostawcę i jedną stronę. Cron co 5 minut nie gwarantuje odczytu **każdego** dostawcy co 5 minut. Przy dużej liczbie stron kolejne konta czekają. Wymagany harmonogram uwzględniający liczbę dostawców, API limit i kolejkę.
4. **Ograniczone pokrycie opóźnionych zdarzeń.** Pierwszy poll = poprzednie 24 h, późniejsze zapytania mają nakładanie 5 min. Gdy dostawca ujawni zmianę z opóźnieniem dłuższym niż overlap, może nie być wykryta. Wymagany kontrolowany backfill lub mocniejszy kontrakt API.
5. **Opcjonalność `supplier_id` webhooka.** `parseCaravelWebhookEvent()` dopuszcza `supplier_id: null`, natomiast nowy odbiornik odrzuca takie zdarzenie. Jest to bezpieczne fail-closed, ale trzeba potwierdzić z Caravel, czy prawdziwe dostawy zawierają ID, zanim endpoint zostanie podłączony.
6. **Pamięć faz certyfikacyjnych.** Referencje zapisywane w prywatnym bucketcie wymagają rzeczywistego testu kolejnych faz oraz kontroli równoległych żądań (blokada `running` w JS nie jest globalną blokadą między instancjami).
7. **Brak potwierdzenia pełnej certyfikacji.** Wymagania z ruchu: 401/403/404/409/422/429, `Retry-After`, `expired quote`, `expected_price` direct-price guard, błędy paginacji i rzeczywiste dostarczenie webhooka nadal nie są wszystkie potwierdzone. Wymagana osobna próba generalna.
8. **Produkcja Premium.** Nawet pozytywny sandbox nie potwierdza `deposit=0`, `excess=0`, `theft_excess=0`, pełnych `covers/excludes`, braku karty i `tax_inclusive=true` w produkcji. Oferty pozostają niewidoczne.

## Warunki do bezpiecznego dalszego etapu
1. Potwierdzone zielone Node + TypeScript + Deno CI na bieżącym head, bez nowych błędów.
2. Zamknięcie lub uzasadnienie starszej funkcji `caravel-sandbox-diagnostic`.
3. Przegląd i testy SQL w odrębnym środowisku, bez migracji na produkcyjnej bazie Ride24.
4. Kontrolowane uruchomienie prywatnego bucketu, odbiornika, workerów i testów end-to-end HMAC/retry/sequence gap/periodic catch-up przy użyciu fikcyjnych danych.
5. Dopiero po tych testach: HMAC self-test, komplet wymagań certyfikacyjnych, jawna decyzja o uruchomieniu 24-godzinnego runu. **Nie uruchamiać go automatycznie.**
6. Dostęp produkcyjny dopiero po raporcie Caravel, z walidacją warunków Premium i bez naruszania standardowego przepływu Stripe → re-check → partner booking → voucher.

Uwagi: bieżące mocki i GitHub Actions nie potwierdzają działania przyszłych funkcji w Supabase. Każdy deployment należy jawnie autoryzować i sprawdzić po uruchomieniu.
