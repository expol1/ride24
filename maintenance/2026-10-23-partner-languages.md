# Partner WEB panel languages — 2026-10-23

Base: `1093850c0691af351c8b303320fd6d3944150965`.
Recovery branch: `backup/before-partner-languages-20261023`.

The partner WEB panel supports EN, PL, ES, EL, IT, DE and RU. A flag and language
code open an accessible dropdown outside the mobile scrolling header. Keyboard
navigation, Escape, focus restoration and outside clicks are supported.

The existing `partner_lang` preference takes precedence. On a first visit the
first supported browser language is selected, with EN as fallback. An explicit
selection is remembered in that browser. No IP geolocation or remote translation
service is added; preferences are not written to partner records or Auth.

The local catalogue contains 499 original PL/EN UI phrases with five additional
translations. It includes navigation, forms, placeholders, validation, booking
status/actions, price breakdowns, extras and mandatory-fee configuration. Only
explicit UI labels and known templates are translated. Names, entered values,
location identifiers and original signed agreement contents retain their data.

The existing illustrated guide follows the panel language unless the partner
has explicitly selected a different guide language. Its independent preference
and all eight existing guide translations remain available.

Both legal agreement templates remain byte-for-byte unchanged. The acceptance
and signed-document window controls follow the panel language; the legal content
and stored signature language remain original PL/EN. An explanation appears above
the original agreement. No new translated legal template is signed or stored.

## Verification

- Seven-language tests preserve form node identity, typed values, exact money,
  stored Auth tokens and signed content while changing the interface language.
- The actual vehicle and location handlers generate identical isolated database
  payloads in every language. Pickup/return fees remain 50/50 in the fixture.
- Extra submission retains original EN/PL names, quantity and exact unit amount.
- Catalogue completeness, parameter preservation, dynamic booking labels, markup
  injection prevention, dropdown keyboard behavior and guide preferences are tested.
- Existing onboarding checks cover password changes, mandatory documents,
  profile completion, signing and ownership of upload paths with isolated mocks.
- Current quote tests cover free/paid pickup and return, optional extras,
  quantities, loyalty, night charges, route fees and unavailable hours.
- All inline scripts, helper scripts, CSS and flag SVGs are checked.

Tests use isolated fixtures. No production reservation, email, signature, partner
account, payment or uploaded file is created or changed. No database migration,
Edge Function deployment, retention change or Android update belongs to this change.
The customer WEB pages and admin panel do not load the new locale module.

## Publication

PR #42 was merged as `212272feb2cc5e42d3046ebc81a8a6fcd1ae9757`.
All three GitHub test jobs and Cloudflare preview checks passed on
`c7f39ca2818bc03ff2f0632b3f85c654a2fdf208`.
Cloudflare reported successful production deployment
`5e0cda69-d54c-49e1-a1a7-a3f1c87c8a6d` for the merge commit.

The existing admin smoke test now verifies the expected versioned script files
without pinning an obsolete cache revision. No admin application code changed.

Direct custom-domain content and authenticated visual verification remain
unconfirmed: the browser environment was unavailable and public retrieval tools
could not open the page/assets. Automated DOM tests and isolated form/price
tests passed; they are not a physical-device or live-partner account test.

## Recovery

Revert this feature's PR to restore only these UI changes while preserving later
work. The recovery branch records the original files for comparison. No database
restore, financial data rollback or deletion of partner resources is necessary.
