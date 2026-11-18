# Ride24 — Smart Search automatic enrichment

## Scope and safety

- One scheduled PostgreSQL job runs at **02:17 UTC every day**: `ride24-smart-search-autofill-v1`.
- It reads only active `partner_locations` and inserts *new* verified translations into `locations_dictionary`.
- It **never updates or deletes existing dictionary rows** and never changes `partner_locations`, IDs, API mapping, bookings, prices, or user accounts.
- Unknown/ambiguous names, experimental “Test” locations, and uncertain misspelled search terms remain unassigned rather than guessed.
- New point names matching a known city plus `Airport`, `Downtown`, `City`, `Port`, or `Train Station` can be translated automatically if the city mapping is unambiguous.
- Verified translation seeds and history live under the private schema `ride24_smart_internal`. All code is free of paid APIs.
- The admin Smart Search view shows the schedule, latest process, and total added translations through the admin-only RPC `smart_search_automation_status()`.

## Operational checks (Supabase SQL Editor)

```sql
-- Status and recent runs:
SELECT * FROM ride24_smart_internal.runs ORDER BY id DESC LIMIT 10;
SELECT * FROM cron.job WHERE jobname = 'ride24-smart-search-autofill-v1';
SELECT * FROM ride24_smart_internal.changes ORDER BY id DESC LIMIT 50;

-- Preview only (no changes to locations_dictionary):
SELECT ride24_smart_internal.process(true);
```

## Emergency stop (non-destructive)

```sql
UPDATE ride24_smart_internal.settings
SET enabled = false, updated_at = now()
WHERE singleton = true;
```

The job still runs but its function refuses to write when `enabled=false`. This immediately stops automatic changes without modifying existing reservations or dictionary entries. An operator can also temporarily unschedule the job with `SELECT cron.unschedule('ride24-smart-search-autofill-v1');`.

## Optional rollback of newly inserted dictionary entries

Only delete rows recorded in `ride24_smart_internal.changes` **after checking whether they have been manually edited or referenced**. Never delete pre-existing entries, and never truncate the dictionary. The pre-automation copy is `ride24_smart_internal.dictionary_before_autofill`.

## Extending coverage

Only add verified translations to `ride24_smart_internal.rules`. Country is an optional exact-match qualifier; a blank country makes a rule universal. Avoid loose fuzzy matching and mixed airport/city aliases; these are dangerous for pickup selection.

## Test results on initial deployment, 2026-11-12

- Dry-run: 239 distinct source items checked; 28 unambiguous translations found.
- First write: 28 entries inserted and recorded.
- Second write: 0 inserted (idempotent).
- All 299 pre-existing dictionary entries remained byte-for-byte unchanged; active partner locations and bookings were not altered.
- Cron registered as an active job owned by `postgres` with timezone GMT.
