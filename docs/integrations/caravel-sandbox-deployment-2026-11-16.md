# Caravel — kontrolowane wdrożenie sandboxowe — 16.11.2026

## Werdykt

**Etap izolowanej bazy i funkcji administratora: ZALICZONY.**
**Webhooki, workery i oficjalna certyfikacja: NIEURUCHOMIONE.**
Projekt Supabase Ride24: `zwyerdeuvyzgkgwglowr`. PR #84 pozostaje
otwarty i niescalony; nie zmieniono działających rezerwacji Ride24,
AVIA, Stripe ani produkcyjnego `main`.

## Wykonane migracje PostgreSQL

| Migracja | Nowe tabele | Funkcje |
|---|---|---|
| `caravel_sbx_webhook_state_20261116` | webhook_events, webhook_bookings, webhook_streams | claim, finalize, release |
| `caravel_sbx_webhook_gap_recovery_20261116` | reconcile_jobs | queue_sequence_gap, reconcile_claim, reconcile_apply_page, reconcile_release |
| `caravel_sbx_periodic_poll_20261116` | periodic_scans, periodic_observations | periodic_register, claim, commit, release |
| `caravel_sbx_reference_cache_20261116` | reference_snapshots | reference_load, save, clear |

Łącznie **7 nowych tabel i 14 funkcji RPC/triggera**, wyłącznie
z prefiksem `caravel_sbx_`. Wszystkie tabele mają RLS ON,
brak polityk dla klientów. Bieżąca inspekcja `pg_proc` wykazała
`anon_execute=false`, `authenticated_execute=false`,
`service_execute=true` i `security_definer=false` dla wszystkich
14 funkcji.

Przed migracjami wykonano `BEGIN ... ROLLBACK` z kompletnym
tworzeniem 6 tabel i funkcjami. Po utrwaleniu przetestowano
z `service_role` w transakcji wycofanej:
zdarzenie webhook, potwierdzenie, luka sekwencji, kolejka, rewizja,
strona odzyskiwania, rejestracja dostawców, okresowy checkpoint.
Prywatna tabela katalogów przeszła oddzielny test zapisu,
odczytu, izolacji sesji i usunięcia, również z `ROLLBACK`.

Końcowe odczyty: **0** zdarzeń webhook, **0** pozycji kolejki,
**0** zarejestrowanych dostawców do okresowego pobierania i
**0** snapshotów referencyjnych.

## Zmiana bezpieczeństwa magazynu katalogów

**Nie stworzono bucketu Supabase Storage.**
Audyt `storage.objects` ujawnił istniejącą politykę
`marketing_google_ads_images_admin_only` z warunkiem
`bucket_id <> 'marketing-images'`, która dopuszcza INSERT dla
`authenticated` do pozostałych bucketów. Prywatność
`public=false` nie blokuje zapisu do prywatnego bucketu.
Zamiast tego kod `caravel-cert-state.mjs` używa nowej tabeli RLS
przez restrykcyjne RPC, tylko z `service_role`. Klucze
katalogowe zawierające separator `U+0000` są percent-encoded
wyłącznie w DB i odkodowywane przy odczycie bez utraty tożsamości.

Nie zmieniono istniejących polityk Storage innych partnerów.
**Odrębny audyt szerokiej polityki Storage jest wskazany.**

## Edge Functions

**Wdrożona:**
- `caravel-sandbox-cert-rehearsal`, wersja 2, `ACTIVE`,
  `verify_jwt=true`, aplikacyjne `requireAdmin()`.
- Wdrożone **12 plików** z aktualnej gałęzi, w tym DB-only
  `caravel-cert-state.mjs`.
- Kod ma krótki termin wygaśnięcia 20.11.2026 o 20:00 UTC.
- Endpoint **nie** uruchamia `/_certification/start`, `/advance`
  ani `/hmac-self-test` samodzielnie. Nie wykonano
  autoryzowanego wywołania testowego.
- Metadane i kod wdrożenia zweryfikowane. Faktyczny test HTTP 401/403
  i sekwencji faz wymaga osobnej sesji administratora; z tego środowiska
  nie udało się nawiązać zewnętrznego połączenia z endpointem.

**Niewdrożone / celowo zablokowane:**
- `caravel-sandbox-webhook-receiver`;
- `caravel-sandbox-reconcile-worker`;
- `caravel-sandbox-periodic-poll`.

