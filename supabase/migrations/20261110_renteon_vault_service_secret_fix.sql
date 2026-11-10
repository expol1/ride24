-- Fix Renteon Vault access for the new Supabase sb_secret_* service keys.
-- These keys are not JWTs, so request.jwt.claim.role can be absent.
-- PostgREST runs the request under database role service_role.
-- Keep a strict role check and explicit EXECUTE grants.
CREATE OR REPLACE FUNCTION public.renteon_aggregator_server_credentials()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
 v_login text;
 v_password text;
BEGIN
  IF COALESCE(current_setting('role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized service role operation';
  END IF;
  SELECT decrypted_secret INTO v_login
  FROM vault.decrypted_secrets
  WHERE name = 'ride24_renteon_aggregator_username'
  LIMIT 1;
  SELECT decrypted_secret INTO v_password
  FROM vault.decrypted_secrets
  WHERE name = 'ride24_renteon_aggregator_password'
  LIMIT 1;
  IF v_login IS NULL OR v_login = '' OR v_password IS NULL OR v_password = '' THEN
    RAISE EXCEPTION 'Missing Renteon aggregator credentials in Vault';
  END IF;
  RETURN pg_catalog.jsonb_build_object('username',v_login,'password',v_password);
END;
$fn$;
REVOKE ALL ON FUNCTION public.renteon_aggregator_server_credentials() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renteon_aggregator_server_credentials() FROM anon;
REVOKE ALL ON FUNCTION public.renteon_aggregator_server_credentials() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.renteon_aggregator_server_credentials() TO service_role;
