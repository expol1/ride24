# Country search

The homepage's smart search expanded dictionary translations but filtered only
location_name, city and region. It missed country-only matches. Albania returned
just Tirana because the country dictionary entry included that keyword; Cyprus
returned no locations.

The only production code change appends `country.ilike` to the existing OR filter.
Active-only filtering, limits, ranking, selection objects, pickup/return copying
and results-page parameters are unchanged. No database writes, schema changes,
accounts, reservations, notifications or Android changes are needed.

## Verification

- Actual homepage scripts in Chromium: 36 search cases passed across PL/EN and
  desktop (1280 px)/mobile (390 px), using isolated fixtures.
- Country translations, English names, city names, region translations, a search
  keyword, mixed case, no-match results and independent return selection passed.
- Inactive locations remained excluded; no remote mutations occurred.
- Read-only production SQL under role `anon` confirmed the same expanded search:

| Query | Matches before | Matches after | Locations after |
| --- | ---: | ---: | --- |
| albania | 1 | 2 | Tirana Airport; Durres City |
| cypr | 0 | 3 | Larnaca Airport; Paphos Airport; Paphos City |
| cyprus | 0 | 3 | Larnaca Airport; Paphos Airport; Paphos City |
| bułgaria | 0 | 2 | Burgas Airport; Varna Airport |

The optional anonymous REST browser test could not run in this environment
because DNS/network access to the Supabase endpoint was unavailable. Its results
are not included in the passed tests above.

Run the browser regression with `node tests/world-map/test-country-search.mjs`
using the existing world-map Playwright dependency. The same environment
overrides as test-map.mjs select Chromium, Playwright and cached external assets.

## Rollback

Backup branch: `backup/search-before-country-2026-10-12`, based on
`be0389be6689bd19889c053ea1e97ee02dc4119b`.

To reverse only this change, remove `,country.ilike.%${t}%` from `orFilters` in
`index.html`, or revert the country-search commit. Do not reset main to the backup
branch, because that could discard later unrelated edits and travel guides.
