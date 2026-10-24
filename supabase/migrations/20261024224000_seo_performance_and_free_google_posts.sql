-- Free Search Console performance reporting; no paid API or Ads dependency.
ALTER TABLE public.seo_settings
  ADD COLUMN IF NOT EXISTS search_performance jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_business_post boolean NOT NULL DEFAULT false;

-- This daily job reuses the existing protected SEO cron secret.
SELECT cron.schedule('ride24-seo-performance','49 9 * * *',
  $task$
  SELECT net.http_post(
    url:='https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/admin-seo',
    headers:=jsonb_build_object('Content-Type','application/json','x-seo-cron',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='ride24_seo_cron')),
    body:='{"action":"performance"}'::jsonb,
    timeout_milliseconds:=55000
  );
  $task$);
