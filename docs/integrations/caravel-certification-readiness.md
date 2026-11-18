# Caravel Channel API v1.67.0 — certification readiness (Ride24)

## UPDATE 17.11.2026 (Caravel response; supersedes earlier assumptions)

See `docs/integrations/caravel-vendor-clarification-2026-11-17.md` for complete supplier instructions and evidence.

- **Sandbox webhook delivery to a public URL is NOT a certification prerequisite.**
  The self-serve account records signed events in its inspector. Delivery
  before production is optional, enabled by Caravel after URL ownership challenge.
  An unconfigured LIVE receiver is therefore not by itself a reason to
  delay sandbox HMAC certification.
- **HMAC self-test** uses `fixtures/webhook-hmac-self-test.json`,
  its OWN fixture secret and t as "now"; negative tamper case required.
  Submit `{"signature_hex":"...","tampered_rejected":true}` to
  `POST /_certification/hmac-self-test` with sandbox API key. This is
  an independent milestone, NOT `/_certification/start`.
  Local helper and mock submission tests implemented. No live submission
  has occurred yet.
- **Account webhook signing secret** is created only once, with first
  `POST /v1/webhooks/test` (write:webhooks) or newly minted by
  `POST /v1/webhooks/secret/rotate`, and shown once. Store securely;
  do not invoke unprepared. Verification of multiple `v1=` and
  new/old secret overlap is implemented.
- **No L2A filter**: Caravel itself excludes L2A from our production
  account. `vehicle_id` is opaque; codes/names cannot identify it.
  Previous guessed L2A filter was REMOVED from isolated code.
- **Terms are API-derived**: list `GET /v1/reference/terms` metadata
  (not text); fetch document body at `/v1/reference/terms/{document_id}`,
  format `clauses/v1`. Current EN document is v4 dated 17 Nov 2026,
  with immutable document_id and content_hash. Server must show actual
  authoritative text before Stripe and persist document_id per booking.
  Current PDFs from outside API must not be treated as legal authority.
  Full canonical SHA-256 requires rules from Caravel pack §3.9.
  Nullable DB migration is PROPOSED, NOT APPLIED.
- **Live test attempted 17 Nov via PR label**. GitHub Actions did not
  have the `CARAVEL_SANDBOX_API_KEY` secret: job skipped the API calls
  and failed. This does not indicate a Caravel API error.
- **Business blocker remains**: all Premium groups exclude glass,
  tyres/wheels and undercarriage; the Ride24 full coverage guard
  correctly refuses them. Separate owner decision or enhanced Caravel
  package required before production. `api_enabled=false`.

**Accurate status:** isolated code/tests green; HMAC cert endpoint NOT
submitted; official 24h certification NOT started; Caravel production
access NOT requested; no Caravel offers active.

---



## AKTUALNY stan: 17 listopada 2026 (zaktualizowane po emailu Caravel)

**Werdykt: NIE URUCHAMIAĆ PRODUKCJI. Oficjalna 24-godzinna
certyfikacja NIE została zakończona ani uruchomiona.**
Poniżej aktualny stan zastępujący historyczne TODO z 13–16 listopada.

### Sprawdzone i wykonane
- Repozytorium `expol1/ride24`, gałąź `claude/caravel-finish`,
  PR #84 nadal **draft / niescalony**. Caravel-only moduły i testy
  nie są podłączone do produkcyjnego `provider-adapters.ts`.
- Sandbox: dwaj dostawcy EUR/GBP, manualne skany okresowe zakończone,
  6 obserwacji statusów i żadnego webhooka na żywo; Cron Caravel 0.
- Deployed isolated `caravel-sandbox-periodic-poll` v2 i
  `caravel-sandbox-reconcile-worker` v1 (chronione sekretem),
  `caravel-sandbox-cert-rehearsal` v7 (JWT administratora),
  `caravel-sandbox-acceptance` v14 i `caravel-sandbox-diagnostics` v8
  zamknięte HTTP 410. **Odbiornik webhooków HMAC nadal NIE jest
  wdrożony**. Funkcje testowe mają termin wyłączenia
  **20.11.2026 godz. 20:00 UTC**.
- `GET /v1/reference/terms` ma teraz tylko przygotowaną,
  dostawca-scoped metodę `referenceTerms()` w izolowanym adapterze;
  jej **prawdziwe wywołanie i schemat odpowiedzi pozostają
  niezweryfikowane**.
- Ten sam `rules.pdf` znajduje się w Supabase Storage i został
  zweryfikowany na podstawie rozmiaru i zgodnego MD5/ETag.
  `terms.pdf` jest w Storage, lecz zawartości nie odczytano.
  Obecny interfejs Ride24 pokazuje dwa linki PDF klientowi przed
  zatwierdzeniem rezerwacji — bez potrzeby tworzenia nowego systemu.