Wymagają osobnych sekretów `CARAVEL_SANDBOX_WEBHOOK_SECRET`,
`CARAVEL_SANDBOX_RECONCILE_SECRET` i `CARAVEL_SANDBOX_PERIODIC_SECRET`,
kontroli podpisów HMAC / `x-internal-secret`,
testu odmowy bez sekretu i dopiero wtedy `verify_jwt=false`.
Nie można bezpiecznie aktywować ich wyłącznie na podstawie
zielonego CI. Nie skonfigurowano Cron, nie wywołano Caravel.

Starsza funkcja `caravel-sandbox-acceptance` v12 pozostała
w stanie `closed.ts` HTTP410 z `verify_jwt=true`;
`caravel-sandbox-diagnostics` v6 także pozostaje zamknięta.
Wciąż istnieje osobna starsza funkcja
`caravel-sandbox-diagnostic` v8 z kodem diagnostycznym;
nie była modyfikowana.

## GitHub
- Branch `claude/caravel-finish`, draft PR #84, bez scalenia.
- Po przejściu na prywatny katalog SQL i nowych testach Deno
  workflow `Caravel sandbox adapter checks` i
  `Ride24 API Compatibility QA` zakończyły się sukcesem.

## Aktualizacja po kontroli dostępów — 16.11.2026

- `caravel-sandbox-cert-rehearsal` zaktualizowana do **wersji 3**, nadal `verify_jwt=true`; repozytorium PR #84 zawiera bezpieczną akcję administracyjną `POST {"action":"preflight"}`.
- Preflight **nie tworzy rezerwacji, nie kontaktuje się z Caravel i nie wypisuje sekretów**. Po `requireAdmin()` sprawdza wyłącznie występowanie pięciu zmiennych środowiskowych oraz serwerowy dostęp do czterech prywatnych tabel, zwracając wartości logiczne.
- Metadane wdrożenia potwierdziły wersję 3, aktywne JWT i obecność `requireAdmin`. W tabelach `caravel_sbx_webhook_events`, `caravel_sbx_reconcile_jobs`, `caravel_sbx_periodic_scans` i `caravel_sbx_reference_snapshots` nadal 0 rekordów.
- **Rzeczywistego wywołania HTTP nie wykonano:** narzędzia w tej sesji nie mają uwierzytelnionej sesji użytkownika i nie zapewniają żądań POST do Edge. Wymagana jest istniejąca, uprawniona sesja administratora (nie przekazywać JWT przez czat).
- Następna próba: bez JWT 401, z kontem nieadministracyjnym 403, z administratorem POST `{"action":"preflight"}` 200 oraz odpowiedź logiczna `secrets_configured` i `private_tables_accessible`. Nie wysyłać `{"action":"rehearse"}` do zakończenia gotowości.
- **Nie** wdrożono `caravel-sandbox-webhook-receiver`, `caravel-sandbox-reconcile-worker` ani `caravel-sandbox-periodic-poll`; nie ustawiono sekretów tymi narzędziami, nie uruchomiono `/_certification/start`.
- Wymagane do konfiguracji: Caravel-supplied `CARAVEL_SANDBOX_WEBHOOK_SECRET` (nie wolno go wymyślić) i oddzielne wysokolosowe `CARAVEL_SANDBOX_RECONCILE_SECRET`, `CARAVEL_SANDBOX_PERIODIC_SECRET` (zachować tylko w Edge Secrets). Nie zmieniać już działającego `CARAVEL_SANDBOX_API_KEY`.

## Następne niezbędne kroki
1. W sesji administratora sprawdzić rzeczywiste HTTP 401/403
   dla `caravel-sandbox-cert-rehearsal`; wykonać sekwencyjną
   próbę `baseline` + `shrunk-reference-refresh:1/:2`
   tylko gdy Caravel udostępni właściwy tryb scenariuszy.
2. Skonfigurować oddzielne sekrety webhooka i workerów
   **bez dodawania ich do kodu/GitHub**. Przed publicznym wdrożeniem
   potwierdzić, że nieautoryzowany POST nigdy nie daje 2xx.
3. Wdrożyć izolowany odbiornik i worker/poller, a następnie
   wykonać faktyczną dostawę webhooka i odczyt w sandboxie.
4. Potwierdzić wymagania certyfikacji mierzone ruchem (kody
   błędów, stronicowanie, retries, quote-expiry, expected_price, HMAC),
   nie opierać się na mockach.
5. Dopiero po próbie generalnej podjąć osobną decyzję o
   24-godzinnym `/_certification/start` i ewentualnym
   `Request production`. Produkcyjne Premium w dalszym ciągu
   musi spełniać zero depozytu i zero udziałów własnych.

**Żadne oferty Caravel nie zostały uruchomione dla klientów.**
