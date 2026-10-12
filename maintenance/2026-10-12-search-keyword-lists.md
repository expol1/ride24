# Comma-separated search aliases

The Golem dictionary entry correctly contained nine comma-separated aliases.
The homepage appended the entire keywords string as one unquoted OR-filter value.
Its commas were interpreted as PostgREST filter syntax, causing a search error.
Albania also matched that dictionary row via the alias Golem Albania, so its
expanded location query failed too. Both failures were reproduced on the public
homepage before the fix, with a search error logged for each query.

The repair splits keywords on commas, trims and lowercases individual terms,
deduplicates them after normalization, and quotes every dictionary/location
filter value using JSON string escaping. Commas, parentheses, double quotes and
backslashes in a term cannot alter the OR-filter grammar.

Country/city/region matching, active filtering, result limits, ranking, pickup
and return objects, fleet/result queries, map logic and Android apps stay as
before. No dictionary entries, partner locations or other database data are
modified. Existing administrator-entered keywords are preserved.

Verification: 84 Chromium fixture cases passed across PL/EN and desktop/mobile,
including all nine Golem aliases, four Albania locations, full names with
parentheses, a comma-containing search, quotation marks, Cyprus translations,
cities/regions, unknown queries, inactive exclusion and pickup/return selection.
The fixture parser rejects malformed OR-filter grammar; remote writes are blocked.

Post-deployment verification on the public homepage passed: Albania displayed all
four locations, every one of the nine Golem aliases displayed the Golem hotel
point, and selecting it populated both pickup and return. No new search errors
appeared after deployment. The visual proof is
`2026-10-12-albania-search-proof.jpg`. No booking was created.

Backup branch: `backup/search-before-keywords-2026-10-12`, based on
`6af6cb34c4f9f59a3be9536c4d817e411dde2227`. To undo this repair, revert its commit
or restore only the changed smart-search lines. Do not reset main to the backup
branch, because later unrelated edits may exist.