- Filtr L2A przygotowany przy katalogu, ofercie, ochronie i
  szkicu rezerwacji; dokładne pole identyfikatora kodu `L2A`
  musi zostać potwierdzone na prawdziwej odpowiedzi API.
- Przygotowano tylko dla Caravel normalizację idempotencyjnego
  `ride24:<booking UUID>` do UUID, z osobnym prefiksem `external_ref`
  w sandbox i produkcji. Produkcyjny szkic rezerwacji wymaga
  przejścia bramki: zakończona certyfikacja, warunki pokazane przed
  płatnością, zgodny zakres Premium, zweryfikowany staż i IDP.
  Nie jest jeszcze wpięty do publicznego procesu rezerwacji.
- Wyszukiwarka Caravel odrzuca dostawcę, który nie oświadcza
  w `Supplier.payment_models` obsługi `pay_on_arrival`.
  Podział `quote.totals.pay_now/pay_at_pickup` nie zastępuje
  rzeczywistego modelu płatności.

### Przeszkody, które naprawdę blokują ukończenie
1. **HMAC**: nieznany rzeczywisty sekret sandboxowy, brak prawdziwego
   podpisanego zdarzenia i testu `/_certification/hmac-self-test`.
   Odbiornika NIE wdrażać, dopóki sekret nie został skonfigurowany
   i zweryfikowany. NIGDY nie ujawniać sekretu w repo, w czacie
   ani w dokumentacji.
2. **Certyfikacja**: aktualne wymagania 10 etapów, w tym
   `opaque-id-tolerance` z `POST /v1/quote` dla **domyślnego planu
   bez jawnego `plan`**, nie tylko dla Premium. Nie wystartowano
   `/_certification/start`; pozytywne testy mock/CI
   nie są równoważne raportowi partnera. Wymaga osobnego
   nadzorowanego okna i pełnego zestawu dowodów.
3. **Polityka ubezpieczenia Ride24**: Caravel potwierdził
   17.11 wyłączenie **szyb, kół/opon i podwozia** we wszystkich
   pakietach, mimo zerowego udziału własnego/depozytu w Premium.
   Administracyjna opłata **100 EUR** za wynajem ze szkodą/kradzieżą
   także w Premium; zapis w PDF §6.1. Bieżące
   `REQUIRED_PREMIUM_COVERS` celowo odrzuca takie oferty.
   Należy uzyskać zgodny produkt od Caravel albo osobną, świadomą
   zgodę właściciela Ride24 na zmianę standardu wraz z prawidłowym
   komunikatem dla klienta — bez niej żadnych ofert.
4. **Prawnie wiążące terms**: `GET /v1/reference/terms` ma mieć
   pierwszeństwo przed opisem kodów ochrony. Zawartości endpointu
   i pliku `terms.pdf` nie porównano. Sekcja numerów w e-mailu
   różni się od przesłanego `rules.pdf`; sprawdzić, czy nie są
   to odmienne wersje. Wyjaśnić §5.1 o obciążeniu karty przy odbiorze
   wobec deklarowanej płatności gotówką bez karty kredytowej.
5. **Dane/licencja kierowcy**: tabela `public.drivers`
   przechowuje wiek i kontakt, bez pierwszej daty uzyskania prawa
   jazdy i kraju wydania. Izolowany walidator już jest,
   brak bezpiecznego wpięcia do formularza, zapisu zgody
   i backendu. Nie modyfikować danych innych dostawców.
6. **Wpięcie produkcyjne**: po uzyskaniu wyników certyfikacji i
   pozytywnej decyzji o ochronie — wprowadzić `caravel` do
   `provider-adapters.ts`, wyszukiwarki, synchronizacji,
   ponownej wyceny po Stripe, tworzenia/anulowania rezerwacji,
   webhooków, voucherów i zwrotów. Przedtem dostawca nadal
   `partners.api_enabled=false` i `api_provider=custom`.
7. **Dostęp produkcyjny**: dopiero po pozytywnym raporcie
   Caravel przez `Request production` w panelu,
   następnie potwierdzić klucze, identyfikatory supplier,
   walutę, model płatności i pełną politykę Premium.

### Granice bezpieczeństwa
**Bez zmiany AVIA, Stripe, Android APK, regulaminów innych partnerów,
danych użytkowników, cron i produkcyjnych tabel. Bez aktywacji API
Caravel, bez scalania PR #84 i bez generowania próbnych prawdziwych
rezerwacji.** Dalsze przygotowania mogą dotyczyć tylko odizolowanych
modułów Caravel i testów.

---



Source: partner pack `https://sandbox-api.caravelway.com/docs/packs/caravel/` (CERTIFICATION, Webhook Receiver Guide, CHANNEL-API), read 14 Nov 2026.
**The official 24-hour run (`POST /_certification/start`) has NOT been started.** Start it only with Ride24's explicit authorization for that irreversible 24-hour certification window.

