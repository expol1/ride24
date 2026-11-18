-- Caravel automatic catalogue + terms sync (hourly). NOT APPLIED (18 Nov 2026):
-- apply at go-live together with deploying caravel-admin and setting the Edge
-- secret CARAVEL_AUTO_SYNC_SECRET to the same value as the vault secret below.
-- Without production credentials the job answers CARAVEL_AUTO_SYNC_SKIPPED and
-- changes nothing. A new terms version pauses sales until "Aktywuj API".
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'caravel_auto_sync_cron') THEN
  PERFORM vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text,
    'caravel_auto_sync_cron', 'Caravel catalogue/terms sync scheduler');
 END IF;
 IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ride24-caravel-auto-sync') THEN
  PERFORM cron.schedule('ride24-caravel-auto-sync', '23 * * * *', $job$
   SELECT net.http_post(url := 'https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/caravel-admin',
     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
       (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'caravel_auto_sync_cron')),
     body := '{"action":"auto-sync"}'::jsonb, timeout_milliseconds := 55000);
  $job$);
 END IF;
END $block$;
