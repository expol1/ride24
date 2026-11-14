# Caravel Channel API v1.67.0 — certification readiness (Ride24)

Source: partner pack `https://sandbox-api.caravelway.com/docs/packs/caravel/` (CERTIFICATION, Webhook Receiver Guide, CHANNEL-API), read 14 Nov 2026.
**The official 24-hour run (`POST /_certification/start`) has NOT been started** and must not be started without Ride24's explicit approval.

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
- **Real API (13 Nov 2026, admin-only read-only diagnostics function):** capabilities, whoami, suppliers (2), reference locations / policies / vehicles / protections / extras / fees, availability day + night — all 2xx for the first supplier.
- **Not yet observed on the real API:** quote, booking, replay, 409s, cancel, second supplier walk, served-plan quote. These need a server-side run with the key (blocker 1).
- **Simulated only (local mocks / fixtures):** everything in `tests/caravel-*.test.mjs`; the full two-supplier harness on `scripts/mock-caravel-two-suppliers.mjs` (scratchpad, not committed).

## Blockers before starting the official run
1. A server-side run with the key for quote/book/cancel at both suppliers: either add the GitHub secret `CARAVEL_SANDBOX_API_KEY` and label PR #84 `caravel-sandbox-booking`, or approve a separate sandbox test function. The existing diagnostics function is read-only by design.
2. Premium publishability: on the sandbox, no Premium row had zero excess AND zero deposit (13 Nov diagnostics); Premium terms (`theft_excess`, `covers`, `product_type`) must be confirmed per supplier.
3. Ride24 approval to start the 24-hour run.
