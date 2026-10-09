-- Only the authenticated server endpoint may access this dedicated GitHub token.
-- Existing guide IDs, location assignments and reservation data remain unchanged.
CREATE OR REPLACE FUNCTION public.admin_travel_guide_github_token(p_token text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  secret_id uuid;
  stored_token text;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Server access required' USING ERRCODE = '42501';
  END IF;
  IF p_token IS NULL THEN
    SELECT decrypted_secret INTO stored_token
    FROM vault.decrypted_secrets
    WHERE name = 'ride24_travel_guides_github_token';
    RETURN stored_token;
  END IF;
  IF length(p_token) > 4096 OR p_token !~ '^github_pat_[A-Za-z0-9_]{20,}$' THEN
    RAISE EXCEPTION 'Invalid fine-grained GitHub token' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ride24_travel_guides_github_token'));
  SELECT id INTO secret_id FROM vault.secrets
    WHERE name = 'ride24_travel_guides_github_token';
  IF secret_id IS NULL THEN
    PERFORM vault.create_secret(p_token, 'ride24_travel_guides_github_token',
      'Admin-only HTML travel-guide publishing to expol1/ride24');
  ELSE
    PERFORM vault.update_secret(secret_id, p_token, 'ride24_travel_guides_github_token',
      'Admin-only HTML travel-guide publishing to expol1/ride24');
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_travel_guide_github_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_travel_guide_github_token(text) TO service_role;

-- Public clients may still read the same guides; only admins may add entries.
DROP POLICY IF EXISTS "Authenticated users can insert travel guides" ON public.travel_guides;
CREATE POLICY "Admins can insert travel guides" ON public.travel_guides
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