## Silent-webhook periodic catch-up — 16 Nov 2026
- Independent **UNDEPLOYED** sandbox poller and SQL draft now check `GET /v1/bookings?updated_since` even without any webhook; it obtains suppliers from Caravel, refetches booking details, handles one page/supplier per tick and stores an atomic per-supplier watermark ONLY after finishing the entire scan.
- This is an **audit-only** state table. It flags provider revisions not yet seen in sandbox webhook bookkeeping without mutating Ride24 reservations. First scan = last 24 hours, later scans overlap the prior watermark by five minutes; longer provider delays or outages require manual backfill.
- New mock suite `tests/caravel-sandbox-periodic.test.mjs` exercises EUR/GBP-like suppliers, multi-page cursors, fail/retry and stale revision protection. **No SQL applied, no Supabase function deployed and no cron configured.**
- See `caravel-sandbox-periodic-reconcile.md`. Live certification measurements remain pending.

## Webhook gap-recovery preparation — 16 Nov 2026
- Added sandbox-only `caravel-sandbox-reconcile.mjs`, RPC methods, and `caravel-sandbox-reconcile-worker` for one-page-at-a-time booking recovery after sequence gaps, using `GET /v1/bookings?updated_since` and authoritative `GET /v1/bookings/{booking_id}`.
- Proposed extra SQL in `caravel-sandbox-webhook-reconcile.sql` adds an after-finalize sequence-gap queue trigger, leased jobs and atomic page checkpoints. **Both SQL files are unexecuted; neither the worker nor receiver has been deployed or scheduled.**
- New mock tests `tests/caravel-sandbox-reconcile.test.mjs` prove cursor continuation, no partial checkpoint after failure, idempotent replay and monotonic revisions. They do not prove real API recovery.
- Only observed sequence gaps are queued. Silent loss with no later webhook still requires periodic catch-up; cron, monitoring and live delivery remain unavailable. Full details in `caravel-sandbox-webhook-reconcile.md`.

## Durable sandbox webhook receiver preparation — 16 Nov 2026
- New **UNDEPLOYED** `caravel-sandbox-webhook-receiver` and `caravel-webhook-delivery.mjs` validate the raw-body HMAC, reject invalid signed events, atomically dedupe via a restricted DB repository, then re-fetch the booking from Caravel sandbox and store only the latest revision/status in separate sandbox tables.
- SQL proposal is documented in `caravel-sandbox-webhook-state.sql` and **has NOT been executed**. Without the RPC functions, the receiver fails closed (503); `verify_jwt=false` is only safe when HMAC is configured and verified.
- `tests/caravel-webhook-delivery.test.mjs` covers duplicate events, stale revisions, sequence gap reporting, invalid signatures and supplier IDs, refetch failure/redelivery, and RPC invocation. These are mocked tests, not live Caravel delivery or completed certification.
- A sequence gap is flagged but **automatic reconciliation is still pending**. See `caravel-sandbox-webhook-receiver.md` for the explicit deployment/security checklist.

## Sandbox webhook receipt preparation — 16 Nov 2026
- `caravel-webhook-probe.ts` verifies the signature (raw body, exact method/path, HMAC and timestamp) and validates the event envelope; its test fixtures cover tampering, changed path, stale timestamps and malformed bodies.
- `caravel-sandbox-webhook-probe/index.ts` is an **UNDEPLOYED** sandbox-only Edge entrypoint, designed for `verify_jwt=false` with mandatory HMAC authentication and a strict 32 KiB request-body limit. Returns only accepted/rejected status; logs no payload, stores no personal data and never updates Ride24 reservations.
- This is only a signature/connectivity probe. It **does not** implement durable `event_id` deduplication, per-booking revision persistence or real production webhook dispatch. The hosted Caravel webhook delivery and HMAC self-test have NOT been run. Additional security review and separate authorization are required before deployment.

## Reliability and pagination readiness — 16 Nov 2026 (isolated branch only)
- `caravel-sandbox-adapter.ts` now retries **only** GET or POST with the same UUID idempotency key on HTTP 429/503 and transient network failures. Maximum three attempts, honors `Retry-After` seconds/HTTP-date, and stops rather than waiting indefinitely when the advised delay exceeds the configured bound. POST payload and UUID are identical on every attempt. 422 is never retried.
- Reference endpoints follow every opaque `meta.next_page` token with supplier scope preserved; repeated or malformed tokens, malformed page arrays and excessive page chains fail closed. `listAllBookings()` now walks all pages of the status reconciliation list while retaining `updated_since`.
- New mock-only tests in `tests/caravel-reliability.test.mjs` cover 429, 503, unchanged idempotency keys, long `Retry-After`, 422, opaque token characters, reference paging and booking paging. The tests are run by the PR's Caravel CI workflow.
- **Not yet confirmed on live Caravel certification:** actual pagination token responses, 429/backoff trace and registry metrics. No deliberate rate-limit bombardment has been attempted.
- **Still missing before certification:** evidence for 401/403/404 families, rejected expired quote, direct-booking expected-price guard, webhook live delivery and HMAC self-test. The actual 24-hour certification has not been started.

