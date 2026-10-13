# Automatic country flags

Serbia had neither a country-code entry nor an SVG in the original 42-country
set. The map therefore displayed its name without a flag or a matching boundary.

The homepage now loads a local registry covering all 249 ISO countries and
territories, plus Kosovo (XK), with PL/EN names and 704 name/code aliases.
Existing country labels and manually defined aliases override generated data.
getRide24CountryCode normalizes names before lookup, including ISO codes.

All 250 flags are hosted in assets/flags; 208 files were added. The original 42
SVGs were byte-identical to the pinned flag-icons 7.5.0 source and unchanged.
Its existing MIT licence is retained. Local country-data.js is generated from
that version's country.json and Node Intl.DisplayNames for PL/EN, with previous
country labels preserved. No runtime flag/image provider or extra npm dependency
is used. Images load only for displayed countries. Country metadata is about
48 KB before compression; the SVG collection is about 1.65 MB, never downloaded
all at once during ordinary use.

New partner locations using a country name in Polish/English or its ISO code
automatically resolve a flag without updating this finite list of active
destinations. Islands retain parent flags: Portugal for Azores/Madeira, Italy
for Sicily/Sardinia. Geometry and selection logic are unchanged; Serbia now
resolves RS, which is already included in the map geometry.

Validation: the actual homepage ran in Chromium with isolated fixtures. Every
one of the 250 country flags loaded; all PL/EN names and uppercase/lowercase ISO
codes resolved. Serbia and a previously unsupported Macedonian name passed on
desktop/mobile. Existing five viewport checks, PL/EN, search selection, island
grouping, empty data, close races and legacy fallback passed. No remote writes.
Every SVG was also checked for scripts, inline event handlers and remote hrefs.

No database, partner documents, accounts, Android app, tokens or booking code
was changed. Backup branch: backup/map-before-all-country-flags-2026-10-13 at
62d9c8c65b75f25e46f1a0236c8e848c3284c596. Revert only this deployment commit
to restore the previous map support. Do not reset main to the backup branch.
The existing ?ride24Map=legacy fallback remains available.
