# [DRAFT] Caravel Channel API v1.67.0 — normalizacja do standardu Ride24 i zgodność ze specyfikacją

**Gałąź:** `claude/caravel-finish` → **baza:** `feature/caravel-sandbox-integration` (PR #81, `f434c9f`)
**Status:** draft — nie mergować. Integracja nie jest podłączona do produkcyjnego dispatchu; partner `Caravel Rent a Car` pozostaje `api_enabled=false`.

## Cel
Dokończenie izolowanej warstwy Caravel: odczyt dokumentowanych obiektów API Caravel, normalizacja ofert do standardu lokalnych partnerów Ride24 (te same karty, ceny, opłata Ride24, kwota dla partnera, lokalizacje, dodatki, wspólny proces rezerwacji) oraz dopasowanie do oficjalnego OpenAPI v1.67.0 — bez zmian we wspólnym kodzie.

## Zakres zmian (tylko pliki Caravel, testy, dokumentacja, CI Caravel)
| Plik | Zmiana |
| --- | --- |
| `supabase/functions/_shared/caravel-normalize.ts` (nowy) | Odczyt `Location`, `Vehicle`/`AvailabilityItem`, `policies.mileage`, `QuoteResponseData`, `Extra`; normalizacja do `ride24_standard_v1` przyjmowanego bez zmian przez wspólne `normalizeLocations()` / `normalizeGroups()`; wiersze `partner_locations` / `car_classes` w kształcie obecnej synchronizacji API; katalog dodatków w kształcie `partner_extras` (nieaktywny); przeliczanie jednostek groszowych ISO 4217. |
| `supabase/functions/_shared/caravel-booking.ts` (nowy) | Wspólny `ProviderBookingInput` → `CreateQuotedBookingRequest`; kontrola kwoty dla partnera względem wyceny; zgodność zestawu kierowców z wyceną; statusy wg §8.1; odczyt opłaty za anulowanie. |
| `supabase/functions/_shared/caravel-sandbox-adapter.ts` | `/v1/reference/vehicles`; `error.request_id`; `Idempotency-Key` jako UUID; `driver_age` / `currency` w dostępności (bez nieistniejącego `plan`); typowane żądania wyceny i rezerwacji; cache `capabilities`; odczyt statusu rezerwacji. |
| `supabase/functions/_shared/caravel-quote-verification.ts` | Kategorie opłat = typy opłat ze specyfikacji (`out_of_hours`, `one_way`, …). |
| `tests/caravel-normalize.test.mjs`, `tests/caravel-booking.test.mjs` (nowe); `tests/caravel-sandbox-adapter.test.mjs`, `tests/caravel-quote-verification.test.mjs` | Fikcyjne obiekty w kształcie schematów OpenAPI; wynik przechodzi przez **prawdziwe** `normalizeGroups()`, `normalizeLocations()` i `apiPriceTotals()`. |
| `tests/local-ts-esm-loader.mjs` (nowy) | Hook tylko dla testów lokalnych: wymusza ESM dla `supabase/functions/**/*.ts`, gdy nad repozytorium leży `package.json` z `"type": "commonjs"`. Nie zmienia źródeł ani CI. |
| `.github/workflows/caravel-sandbox-tests.yml` | Nowe testy w CI, `--allowImportingTsExtensions`, ścieżki zależnych modułów wspólnych. |
| `docs/integrations/caravel-isolation-gate.md` | Zakres etapu A, komenda testów lokalnych. |
| `docs/integrations/caravel-openapi-gap-analysis.md` (nowy) | Inwentarz źródeł, porównanie kodu z OpenAPI, status poprawek, blokady etapu B, wiadomość do Caravel. |
| `docs/integrations/caravel-shared-changes-proposal.md` (nowy) | Propozycja zmian we wspólnym kodzie dla ChatGPT Work (niewdrożona). |

**Nie zmieniono:** AVIA/Renteon, Stripe/płatności, `search-api`, `provider-adapters.ts`, `partner-api.ts`, `api-partner-admin`, migracji, WWW (`*.html`, `assets/`) ani APK. Jedyna zmiana pliku spoza Caravel w całym PR (`tests/backend-hardening/test-api-compatibility.mjs`, mock modułu Renteon) pochodzi z wcześniejszego commita `1210f94` PR #81.

## Normalizacja = istniejące mechanizmy Ride24
- Oferta: suma `grand_total` z wyceny Caravel jako `price_is_total` / `public_price_total` → wspólne `apiPriceTotals()` liczy kwotę dla partnera i opłatę Ride24 jak dla innych partnerów (test: 150 EUR, rabat 10 %, marża 20 % → partner 135, klient 162, opłata Ride24 27).
- Karty: klasa z ACRISS, `display_name`, zdjęcie https, skrzynia, paliwo, miejsca, bagaże (`large_bags + small_bags`), km/doba lub bez limitu, depozyt 0, pełne ubezpieczenie tylko dla Premium z zerowym udziałem własnym i depozytem.
- Lokalizacje: `partner_locations` bez lokalnych opłat (opłaty są w wycenie Caravel; wspólny strażnik `assertApiPricingCompatible` wymaga tego dla partnerów API).
- Rezerwacja: wspólny `ProviderBookingInput` + `api_quotes.provider_quote_data`.
- Fail-closed: pola niepodane przez API nie dostają wartości domyślnych.

## Wyniki testów (lokalnie, Windows, Node 24.13.1)
```bash
node --import ./tests/local-ts-esm-loader.mjs --experimental-strip-types --test tests/caravel-sandbox-adapter.test.mjs tests/caravel-verified-rules.test.mjs tests/caravel-quote-verification.test.mjs tests/caravel-normalize.test.mjs tests/caravel-booking.test.mjs
```
- Testy Caravel: **63/63**.
- `tsc --noEmit` (komenda z CI, TypeScript 5.9.3) na 5 plikach Caravel: **bez błędów**.
- Pakiet API Compatibility QA (13 plików, `tests/backend-hardening`): **109/112**. 3 niepowodzenia (`test-booking-extras-ui.mjs`, 2× voucher) występują identycznie na czystym `origin/main` w tym środowisku: `bookingExtras.js` wczytywany jako CommonJS przez `package.json` w folderze domowym oraz brak linuksowej czcionki DejaVu. Gałąź nie zmienia tych plików.
- **Niezweryfikowane:** przebieg w GitHub Actions (Node 22) — nic nie zostało wypchnięte.

## Bezpieczeństwo i dane
- Brak sekretów, kluczy, tokenów i danych klientów w diffie; testy używają fikcyjnych danych (`fixture`, `sandbox@example.test`, `+48 000 000 000`, wygenerowane UUID).
- Żadnych zapytań z kluczem, wycen ani rezerwacji; odczytano wyłącznie publiczne `GET /health`, `GET /v1/capabilities`, `GET /v1/openapi.json` i dokumentację partnera.
- Brak zapisów do Supabase.

## Pozostałe blokady (etap B)
1. Klucz sandbox Ride24 (wiadomość do Caravel wysłana) — potwierdzenie na prawdziwych odpowiedziach, kodowanie dni w `Location.hours`, dostawcy / waluty / `tax_inclusive`, ewentualna allowlista IP.
2. Warunki handlowe: model płatności, prowizja i rozliczenie, czy Ride24 może doliczyć własną opłatę do `grand_total`.
3. Polityka odznak: „bez karty kredytowej” przy zerowym depozycie (dziś wyłączona).
4. Definicja Premium: `theft_excess` i wyłączenia.
5. Wspólny kod (po stabilizacji AVIA, z Work): dostawca `caravel` w `provider-adapters.ts`, wymuszane odznaki „bez karty / blokady” w `normalizeGroups()` / sync / `search-api`, `min_driver_age` w synchronizacji, moment wyceny, dodatki wyceniane przez dostawcę — szczegóły w `caravel-shared-changes-proposal.md`.
6. Certyfikacja u Caravel przed produkcją.

## Commity
- `28a995c` test(caravel): add test-only ESM loader for local runs
- `db3a7fe` feat(caravel): normalize offers to the Ride24 standard partner contract
- `c86a35f` docs(caravel): shared-code proposal for Work; car_classes min_driver_age
- `7448beb` docs(caravel): OpenAPI v1.67.0 source inventory and gap analysis
- `4e87893` fix(caravel): align adapter and normalizer with OpenAPI v1.67.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
