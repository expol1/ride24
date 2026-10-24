-- Additive, draft-only SEO review. Existing daily AI quota and credentials remain.
ALTER TABLE public.seo_settings
 ADD COLUMN auto_review_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_correction_day date;

-- Reserve at most one automatic correction per UTC day across concurrent workers.
-- Actual AI generation additionally consumes the existing shared atomic AI slot.
CREATE FUNCTION public.admin_seo_correction_slot()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE s public.seo_settings; today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
 SELECT * INTO s FROM public.seo_settings WHERE id=1 FOR UPDATE;
 IF NOT FOUND OR NOT s.enabled OR NOT s.auto_review_enabled OR s.auto_correction_day=today THEN RETURN false; END IF;
 UPDATE public.seo_settings SET auto_correction_day=today WHERE id=1;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.admin_seo_correction_slot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seo_correction_slot() TO service_role;

DO $block$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='ride24-seo-review') THEN
  PERFORM cron.schedule('ride24-seo-review','7,22,37,52 * * * *',$job$
   SELECT net.http_post(url:='https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/admin-seo',
    headers:=jsonb_build_object('Content-Type','application/json','x-seo-cron',
     (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='ride24_seo_cron')),
    body:='{"action":"review"}'::jsonb,timeout_milliseconds:=55000);
  $job$);
 END IF;
END $block$;
