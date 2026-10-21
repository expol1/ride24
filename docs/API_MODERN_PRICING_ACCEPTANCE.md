# API compatibility with current Ride24 pricing

Status checked on 2026-10-21: no API credentials, enabled API partners, API quotes
or API bookings exist in production. Current local partners use the working
WEB/Android supplement engine. No live external integration is certified.

The existing adapters provide infrastructure for authentication, location/group
sync, availability, period totals, booking dispatch, status and cancellation.
Local extras, time rules, closed hours and conditional fees are deliberately
blocked on the API path rather than skipped or charged twice.

## Required adapter work before claiming full feature parity

| Data | Required behaviour |
| --- | --- |
| Locations | Stable provider IDs, country/city, active state, independent pickup/return fees, currency and whether each fee is already in the quote |
| Mandatory charges | Airport, delivery, collection, out-of-hours, one-way and per-booking/per-leg fees; applicable local times and date boundaries |
| Closed hours | Provider rejects unavailable pickup/return before the customer can confirm; a fee must never replace an actual closure |
| Optional catalogue | Stable IDs, EN names with PL mapping, selected state, daily/rental billing, unit price, limits, quantities and free services |
| Additional driver | Driver eligibility plus the provider's priced/free service, without assuming a second driver is free |
| Quote | Complete tax-inclusive period amount; item sums reconcile to cents; no rounded daily amount used for accounting |
| Discounts | Distinguish public prices and already negotiated/NET amounts to prevent applying a partner discount twice |
| Repricing | A change in route, times, vehicle, driver or extra quantities requires a fresh provider quote and customer acceptance |
| Persistence | Immutable item snapshot shared by WEB, Android, partner view and PDF; later catalogue changes cannot alter a booking |
| External save | Selected service IDs/quantities and agreed partner total sent idempotently; response must reconcile with that total |
| Deposits | Refundable cash deposits displayed separately; never treated as rental charges or Ride24 reservation fees |

## Renteon

The official ExBooking/Create endpoint returns an unsaved model with mandatory
additions and optional services. Availability alone is not acceptance evidence
for the full supplement flow. Selected services and quantities must be carried
through the appropriate ExBooking/Calculate model before Save. Map actual model
properties from the chosen API version; older Bookings and ExBooking references
use different property names and must not be mixed.

The current Ride24 adapter does not perform this complete pre-quote catalogue
and repricing flow. Its amount check before Save protects the partner amount,
but does not make optional-service selection available to customers.

Primary references:
- https://demo.s2.renteon.com/en/Api/Help/Api/POST-culture-api-ExBooking-Create/
- https://demo.s2.renteon.com/en/Api/Help/Api/POST-culture-api-ExBooking-Calculate/
- https://demo.s2.renteon.com/en/Api/Help/Bookings/
- https://demo.s2.renteon.com/en/Api/Help/ResourceModel/?modelName=BookingTotalModel

Renteon pay-on-reservation/pay-on-arrival totals must not be confused with
Ride24's separate online reservation fee. The provider must receive only its
agreed payable amount and allowed booking data.

## Other providers

Easy Web Rent currently has a preliminary adapter, not a verified tenant
contract. Exact tenant documentation determines endpoint paths, quote totals,
catalogues, discount semantics and reservation acknowledgements. Endpoint
presets are editable assumptions until confirmed with that provider.

KolayCar and Wheelsys have no dedicated adapters. They must not be labelled
custom without explicit compliance with the Ride24 protocol.

## Acceptance cases

Run with supplier sandbox credentials and do not notify production partners:
1. Free pickup/free return, same office.
2. EUR 50 pickup/free return: EUR 50 total supplements.
3. EUR 50 pickup/EUR 50 return: EUR 100 total supplements.
4. Applicable out-of-hours charge for pickup, return and both legs.
5. Closed pickup/return hours rejected before booking confirmation.
6. One-way and airport fees included once, without duplicating quoted charges.
7. Several optional extras with quantities, daily/rental pricing and free items.
8. Changed dates, times, route or catalogue invalidate the old quote.
9. Discount and tax totals reconcile; refundable deposit stays outside the price.
10. External booking, WEB/Android, partner view and voucher agree on every item.
11. Status, cancellation, retries and failed responses preserve one booking.

Connection and sync successes are reported separately in the admin panel.
The implemented readiness report intentionally does not certify any provider.
