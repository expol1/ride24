-- Run as postgres in a single connection. All fixtures are rolled back.
-- Uses existing role identities without hardcoding account IDs or personal data.
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  role_name text;
  identity uuid;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['admin', 'client', 'partner'] LOOP
    SELECT id INTO identity FROM public.profiles
    WHERE role::text = role_name ORDER BY id LIMIT 1;
    IF identity IS NULL THEN
      RAISE EXCEPTION 'Missing % identity for permission test', role_name;
    END IF;
    PERFORM set_config('ride24.test.' || role_name, identity::text, true);
  END LOOP;
  PERFORM set_config('ride24.test.fixture', gen_random_uuid()::text, true);
  PERFORM set_config('ride24.test.new_admin_row', gen_random_uuid()::text, true);
  PERFORM set_config('ride24.test.unknown_user', gen_random_uuid()::text, true);
END $$;

INSERT INTO public.locations_dictionary (id, category, name_en, name_pl, keywords)
VALUES (current_setting('ride24.test.fixture')::uuid, 'city',
        '__ride24_permission_fixture__', '__ride24_permission_fixture__', 'original');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('ride24.test.admin'), true);
SELECT set_config('request.jwt.claims', json_build_object(
  'sub', current_setting('ride24.test.admin'), 'role', 'authenticated')::text, true);

DO $$
DECLARE affected integer;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin recognition failed'; END IF;
  INSERT INTO public.locations_dictionary (id, category, name_en, name_pl, keywords)
  VALUES (current_setting('ride24.test.new_admin_row')::uuid, 'city',
          '__ride24_admin_translation__', '__ride24_admin_translation__', 'before');
  UPDATE public.locations_dictionary SET keywords = 'after'
  WHERE id = current_setting('ride24.test.new_admin_row')::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin update failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations_dictionary
                 WHERE id = current_setting('ride24.test.new_admin_row')::uuid
                 AND keywords = 'after') THEN
    RAISE EXCEPTION 'Admin read after write failed';
  END IF;
  DELETE FROM public.locations_dictionary
  WHERE id = current_setting('ride24.test.new_admin_row')::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Unexpected admin delete permission'; END IF;
END $$;

DO $$
DECLARE
  role_name text;
  affected integer;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['client', 'partner', 'unknown_user'] LOOP
    PERFORM set_config('request.jwt.claim.sub', current_setting('ride24.test.' || role_name), true);
    -- A forged user_metadata role must not grant admin privileges.
    PERFORM set_config('request.jwt.claims', json_build_object(
      'sub', current_setting('ride24.test.' || role_name), 'role', 'authenticated',
      'user_metadata', json_build_object('role', 'admin'))::text, true);
    IF public.is_admin() THEN RAISE EXCEPTION 'Non-admin % recognized as admin', role_name; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.locations_dictionary
                   WHERE id = current_setting('ride24.test.fixture')::uuid) THEN
      RAISE EXCEPTION 'Public authenticated read failed for %', role_name;
    END IF;
    BEGIN
      INSERT INTO public.locations_dictionary (category, name_en, name_pl)
      VALUES ('city', '__ride24_denied_insert__', '__ride24_denied_insert__');
      RAISE EXCEPTION 'Unexpected insert permission for %', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    UPDATE public.locations_dictionary SET keywords = 'unauthorized'
    WHERE id = current_setting('ride24.test.fixture')::uuid;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Unexpected update permission for %', role_name; END IF;
  END LOOP;
END $$;

RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);

DO $$
DECLARE affected integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations_dictionary
                 WHERE id = current_setting('ride24.test.fixture')::uuid) THEN
    RAISE EXCEPTION 'Public anonymous read failed';
  END IF;
  BEGIN
    INSERT INTO public.locations_dictionary (category, name_en, name_pl)
    VALUES ('city', '__ride24_denied_anon__', '__ride24_denied_anon__');
    RAISE EXCEPTION 'Unexpected anonymous insert permission';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.locations_dictionary SET keywords = 'unauthorized'
  WHERE id = current_setting('ride24.test.fixture')::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Unexpected anonymous update permission'; END IF;
END $$;

RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations_dictionary
                 WHERE id = current_setting('ride24.test.fixture')::uuid
                 AND keywords = 'original') THEN
    RAISE EXCEPTION 'Non-admin altered fixture';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.locations_dictionary'::regclass) THEN
    RAISE EXCEPTION 'RLS must remain enabled';
  END IF;
END $$;
ROLLBACK;
SELECT 'PASS: admin insert/update/read; non-admin and anonymous read only; metadata spoof denied; RLS enabled; fixtures rolled back' AS result;