## Negative-case test coverage update (16 Nov 2026)
- Added `tests/caravel-certification-edge.test.mjs`, included in GitHub Actions. This suite mocks upstream 401/403/404/409/422 envelopes and verifies error-code/status preservation and no retry; unknown error codes stay unknown instead of being guessed.
- A mismatched opaque `page_token` gets a mocked `422 malformed_page_token` response without retry or supplier-scope changes. This is **not** a live cross-endpoint pagination test.
- The Caravel booking draft rejects an expired quote including the exact expiry instant **before** any provider write. This is local application-side protection, **not** the Caravel upstream `quote.expired_rejected` metric.
- Existing `caravel-reliability.test.mjs` covers HTTP 429/503 backoff, bounded `Retry-After`, same idempotency key on retried POST, and all-page reads. Live measurement still required; never force a 429 by excessive traffic.
- Do not implement the `expected_price` direct-booking endpoint or claim its guard until the exact Caravel OpenAPI request schema is accessible and verified. The quoted-create flow remains Ride24's default.

## Readiness update after source-document review (16 Nov 2026)
- Current specification checked against the partner's bundled v1.67.0 documentation (HTML export). The official run has not started.
- Live tests on 16 Nov: EUR and GBP **25/25** steps each, `failed: false`. The conflict on an **active** booking returned 409 `revision_conflict`; the booking stayed confirmed at revision 1, then cancelled correctly at revision 2, fee 0, and the function was returned to HTTP 410.
- New isolated rehearsal code supports the six gating scenarios as described, plus non-gating phases. Mock tests cover unknown location types, two freshly catalogued vehicle IDs, a GET after cancellation and the reference shrink/return sequence.
- **Important correction:** in `shrunk-reference-refresh:1` the vehicle is removed from refreshed catalogue and search results, yet must be quoted using a **baseline-persisted** record; in `:2` it returns and must remain the same record under the original ID. This is now how the code and tests behave.
- A private Supabase Storage reference-state adapter and an independent admin-only rehearsal endpoint were added to PR #84. **Neither the bucket nor the endpoint has been deployed**, and no production tables were touched. See `caravel-cert-sandbox-store.md`.
- Code-only CI success does not prove the 24-hour hosted run will pass. The true gating changes are injected only during a real active run; some rehearsals need saved mutated responses.

## Important remaining evidence and setup before certification
- Private reference bucket and rehearsal endpoint require separate explicit activation and JWT/admin checks. The old acceptance function must remain closed.
- Verify the full ten-phase flow against an actual injected run before pressing `/_certification/start` (no skipping or inventing evidence). A phase without observed follow-up traffic is inconclusive.
- Additional registry checks still pending: status families, pagination and token binding, expired quote, direct-price guard, 429 and Retry-After with a stable idempotency key, and live webhook delivery. HMAC fixture verification was local only; `/_certification/hmac-self-test` was not invoked.
- The sandbox-only medium served plan in `opaque-id-tolerance` must be QUOTED, never booked or published to Ride24 customers.

## Current acceptance evidence — 16 Nov 2026
- Isolated admin-only Supabase function was deployed for live tests, then replaced by `closed.ts` (HTTP 410 with valid admin JWT; 401 without auth); production integrations remained untouched.
- Real sandbox EUR (`acct_eaa0…`) and GBP (`acct_a714…`): **23/23 steps OK for each supplier**, `failed: false`; Premium `INS_PREMIUM` quote + booking + idempotency replay + status read + cancel + idempotent second cancel. No active test bookings remain.
- Quote/booking amounts reconciled: EUR 132.00 / GBP 114.00; `booking_id`, `quote_id`, currency, confirmed revision 1, cancelled revision 2 all verified.
- Sandbox Premium intentionally has nonzero deposit/excess and absent optional coverage fields. Caravel confirmed these are fictional fixtures shared by all partners. Ride24's production publishability guard correctly refuses them. Production must independently confirm Premium plan, included protection, EUR and VAT inclusive, deposit/excess/theft excess zero, and populated covers/excludes.
- `Booking.payment` is optional when payment model was defaulted; Ride24 sends `pay_on_arrival` explicitly and rejects contradictory present payment details.
- Active-booking **revision_conflict 409** probe was added to the isolated acceptance harness on 16 Nov and mocked; a live run of that new step remains pending.
- Local test suite and CI were green at `64770501e` (108/108 local Caravel tests). Never equate mocked tests with the official certification outcome.

Older evidence below is retained as dated history; references to pending live booking tests or pending Premium sandbox fixtures describe the state on **14 Nov**, not the current state.

