# Sleid Rental location update

Requested partner: `5c72f936-aef2-418a-84b5-ba1d56f2a6bc`.
The before snapshot was committed before changing the database. No project code,
Android app, account, fleet, fee, agreement or partner document changes were made.

| Location | Action | Type |
| --- | --- | --- |
| Tirana International Airport (TIA) | Renamed existing Tirana Airport; preserved ID | airport |
| Durrës City | Renamed existing Durres City; corrected its hotel type | city |
| Tirana City | Added once | city |
| Golem (All Coastal Hotels) | Added one point covering coastal hotels | hotel |

New locations are active, have no extra fee configured, and use the Albania guide
already assigned to the existing two points. Golem uses city=Golem,
region=Durrës, country=Albania. Tirana uses city=region=Tirana, country=Albania.

The transaction checked the target identity, locked its rows, compared against
the saved snapshot and checked for existing city/Golem locations before insertion.
It retained both original location IDs and added only two rows.

## Verification

- All four points are visible to the anonymous search role and join to the same
  four active fleet classes under the active partner. Availability for a specific
  rental date still follows existing reservation and fleet rules.
- Searches for Albania, TIA, Tirana, Durres/Dures and Golem return the intended
  points. The unchanged dictionary can broaden some searches: Tirana is also a
  keyword on Albania, and Durrës is the region assigned to Golem. These searches
  therefore can include other relevant points in addition to the named city.
- Fingerprints of other partners' location rows, the partner fleet and partner
  profile were unchanged before/after the transaction.
- All four points have the Albania travel guide; no extra rows/accounts/bookings
  were created for testing. No location triggers exist, so these writes do not
  dispatch booking notifications.

## Restore

The exact original rows are in `2026-10-12-sleid-locations-before.json`, and the
verified result is in `2026-10-12-sleid-locations-after.json`.

Use `rollback/2026-10-12-sleid-locations.sql` only when rollback is required. It
restores the two original names/types and deactivates the two newly added points.
It keeps all location IDs and rows, so references from future bookings remain
valid. Its guard stops if the partner's location fields changed after this task;
review those changes before attempting a different restore.

The rollback script was tested inside an uncommitted transaction with assertions,
then rolled back. All four current points remained active with their guide.
