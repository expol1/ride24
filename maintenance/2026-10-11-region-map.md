# Region map — deployment and quick recovery

The homepage now displays served country/island outlines in green, without place
labels or counters on the map. Clicking an area shows its current location count
and pick-up list. No logo is used in the dialog.

## Protected baseline

- Repository: `expol1/ride24`
- Original main commit: `633e411d96bc0eba5f43962c8cca787ebc118871`
- Complete source backup branch: `backup/map-before-regions-2026-10-11`
- https://github.com/expol1/ride24/tree/backup/map-before-regions-2026-10-11
- Downloadable original source: https://github.com/expol1/ride24/archive/refs/heads/backup/map-before-regions-2026-10-11.zip

The original map functions, search functions and helper are retained byte for
byte. The only changes in `index.html` are one stylesheet and one script link.
No database/schema/Auth/Storage/cron/Edge Function changes are involved. The
Android apps, partner data and saved GitHub upload token are untouched.

## Immediate recovery

1. Per browser/session: open `https://ride24.pl/?ride24Map=legacy`. The new map
   module exits before installation; the original map and selector run normally.
2. All visitors: change **only** `const ENABLED = true;` to
   `const ENABLED = false;` near the top of `assets/js/world-map-regions.js`,
   commit and deploy through the normal website pipeline. This disables the new
   module and restores the existing map without touching the database or other
   source files. Increment the script query version in `index.html` if the site
   cache has a long lifetime.
3. Permanent undo: revert the region-map deployment commit, preserving later
   unrelated commits. Do not force/reset `main` to the backup branch: later
   guides or other independent changes might otherwise be lost.

Map library or geometry loading failure automatically invokes the original map.
Closing during a load invalidates the pending result, so a late response cannot
reopen the dialog or change the selected destination.

## Data and boundaries

- Data: anonymous/read-only `partner_locations`, active rows only; columns
  `id,country,region,city,location_name,type`. No locations are embedded in the
  production map; additions/removals are read again on every opening.
- Portugal: mainland / Azores / Madeira are separate outlines.
- Italy: mainland / Sicily / Sardinia are separate outlines. Sicily is **not**
  coloured unless actual active locations are assigned to it.
- Cyprus: south / north are separate outlines; known northern city/region names
  and Ercan select the northern outline. Ambiguous Nicosia locations require an
  explicit north/south region, rather than assuming a side from the city alone.
- Regions use existing `country` and `region` values, with a small city/airport
  fallback for existing data. No new mandatory partner field is introduced.
- Other countries use their country outline. A newly added island destination
  outside the documented regions needs its own boundary and mapping before
  claiming island-specific coverage (e.g. Mallorca or Crete).
- Countries not in the boundary dataset remain accessible in the chooser;
  they are not given invented geography.
- Source: Natural Earth 1:110m overview and 1:10m regional coastlines; public
  domain: https://www.naturalearthdata.com/about/terms-of-use/
- Boundaries are presentation data, not cadastral or routing boundaries.
- Pinned/self-hosted d3-array 3.2.4 and d3-geo 3.1.1; licence files included.
- Libraries and the ~435 KB geometry file load only when the map is opened and
  are reused during the page session. No third-party map API or paid quota.

## Verification

`tests/world-map/test-map.mjs` runs the actual homepage and existing search code
in Chromium with isolated read-only API fixtures. Test requests never create
accounts, reservations, receipts, payments or notifications. Covered: desktop,
390/360/320 px mobile, landscape, area lists and expansion, exact pick-up/drop-off
values and original search objects, PL/EN, close/reopen, Escape, and both legacy
query mode and automatic asset-failure fallback. Remote writes are blocked.

Run: `cd tests/world-map && npm ci && npx playwright install chromium && npm test`.
Optional test environment variables select an existing Chromium/Playwright
installation and downloaded copies of unchanged external homepage libraries.
