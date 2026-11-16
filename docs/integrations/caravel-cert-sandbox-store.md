# Caravel — izolowany magazyn dla prób generalnych certyfikacji

**NIE wykonano SQL ani wdrożenia.** Ten plik jest instrukcją przygotowania *prywatnego* bucketu w Supabase projektu Ride24. Nie dotyka tabel rezerwacji, partnerów, Stripe, AVIA ani WWW.

## Jednorazowe przygotowanie — dopiero po zatwierdzeniu wdrożenia

Poniższa instrukcja SQL jest przeznaczona do uruchomienia przez administratora (Supabase SQL Editor / migracja) po odrębnej zgodzie:

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'caravel-sandbox-cert-state',
  'caravel-sandbox-cert-state',
  false,
  1048576,
  array['application/json']::text[]
)
on conflict (id) do nothing;
```

Następnie należy **sprawdzić**, czy istniejący bucket o tej nazwie jest na pewno prywatny i ma limit 1 MiB. Nie wolno dodawać żadnej publicznej polityki Storage ani udostępniać plików klientom `anon`/`authenticated`.

## Zasady izolacji

- Testowy magazyn: prywatny bucket `caravel-sandbox-cert-state`; tylko `service_role`, wywoływany z funkcji zabezpieczonej jednocześnie `verify_jwt=true` oraz `requireAdmin()`.
- Klucz obiektu: `<certification_session_uuid>/<sandbox_supplier_id>.json`, walidowany przed zapisem i odczytem.
- W środku **wyłącznie** katalogi operatora (locations / vehicles / protections / extras). Żadnych kluczy API, danych klienta, historii płatności, voucherów ani identyfikatorów osób.
- Mechanizm `mergeCaravelReference()` nie kasuje identyfikatorów, których nie ma w kolejnym katalogu; do certyfikacji wymagany jest *ten sam* session UUID w obu fazach `shrunk-reference-refresh:1/2`.
- Warunek do usunięcia po zakończeniu próby: skasować pliki testowej sesji z bucketu. Zwykłe wygaśnięcie funkcji Edge nie czyści Storage.
- **Nie wdrażać** `caravel-sandbox-cert-rehearsal` ani nie uruchamiać `/_certification/start` bez odrębnego upoważnienia. Obecnie aktywne `caravel-sandbox-acceptance` powinno pozostać zastąpione wersją zamykającą 410.

## Rozdzielenie procesu

`caravel-sandbox-cert-rehearsal` służy tylko do sprawdzania faz, z fikcyjnymi danymi w sandboxie. To nie jest kontroler pełnej certyfikacji. Nie wywołuje `/_certification/start`, `/advance`, `/hmac-self-test` ani żadnego endpointu produkcyjnego. Rzeczywisty 24-godzinny run oraz jego dashboard wymagają osobnej decyzji i weryfikacji aktualnego CERTIFICATION.md.

## Nadal niezweryfikowane

Pozostają do przygotowania i sprawdzenia (nie wolno ich oznaczać jako zaliczone): pomiary z rzeczywistego ruchu 401/403/404/409/422/429, paginacja i niepoprawne page tokeny, wygasła wycena, strażnik `expected_price` przy direct booking, bezpieczne ponawianie po 429/503 z `Retry-After`, HMAC self-test i rzeczywisty odbiornik webhooków. Nie wolno celowo przeciążać API, żeby wymusić 429.

Wszystkie scenariusze specjalne dodane do adaptera wymagają próby na **prawdziwym** sandboxie z aktualną fazą (CI sprawdza wyłącznie mocki).