## Prerequisites (CERTIFICATION.md "What you need first")
| Prerequisite | Ride24 status |
| --- | --- |
| Full sandbox flow capabilities → reference sync → availability → quote → book → cancel | Implemented in `tests/caravel-live-sandbox.mjs` for **every** supplier the key holds. Verified only on a local mock so far; real run pending (see blockers). |
| Key on every request, `GET /v1/capabilities` included | Yes — `CaravelClient.request()` always sends `X-API-Key`. |
| Base URL is configuration | Yes — `CaravelClient({environment: "sandbox" \| "production"})`; production needs `allowProduction`, production bookings need `allowProductionBookingWrites`. |
| Reference sync on demand; quote a specific vehicle from the synced catalogue | Yes — reference merge store (`caravel-reference-sync.ts`) and the "served plan, ids from reference sync" quote step. |
| Two suppliers walked (search, quote, booking each) — gate `suppliers.every_supplier_exercised` | Harness loops over `GET /v1/suppliers`; the live account holds 2 suppliers (EUR + GBP, confirmed by the 13 Nov diagnostics). |
| Webhook self-test | HMAC verifier passes Caravel's published fixture (`tests/caravel-stage1.test.mjs`). No receiver is deployed; the portal's sandbox inspector captures events. |

## Ten phases (six gating scenarios)
| Phase | Gates | What Ride24's client does |
| --- | --- | --- |
| baseline | – | Full flow incl. booking + cancel with invented data. |
| unknown-enum-value | **yes** | Unknown values never throw: location `type` outside the map is kept in the merge store; it is only not published (`LOCATION_TYPE_UNVERIFIED`). Quoting continues. |
| unknown-error-code | **yes** | `CaravelError` carries any `code`; unknown codes map to action `stop` (generic degrade). The harness marks the first failed locations read as DEGRADED and reads again on the next sync (a 422 is not retried in place). |
| unknown-response-field | **yes** | Readers take documented fields only; request bodies are built field by field (quote, booking, cancel) — nothing from a response is copied back. |
| unknown-feature-code | **yes** | `capabilities` features are not interpreted beyond `environment` / `api_version`. |
| opaque-id-tolerance | **yes** | Ids are stored as served, never parsed; the harness re-syncs and quotes the served plan (no `plan` named) with a `protection_id` from the fresh `GET /v1/reference/protections`. A renamed vehicle is the same record. |
| shrunk-reference-refresh:1 / :2 | **yes** (one scenario, both stages) | `mergeCaravelReference()` never deletes: a missing record keeps its id and `missing_since`; when it returns it is the same record. |
| deprecation-notice | no | Routes are kept; no behaviour depends on Deprecation/Sunset headers. |
| version-format | no | Ride24 never sends `X-API-Version`, and does not parse `api_version` as major.minor.patch. |

## Evidence status
- **Real API, 14 Nov 2026 (admin-only `caravel-sandbox-acceptance` v1, code pinned to commit f30c9ce), both suppliers:**
  - EUR `acct_eaa0…` (Europe/Athens, 2 desks, 4 vehicles) and GBP `acct_a714…` (Europe/London, 3 desks, 2 vehicles): capabilities, whoami, suppliers, constants, reference locations / policies / vehicles / protections / extras / fees, served-plan quote from reference ids, day + night availability, unknown-vehicle refusal (422 `validation_error`, `vehicle_id:unknown_vehicle`), Premium-plan quote, idempotent quote replay (same `quote_id`), key reuse with a different body (**422** `idempotency_key_reused`, not 409) — all as expected, `failed: false`.
  - Ride24 normalization on live data: every desk and vehicle normalized; quotes reconcile line items to `grand_total` (EUR 132.00 / GBP 114.00 for 3 days, tax inclusive); out-of-hours fee priced by Caravel at night (EUR 30.00 / GBP 18.00) and the desk-hours check flags the same ends.
  - **Premium blocker:** every `premium` row fails the Ride24 policy — deposit EUR 300 / GBP 250, excess above zero, `theft_excess`, `product_type` and `covers` not stated. With `booking: true` the function therefore booked **nothing** at either supplier (by design).
  - Extras: EUR "Child seat" (5.00/day) and "Additional driver" (0/day), GBP "Child seat" (4.00/day) and "Winter kit" (0/day) — all category `other`, so not mapped to Ride24 codes.
- **Real API (13 Nov 2026, admin-only read-only diagnostics function):** capabilities, whoami, suppliers (2), reference locations / policies / vehicles / protections / extras / fees, availability day + night — all 2xx for the first supplier.
- **Not yet observed on the real API:** quote, booking, replay, 409s, cancel, second supplier walk, served-plan quote. These need a server-side run with the key (blocker 1).
- **Simulated only (local mocks / fixtures):** everything in `tests/caravel-*.test.mjs`; the full two-supplier harness on `scripts/mock-caravel-two-suppliers.mjs` (scratchpad, not committed).

