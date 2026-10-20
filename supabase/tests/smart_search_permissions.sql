-- Execute after the migration in one session. All test data is rolled back.
BEGIN;
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE admin_id uuid; client_id uuid;
BEGIN
  SELECT id INTO STRICT admin_id FROM profiles WHERE role::text='admin' ORDER BY id LIMIT 1;
  SELECT id INTO STRICT client_id FROM profiles WHERE role::text='client' ORDER BY id LIMIT 1;
  PERFORM set_config('ride24.smart_test.admin',admin_id::text,true);
  PERFORM set_config('ride24.smart_test.client',client_id::text,true);
  PERFORM set_config('ride24.smart_test.log',gen_random_uuid()::text,true);
  PERFORM set_config('ride24.smart_test.dict',gen_random_uuid()::text,true);
END $$;
INSERT INTO search_logs(id,query)
VALUES(current_setting('ride24.smart_test.log')::uuid,'ride24 smart verification');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('ride24.smart_test.admin'),true);
SELECT set_config('request.jwt.claims',json_build_object(
  'sub',current_setting('ride24.smart_test.admin'),'role','authenticated')::text,true);
DO $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin not recognized'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.search_logs WHERE id=current_setting('ride24.smart_test.log')::uuid)
    THEN RAISE EXCEPTION 'Admin cannot read logs'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.get_top_searches() WHERE query='ride24 smart verification')
    THEN RAISE EXCEPTION 'Admin aggregate omitted unresolved test query'; END IF;
  INSERT INTO public.locations_dictionary(id,category,name_en,name_pl,slug,keywords)
  VALUES(current_setting('ride24.smart_test.dict')::uuid,'location','__ride24_smart_test_point__',
    '__ride24_punkt_testowy__','test-'||current_setting('ride24.smart_test.dict'),'ride24 smart verification');
  IF EXISTS(SELECT 1 FROM public.get_top_searches() WHERE query='ride24 smart verification')
    THEN RAISE EXCEPTION 'Resolved alias still in queue'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.search_logs WHERE id=current_setting('ride24.smart_test.log')::uuid)
    THEN RAISE EXCEPTION 'Resolving query deleted a log'; END IF;
  IF has_table_privilege(current_user,'public.search_logs','INSERT')
    THEN RAISE EXCEPTION 'Admin has direct log-insert grant'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',current_setting('ride24.smart_test.client'),true);
SELECT set_config('request.jwt.claims',json_build_object(
  'sub',current_setting('ride24.smart_test.client'),'role','authenticated',
  'user_metadata',json_build_object('role','admin'))::text,true);
DO $$
BEGIN
  IF public.is_admin() THEN RAISE EXCEPTION 'Forged metadata bypassed stored admin role'; END IF;
  IF EXISTS(SELECT 1 FROM public.search_logs WHERE id=current_setting('ride24.smart_test.log')::uuid)
    THEN RAISE EXCEPTION 'Client can read logs'; END IF;
  IF EXISTS(SELECT 1 FROM public.get_top_searches())
    THEN RAISE EXCEPTION 'Client can read aggregate'; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF has_table_privilege('anon','public.search_logs','SELECT')
    OR has_table_privilege('anon','public.search_logs','INSERT')
    OR has_table_privilege('authenticated','public.search_logs','TRUNCATE')
    OR has_function_privilege('anon','public.get_top_searches()','EXECUTE')
    THEN RAISE EXCEPTION 'Unexpected public log permission'; END IF;
END $$;
ROLLBACK;
