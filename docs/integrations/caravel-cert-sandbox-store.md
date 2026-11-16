# Caravel — prywatny katalog między fazami certyfikacji

**Wybór infrastruktury:** prywatna tabela PostgreSQL, NIE Supabase Storage.

## Dlaczego zmieniliśmy plan

Podczas audytu 16.11.2026 wykryto istniejącą politykę `storage.objects`,
która dopuszcza `INSERT` użytkowników `authenticated` do bucketów innych
niż `marketing-images` (warunek z alternatywą `bucket_id <> 'marketing-images'`).
Zatem stworzenie nowego bucketu `caravel-sandbox-cert-state` jako
`public=false` **nie zapewniłoby wyłącznego dostępu do zapisu przez service_role**.
Nie tworzymy tego bucketu i nie zmieniamy istniejących polityk Storage.

Zamiast tego przygotowano:
- `public.caravel_sbx_reference_snapshots`, RLS=ON, bez polityk `anon/authenticated`,
  z prawami tabeli tylko dla `service_role`.
- `caravel_sbx_reference_load/save/clear` — funkcje `SECURITY INVOKER`
  z `search_path=''`, wykonanie tylko dla `service_role`.
- `supabase/functions/_shared/caravel-cert-state.mjs` — adapter
  wyłącznie RPC; żadnego `storage.from` ani ścieżek plików.
- SQL: `docs/integrations/caravel-sandbox-reference-db.sql`.

## Przeznaczenie

Tylko katalog Caravel `locations/vehicles/protections/extras` między fazami
`baseline`, `shrunk-reference-refresh:1` oraz `:2`. Klucz złożony
`(session_id uuid, supplier_id text)` oddziela przebiegi. Nie przechowuje
kluczy API, danych klienta, płatności ani rezerwacji.

Bezpieczniki: walidacja UUID i dostawcy, whitelist czterech katalogów,
maksymalnie 300 elementów w każdej grupie i 1 MiB JSON na rekord.
Stanu nie odczytują publiczne konta.

## Warunki wdrożenia

1. SQL najpierw przetestować w transakcji `BEGIN ... ROLLBACK`, wraz z wywołaniami
   `service_role`, blokadą `anon/authenticated` i zapisem/usuwaniem JSON.
2. Zmianę utrwalić wyłącznie po zaliczeniu testu i przeglądu.
3. `caravel-sandbox-cert-rehearsal` deploy z `verify_jwt=true`,
   obowiązkowym `requireAdmin`, krótkim terminem wygaśnięcia i importami
   z przypiętym SHA. Nie jest to kontroler oficjalnej certyfikacji.
4. Po zakończeniu usunąć testowe sesje katalogu; 410 w Edge nie czyści PostgreSQL.
5. Stara `caravel-sandbox-acceptance` musi pozostać zamknięta (410).

## Nie jest zaliczone

Oficjalna certyfikacja, rzeczywista dostawa webhooków, `hmac-self-test`,
`price_changed` direct-booking i wymagania kodów błędów w ruchu
nadal wymagają osobnych testów. Nie uruchamiaj `/_certification/start`
automatycznie ani nie włączaj ofert dla klientów.
