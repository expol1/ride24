# Admin location dictionary permissions

The admin mapping editor could read the dictionary but its inserts failed with
`new row violates row-level security policy`. The table had two public SELECT
policies and no write policies after RLS was enabled.

The repair adds authenticated INSERT and UPDATE policies gated by the existing
`public.is_admin()` helper, which checks the stored profile role. Public reading,
RLS, existing rows, search code and Android contracts remain unchanged. No DELETE
permission is added.

Validation: run `supabase/tests/location_dictionary_permissions.sql` as postgres
in one connection. It impersonates actual database roles and checks admin writes,
anonymous/authenticated reads, rejected client/partner inserts and updates, and
rejection of a forged user_metadata admin role. All test rows are rolled back.

Production verification on 2026-10-12 passed every permission assertion. The
81-row count and fingerprint were identical after the rollback. The security
advisor comparison found no new findings (observation timestamps excluded).
Applied migration version: `20261012093744`.

Before the repair, the table contained 81 rows. Its fingerprint was
`e5fae293bb6ba41b662d8d5a1b5dfb94`, calculated using:

```sql
SELECT count(*) AS count,
       md5(coalesce(string_agg(to_jsonb(d)::text, '' ORDER BY id), '')) AS data_fingerprint
FROM public.locations_dictionary d;
```

## Scoped rollback

If needed, apply the following as a new migration. It restores the previous
read-only policies without touching data or disabling RLS. The admin editor will
again be unable to save until its write permission is restored.

```sql
SET lock_timeout = '5s';
DROP POLICY IF EXISTS ride24_locations_dictionary_admin_insert
  ON public.locations_dictionary;
DROP POLICY IF EXISTS ride24_locations_dictionary_admin_update
  ON public.locations_dictionary;
```
