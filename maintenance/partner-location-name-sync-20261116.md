# Ride24 — Partner location names for WWW and Android (2026-11-16)

## Production database
A `BEFORE INSERT OR UPDATE OF location_name, display_name` trigger is active on `public.partner_locations`: `ride24_partner_location_display_name_guard` calling `public.ride24_partner_location_display_name_guard()`.

The trigger only fills absent, empty or literal `null` public names using `location_name` (then city as last fallback). When an existing location is renamed and its former public name was generated from the old technical name, the public name tracks the rename. Explicitly customized public names are preserved.

A one-time backfill populated previously empty `display_name` fields. It does **not** change country, coordinates, availability, fees, pricing, location identifiers, or booking keys.

A transaction that inserted, renamed, custom-labeled and rolled back a temporary location passed all three checks; production record count did not change.

## Partner website
`partner-dashboard.html` now supplies non-empty `display_name` for new locations. It supports bilingual autocomplete for name, country, region and city, and shows PL/EN translation preview based on verified `locations_dictionary` data. Polish input is mapped back to canonical English for the stable `location_name` key when a verified dictionary match exists. The country is resolved via the complete `country-data.js` registry, including ISO flags.

`assets/js/location-names.js` now provides `canonicalCountry`, `canonicalLocationName`, `loadDictionary`, and `localizedNames` shared by the Partner Panel. Unknown names are preserved in English and are **not** machine-translated or invented.

## Android limitation
The Android app source is not in the checked-in `expol1/ride24` web repository. The database guard fixes missing/null headings for **existing** Android versions without a new APK. The existing Android client may still display English technical names where it does not use the verified PL dictionary. True language-specific PL/EN rendering in the installed APK requires a separate Android client change and new release. Do not claim it is done by the web-only change.

## Deployment
Web changes reside in the linked GitHub PR until merged, and a Cloudflare deploy must be confirmed independently. A GitHub merge by itself is not proof that `ride24.pl` serves the new scripts.
