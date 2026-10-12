-- The admin dictionary editor inserts translations and search keywords.
-- Keep public reads and RLS intact; authorize writes from the stored admin role.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE POLICY ride24_locations_dictionary_admin_insert
ON public.locations_dictionary
FOR INSERT TO authenticated
WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY ride24_locations_dictionary_admin_update
ON public.locations_dictionary
FOR UPDATE TO authenticated
USING ((SELECT public.is_admin()))
WITH CHECK ((SELECT public.is_admin()));
