# Ride24 API Partner Provider Setup

Status: implementation branch only. Do not deploy to production until reviewed.

## Pricing invariant — DO NOT CHANGE

API partners use the same Ride24 pricing model as LOCAL partners:

1. Partner API returns the current public rental price.
2. Ride24 applies the fixed Partner discount stored on the Partner account.
3. The result is the Partner net amount payable by the customer at pickup.
4. Ride24 applies the global platform margin from `get_global_platform_margin()`.
5. Results display the final Ride24 customer price.
6. The Ride24 margin component is paid online as the reservation fee.
7. The Partner net amount is paid directly to the rental company.

Example with partner API price EUR 100, Partner discount 10%, Ride24 global margin 10%:

- Partner public price: 100.00
- Partner net: 90.00
- Ride24 reservation fee / margin: 9.00
- Results price: 99.00
- Customer pays Ride24: 9.00
- Customer pays Partner at pickup: 90.00

The LOCAL pricing flow must remain unchanged.

## Provider architecture

Provider-specific translation lives in:

`supabase/functions/_shared/provider-adapters.ts`

Shared HTTP/security/normalization remains in:

`supabase/functions/_shared/partner-api.ts`

Provider adapters are used by:

- `api-partner-admin` — connection test and metadata synchronization
- `search-api` — live availability and price
- `api-booking-dispatch` — external reservation creation
- `api-booking-status-sync` — reservation status and expiry cancellation
- `client-cancel-booking` — customer-initiated cancellation

Partner API credentials remain server-side in `partner_api_credentials`.

## Stable metadata vs live data

Stored locally in Ride24:
- partner locations (`partner_locations`)
- vehicle groups/categories (`car_classes`)
- stable external IDs and descriptive metadata

Queried live:
- availability
- current rental price / quote
- booking create
- booking status
- cancellation

API-managed metadata is kept separate with `is_api_managed = true`.

## Renteon preset

Admin provider key: `renteon`

Recommended API base URL:
`https://{provider-host}/{culture}`

Example test host:
`https://demo.s2.renteon.com/en`

Credential mapping:
- API KEY = Renteon `client_id`
- SECRET = Renteon `secret`
- Username = Renteon username
- Password = Renteon password
- Auth type = `renteon_oauth`

Default endpoint preset:
- auth: `/token`
- health: `/api/ExSettings`
- locations: `/api/ExOffice/Search`
- groups: `/api/ExCarCategory/Search`
- search: `/api/ExBooking/Availability`
- booking_create: `/api/ExBooking/Create`
- booking_save: `/api/ExBooking/Save`
- booking_status: `/api/ExBooking/{id}`
- booking_cancel: `/api/ExBooking/Cancel/{id}`

Renteon notes:
- OAuth signature is Base64(SHA512(username + salt + secret + password + salt + secret + client_id)).
- Access/refresh tokens are cached server-side. Runtime token cache is persisted in service-role-only credentials storage.
- TEST and PRODUCTION IDs may differ and must never be hard-coded globally.
- Availability `Amount` is treated as the total provider rental amount for the requested period. The adapter converts it to an internal per-day equivalent only so the existing Ride24 pricing engine reproduces the exact period total.
- `BookAsCommissioner = true` is used for the Ride24 pay-at-pickup model.
- The availability item and `PriceDate` are stored server-side with the Ride24 quote and reused during booking Create/Save.

## Easy Web Rent preset

Admin provider key: `easy_web_rent`

Authentication:
- default: Bearer token / managed API client
- exact City Rent scopes and tenant URL must be supplied by City Rent / Easy Web Rent.

Publicly documented endpoints currently used as defaults:
- health/locations: `/api/v1/locations`
- groups: `/api/v1/vehicle-classes`
- search: `/api/v1/availability`
- booking_create: `/api/v1/reservations`
- booking_status: `/api/v1/reservations/{id}`
- booking_cancel: `/api/v1/reservations/{id}/cancel`

The Admin endpoint fields remain editable. Exact City Rent API documentation overrides these presets.

Easy Web Rent booking writes include `Idempotency-Key`.

The adapter supports distinct pickup and return location IDs for one-way rentals.

## Admin workflow

1. Create Partner.
2. Select Partner API.
3. Select provider: Renteon / Easy Web Rent / Ride24 Standard / Custom.
4. Set Partner discount.
5. Enter provider host and credentials when available.
6. Partner receives temporary password.
7. Partner changes password and accepts B2B.
8. Save API configuration.
9. Test connection.
10. Synchronize locations and vehicle groups.
11. Confirm pilot inventory.
12. Activate API.
13. Run end-to-end test.
14. Launch pilot.
15. Expand inventory after acceptance.

## End-to-end acceptance test

Required PASS sequence:

AUTH
-> LOCATIONS
-> VEHICLE GROUPS
-> AVAILABILITY
-> PROVIDER PRICE
-> RIDE24 PRICING
-> RESULTS
-> QUOTE
-> BOOKING CREATE
-> EXTERNAL REFERENCE
-> RESERVATION FEE
-> VOUCHER PARTNER AMOUNT
-> STATUS
-> CANCELLATION

One-way providers additionally require:
PICKUP LOCATION != RETURN LOCATION

## Deployment order

1. Review branch diff.
2. Apply migration `20261006120500_api_partner_runtime_tokens.sql`.
3. Deploy updated shared modules and Edge Functions.
4. Deploy Admin UI and world-search country update.
5. Smoke-test LOCAL search and LOCAL booking first.
6. Create a non-production API test Partner.
7. Test provider connection and metadata sync.
8. Test live API search and pricing snapshots.
9. Test API booking, status and cancellation.
10. Only then activate a real pilot Partner.

## First partner onboarding

### Renteon partner
Waiting for:
- tenant/base URL for their account
- username
- password
- client_id
- secret
- sandbox/test confirmation
- selected pilot locations/groups

After receipt: enter credentials -> Test -> Sync -> inspect mapping -> Active -> E2E.

### City Rent / Easy Web Rent
Waiting for:
- City Rent tenant API documentation
- tenant/base URL
- sandbox/test details
- managed API client / bearer token
- scopes/abilities
- exact locations/classes response format
- quote/reservation/status/cancel payloads
- technical contact

After receipt: update endpoint/field mapping if their tenant differs from the public defaults -> Test -> Sync -> Mostar/Sarajevo/one-way E2E -> Active.
