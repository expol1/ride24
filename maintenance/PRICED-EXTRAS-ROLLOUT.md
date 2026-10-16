# Paid locations and extras — rollout

Preparation is deployed with `booking_feature_flags.priced_extras_enabled=false`.
Existing booking prices, Stripe/refund rules, partner rates, insurance and retention jobs are preserved. New snapshots are written only for an accepted v2 quote after activation.

## Before enabling charges

- Test client 1.0.15/code16 and partner 1.0.6/code7 on the owner's devices: login, country/city/location search, same-partner return choices, existing booking/history/details and PL/EN.
- Partners receiving v2 reservations must use the new partner app or the updated web panel so they can see the extras before confirming. An older partner app cannot display the new item breakdown.
- Sign production AABs with the existing upload keys. Do not upload the unsigned AABs or test APKs to the production Play track.
- Confirm rollout readiness before setting the global flag. Older customer apps will need an update or the web site for paid-location bookings; they are never charged an unseen fee.
- No real Stripe payment or device end-to-end booking was executed by this task. Automated financial, handler, access-control and PDF checks passed; browser search was verified without making a booking or notifying partners.

## Prices

Partner fields are partner net amounts. The existing car/platform margin also applies to fees and extras; loyalty reduces platform commission only. Search cards show the rental price and a pickup fee starting amount. The complete rental/fee/extra total is quoted before acceptance. Unit extras are multiplied once by quantity and, when applicable, rental days. API provider quotes retain authority over their own services.

Five positive local pickup fees were copied once to the new return field while charges were disabled. Free locations were not changed. Do not repeat that initialization after partners edit their return prices.

## Emergency switch

```sql
update public.booking_feature_flags
set priced_extras_enabled = false
where id = true;
```

Keep new columns, catalog rows and existing snapshots. A submitted v2 quote is rejected for review when the switch changes; it never silently drops extras. Existing v2 bookings, checkout amounts and vouchers keep their saved amounts. Keep the snapshot-aware voucher generator after any v2 bookings exist. Restore selected source files/functions from the pre-rollout backup when needed; never overwrite the current whole database with an old snapshot.

Backups are stored privately on the owner's Google Drive. The scope backup contains complete web files at main 86b4535 and the pre-change server sources/location metadata, not a full Auth/Storage export. Original uploaded Android archives and the owner's signing keys remain separate recovery sources.
