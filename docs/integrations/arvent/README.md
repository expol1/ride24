# Ride24 × Arvent / kolayCAR — integration gate (2026-11-16)

**Status:** technical discovery underway, NOT integrated, NOT live. This directory
documents the real production account and the contract requirements. It must not
be interpreted as permission to call Arvent booking endpoints.

## Verified Ride24 state (production, read 2026-11-16)

- Repository: `expol1/ride24`; production Supabase: `zwyerdeuvyzgkgwglowr`.
- Existing partner ID: `bf29a373-c464-4cec-87a7-c3218ea1ea51`.
- Partner: `provider_type=api`, `api_provider=custom`, `currency=EUR`,
  `discount_percent=0`, `active=true`, `profile_completed=true`,
  `account_status=active`, `agreement_accepted=true`.
- API remains `api_enabled=false`, `api_status=draft`. No Arvent API
  locations, classes, or quotes have been synchronized.
- `partner_api_credentials.api_url` set to
  `https://racapi.arventcarrental.com`. No successful API test recorded.
- Rental terms and partner agreement were already uploaded and must be retained.
- Credentials are stored/used only server-side. Never commit passwords or tokens.

## Current blocker

The partner-provided Postman page:
`https://documenter.getpostman.com/view/39642884/2sB3QDxDwM`
was not retrievable through the available automated fetch in this environment.
The publicly found *2018 kolayCAR 1.6 SOAP API PDF* describes a different host,
so it is **not the source of truth** for the Arvent REST host and must NOT be
used to invent endpoints, authentication headers, request bodies, or response keys.

Request from supplier: **an exported Postman Collection v2.1 JSON with all
required endpoints and example redacted responses**, plus an environment JSON
without real passwords if route variables are required. Confirm whether
`racapi.arventcarrental.com` is production or sandbox, and whether a separate
test environment can perform reservation create/cancel without real bookings.

## Offline API contract inventory

Do not publish/export collections containing live secrets. Use redacted copies.

```sh
node tools/arvent-postman-audit.mjs arvent-collection.redacted.json
node --test tests/backend-hardening/test-arvent-postman-audit.mjs
```

This script *only reads a local JSON file* and produces **unverified
operation hints**. It never sends requests, uses supplied credentials, or
authorizes live booking tests. Review all flagged hosts, auth methods, schemas
and mappings manually against the actual Postman examples.

## Integration order once real contract is verified

1. Resolve exact authorization, currency, category IDs, location IDs,
   availability date/time format, booking confirmation/cancellation semantics.
2. Add isolated `arvent_kolaycar` provider routing to existing
   `_shared/provider-adapters.ts` and explicitly whitelist it in admin API.
3. Normalize categories (never specific car VIN/model guarantees) and prices
   as Arvent net EUR; supplier receives **0% extra discount**.
4. Gate dispatch behind the existing paid Stripe → quote recheck → supplier
   booking → voucher workflow. Preserve idempotency and handle ambiguous
   supplier responses with manual review rather than duplicate requests.
5. Require confirmed supplier cancellation before a client-facing cancelled
   status; keep Ride24 refund queue behavior unchanged.
6. Add fixture-based unit/regression tests and READ-ONLY provider probes.
7. Do not activate Arvent `api_enabled` or publish offers without sign-off.

## Existing partners: non-regression boundary

Do not change AVIA Renteon Aggregator, Pegasus export, Erdem ADB/BJV inventory,
other API partners, Stripe accounting or vouchers. Test the existing workflows.

## Security

Never put usernames, passwords, API keys or sample customer personal details
in GitHub, logs, frontend, Android or test fixtures. The
`public.partner_api_credentials` table has RLS and `service_role` access.
Use the existing server-side credential-loader after exact auth type is confirmed.
The supplied credentials were shared by email; rotate when practical.