## Stage 1b (14 Nov 2026) — ready for Caravel's answer
- **protection_options:** a Premium row is checked with its included package and every bookable `protection_options` package (`caravelProtectionCandidates`, `selectCaravelPremiumProtection`). Only a package that passes the Premium policy on its own data is quoted, and it is published only when the final quote confirms it (zero quote deposit, the protection line priced in the quote, totals reconciled). The Premium-only rule is unchanged.
- **Diagnostics:** every Premium row reports, per package, exact `excess` / `deposit` / `theft_excess` minor units, `product_type`, `covers` / `excludes`, `missing_fields` and the rejection codes (`describeCaravelProtection`). No personal data.
- **Extras mapping:** `CARAVEL_CONFIRMED_EXTRAS_MAPPING` (empty) takes entries keyed `<supplier_id>:<extra_id>` / `:code:` / `:supplier_code:` only after Caravel confirms them; category `other` is never mapped by name.
- **Rental bounds:** billed `rental_days` must sit inside the operator's `min_rental_days` / `max_rental_days`; availability reports `unsellable_window` / `unsellable_movement` / `unsellable_ends`.

## Remaining gates before the official 24-hour run
1. Confirm live active-booking `revision_conflict` behavior on both sandbox suppliers using a wrong positive `expected_revision` **before** the real cancellation; verify the booking remains confirmed, then cancel it and shut the test function (401/410).
2. Recheck the official `CERTIFICATION.md` prerequisites and HMAC self-test interface with the partner pack; the `opaque-id-tolerance` certification phase MUST send **no plan** and use a fresh `protection_id` from `GET /v1/reference/protections` (served Medium in sandbox only). All bookings remain Premium.
3. Obtain Ride24's explicit authorization to start `POST /_certification/start` and complete the subsequent run in the 24-hour limit. Do not start merely because CI passed.
4. After passing certification, request production access in Caravel portal and verify EVERY production Premium availability/protection row before exposing offers; keep partner `api_enabled=false` until the AVIA shared-flow integration is safely complete.


## 18.11.2026 — izolowany most wynikowy Caravel → Ride24

- `caravel-provider-bridge.ts` udostępnia `submitVerifiedCaravelBooking()`.
  To jest **izolowany, niedeployowany** moduł, którego obecnie NIE wywołuje
  `provider-adapters.ts`, `create-booking-request` ani `api-booking-dispatch`.
  Odróżnić gotowość samego modułu od gotowości pełnej produkcji.
- **Dwa niezależne bezpieczniki na utworzenie rezerwacji**:
  `enableSupplierWrite=true` + potwierdzona płatność + aktywny partner
  + brak dotychczasowej referencji + produkcyjne środowisko klienta;
  dodatkowo `CaravelClient.book()` wymaga jawnego
  `allowProductionBookingWrites=true` w konstruktorze i zgodnego
  supplier ID oraz klucza idempotencji. Są to serwerowe wartości
  konfiguracyjne, nigdy dane podawane przez klienta.
- Po przejściu `prepareVerifiedCaravelDispatch()` moduł wysyła
  dokładnie jedno żądanie do klienta Caravel z tym samym UUID
  Ride24 i `pay_on_arrival`. Przed wysłaniem weryfikuje
  kwotę w euro/funtach z dokładnością do centa/pensa.
  Odpowiedź musi zawierać potwierdzoną rezerwację, to samo
  `quote_id`, niezmieniony całkowity koszt i walutę,
  zerowy depozyt/udział własny, płatność na miejscu oraz
  prawidłowy `booking_id`/numer rewizji.
- Tylko taki wynik mapowany jest na standardową odpowiedź Ride24
  `booking_reference`, `reference`, `status=confirmed`.
  Zwracane są minimalne metadane techniczne, bez danych osobowych.
- Po odpowiedzi niezgodnej z wyceną lub bez potwierdzonej
  płatności na miejscu — `hold_for_manual_review`, z zachowaniem
  identyfikatora zewnętrznego, jeśli go otrzymano.
  Przy utraconej odpowiedzi sieciowej wynik jest NIEZNANY:
  `supplier_outcome_uncertain`. **Nigdy** automatycznie nie
  generować nowego klucza ani nie robić kolejnego żądania,
  dopóki odczyt po referencji nie wyjaśni stanu dostawcy.
- Testy mock obejmują brak upoważnienia, brak płatności,
  nieaktywny profil, stary regulamin, utratę sieci,
  niezgodność ceny, status `pending`, brak modelu
  `pay_on_arrival` i poprawne mapowanie z potwierdzonego
  API Booking. Nie wysłano rzeczywistej rezerwacji.
- CI: `Caravel sandbox adapter checks` i
  `Ride24 API Compatibility QA` przeszły na commicie
  `3caa68f728ca955de0338b86f856ef79863c1e86`.
- Następny prawdziwy krok integracyjny: wdrożenie zaufanego
  kontekstu rezerwacji/zaakceptowanego `document_id` w istniejących
  backendach Ride24, później routing Caravel w
  `provider-adapters.ts`. Nie podłączać, dopóki nie będzie
  certyfikacji, hash §3.9 i zgodności ubezpieczenia.
  Unikać zmian we wspólnym adapterze wpływających na AVIA.



## 18.11.2026 — rozdzielenie sandbox / Ride24: waluta, depozyt i model pobrania płatności

- Wykryto ryzyko w początkowej weryfikacji odpowiedzi rezerwacji:
  sama kwota `deposit.amount=0` i `excess.amount=0` nie wystarcza
  bez sprawdzenia waluty. Jednocześnie otwarty schemat API Caravel może
  **pomijać `Booking.payment`**, gdy stosuje domyślne `pay_on_arrival`.
  Wprowadzenie obowiązkowych pól dla wszystkich scenariuszy
  zakłóciło 6 testów sandboxowych, co zostało poprawione.
- `verifyCaravelBookingAgainstQuote(..., {strictProductionPayment:true})`
  wymaga już dla *oddzielnego produkcyjnego mostu Ride24*:
  zgodnej waluty przy zerowym depozycie i udziale własnym,
  jawnego `payment.model=pay_on_arrival`,
  kwoty płatnej przy odbiorze równej całej wycenie i
  `payment.amount_prepaid=0` w tej samej walucie.
  Bez takiego dowodu most odmawia uznania potwierdzenia za
  zgodne i kieruje do ręcznego sprawdzenia. Standardowy
  weryfikator sandbox pozostaje zgodny z opcjonalnymi polami API.
  **Należy ustalić z Caravel, czy produkcyjna odpowiedź zawsze zawiera
  rozbicie tych pól — w przeciwnym razie potrzebny wiarygodny
  dowód z aktualnej wyceny i dostawcy, a nie ślepe dopisanie domyślnych wartości.**
- W danych testowych Caravel często występuje rozbicie np.
  `pay_now=13200` i `pay_at_pickup=4500` przy łącznej kwocie
  `17700` w jednostkach groszowych. **Nie wolno** opublikować
  takiej oferty w Ride24 pod etykietą `pay_on_arrival` tylko dlatego,
  że Supplier.payment_models zawiera ten model.
- Dodano `caravel-payment-contract.ts`:
  `verifyCaravelRide24PaymentContract` wymaga
  `payment_model=pay_on_arrival`, `pay_now=0`,
  `pay_at_pickup=total`, zgodności kwot w minor/major
  oraz waluty EUR lub GBP. Nie nalicza ani nie pobiera
  opłaty Ride24 przez Stripe.
- Dodano `buildRide24SellableCaravelOfferFromApi()` jako
  odrębny *przyszły* punkt publikowania ofert. Zwykły
  `buildCaravelOfferFromApi()` nadal parsuje różne rzeczywiste
  tryby Caravel na potrzeby certyfikacji, a nowy wariant
  odrzuca wymaganie przedpłaty. **Wyszukiwarka Ride24 nie jest
  jeszcze podłączona do żadnego z nich**.
- Produkcyjny `buildCaravelBookingDraft()` dodatkowo
  odrzuca quote bez sprawdzonego zerowego `pay_now` i pełnej
  kwoty przy odbiorze. Testy uwzględniają brak splitu,
  częściową przedpłatę i dwie waluty.
- Commit `75b780d47b1871380188b653a66e8d1dfae17b2e`:
  dwa zestawy Caravel sandbox checks i Ride24 API Compatibility QA
  zakończyły się sukcesem. Brak wywołań prawdziwego
  Caravel API, deployu, modyfikacji bazy czy Stripe.
- Biznesowa przeszkoda wciąż istnieje: Caravel Premium
  wyłącza szkło, koła i podwozie; nie włączać ofert.


## 18.11.2026 — prawdziwość etykiet płatności i pełnego ubezpieczenia w znormalizowanej ofercie

- Naprawiono niebezpieczne założenie w `buildCaravelOfferFromApi()`:
  sam fakt, że `Supplier.payment_models` zawiera `pay_on_arrival`,
  nie oznacza, że **konkretna wycena** nie wymaga przedpłaty.
  Wcześniej parser oznaczał każde poprawnie odczytane Premium jako
  `features.payment_model="pay_on_arrival"` i
  `supplier_collects_grand_total=true`, nawet gdy Caravel zwracał
  `pay_now>0`. Teraz te pola są ustawione wyłącznie, jeśli
  `pay_now=0` i `pay_at_pickup=grand_total`; dla pozostałych
  wycen `payment_model=null` i `supplier_collects_grand_total=false`.
  Opcjonalne pola nie są zastępowane domysłami.
- Poprawiono także `buildCaravelOffer()`: sama surowa wycena,
  bez zweryfikowanego zakresu ochrony, ma
  `features.fullInsurance=false`. Dopiero
  `buildCaravelOfferFromApi()`, **po** udanej walidacji
  `evaluateCaravelPremium()`, może ustawić `fullInsurance=true`.
  Wynik nie oznacza zgody na rzeczywiste obecne wyłączenia Caravel
  (szyby, opony/koła, podwozie), które pozostają blokadą.
- Testy obejmują zarówno niesprzedawalną wycenę z przedpłatą
  (zachowaną do diagnostyki/certyfikacji), jak i wycenę
  bez przedpłaty w EUR/GBP, która przechodzi odrębny filtr
  `buildRide24SellableCaravelOfferFromApi()`.
- Kod nadal nie jest podłączony do produkcyjnej wyszukiwarki
  Ride24, rezerwacji ani Stripe. Nie wykonano żadnych wywołań
  rzeczywistego API, deployu lub migracji bazy.
- Trzy przebiegi GitHub Actions dla commita
  `e71ac6b2bcf14d68d5230ecd9476948c91536141`:
  `Ride24 API Compatibility QA` oraz dwa
  `Caravel sandbox adapter checks` — wszystkie `success`.


## 18 Nov 2026 — operator approves disclosed Premium exclusions, supplier current state unverified

**Business decision (Ride24 owner):** a Caravel Premium offer can be sold despite
excluded glass, tyres/wheels or undercarriage **only if the customer is shown
the actual current provider exclusions and fees before paying the Ride24
reservation fee, opens the authoritative supplier terms, and explicitly
accepts this limited cover**. Do not show a claim that the excluded components
are covered. This is a Caravel-only exception; other API providers remain unchanged.

**Source of truth:** supplier says EN v4 is published on 17 Nov 2026 by
`GET /v1/reference/terms/{document_id}`. The older Caravel rules PDF dated
10 Nov still explicitly excludes glass, wheels, tyres and undercarriage
(§3.1), states a EUR100 damage/theft administration fee (§6.1), and
authorizes charging a card presented on collection (§5.1). That document is
NOT evidence that the supplier has since changed its current API coverage.
`caravel_sbx_reference_snapshots` currently contains zero rows. Fresh
supplier `Protection`, `QuoteResponseData.deposit` and current EN v4
terms remain to be read with a valid sandbox/production key. Never infer a
recent change from a user hypothesis or from a historical PDF.

**Implementation (isolated PR #84):**
- `caravel-exclusion-policy.ts` preserves strict default Premium checks, but
  optionally accepts a **backend/operator-approved** exact list of
  `Protection.excludes` if theft/fire and bodywork coverage with zero excess,
  zero theft excess and zero deposit are genuinely verified. It permits
  omitted glass/tyres/undercarriage coverage ONLY when each is explicitly in
  the reviewed exclusions, not silently.
- The review includes the immutable terms `document_id`, verified content
  hash, ALL excluded codes, and the supplier administration fee. A change of
  supplier exclusions or missing/invalid final zero-deposit quote rejects
  publication. Pre-quote protection selection is allowed to inspect the
  catalogue without the final quote; publishing or booking NEVER bypasses
  the quote deposit check.
- `buildCaravelOfferFromApi()` now carries flags
  `premiumProtectionIncluded`, `premiumProtectionWithExclusions`,
  `caravelExclusions`, `damageAdministrationFeeMinor`,
  `protectionTermsDocumentId`. Disclosed Premium has
  `fullInsurance=false` so no misleading blanket promise appears.
  Caravel offers must still pass the separate zero-prepayment quote filter
  before Ride24 may sell them. Existing AVIA and Stripe unaffected.
- `buildCaravelBookingDraft()` for production requires
  `coverageDisclosureAcceptedBeforePayment=true`, exact exclusions and
  fee shown to the client, the same latest terms id/hash, a quote snapshot
  with the same coverage and fee, and all existing licence/payment/
  idempotency/insurance conditions. If a partner changes the exclusions,
  client consent or an outdated quote fails closed.
- `CARAVEL_PREMIUM_TERMS` is clearly labelled **historical**, not live.
  It must not be rendered without verifying current Caravel API clauses.

**Still not done and strictly required before launch:** retrieve/verify
the actual latest Caravel Terms EN v4 canonical hash per §3.9, current
supplier protection and quote, configure secure credentials in the test
environment, submit HMAC self-test and complete official 24-hour
certification, persist/display immutable terms and exclusions through the
real WWW and Android customer workflows, enable safe provider routing,
reconcile live refunds/cancellations and run E2E booking tests. Do not
enable `partners.api_enabled` or merge the PR as a production release
until these are evidenced. Existing sandbox functions expire 20 Nov
2026 20:00 UTC.
