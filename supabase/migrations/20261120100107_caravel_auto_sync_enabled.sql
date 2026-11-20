-- Caravel: automatic hourly catalogue + terms sync (replaces the never-applied
-- 20261118200000_caravel_auto_sync_schedule.sql). No Edge secret is needed:
-- the cron secret lives only in Vault and caravel-admin checks it through
-- caravel_auto_sync_secret_ok(). The public legacy anon JWT is sent only to
-- pass the gateway (verify_jwt=true); admin actions still require an admin user.
--
-- Behaviour (caravel-partner-admin.ts runCaravelAutoSync):
--  * new vehicles/locations from Caravel are added and go live while sales are open;
--    existing rows keep their `active` flag; operator_hidden rows stay hidden;
--  * a new terms version that passes the machine checks becomes the selling version
--    automatically; one that fails them pauses sales until "Aktywuj API".

DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'caravel_auto_sync_cron') THEN
    PERFORM vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'caravel_auto_sync_cron', 'Caravel catalogue/terms sync scheduler');
  END IF;
END $block$;

CREATE OR REPLACE FUNCTION public.caravel_auto_sync_secret_ok(p_secret text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$
  SELECT coalesce(length(p_secret) >= 32 AND p_secret = (
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'caravel_auto_sync_cron'), false);
$f$;
REVOKE ALL ON FUNCTION public.caravel_auto_sync_secret_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.caravel_auto_sync_secret_ok(text) TO service_role;

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ride24-caravel-auto-sync') THEN
    PERFORM cron.unschedule('ride24-caravel-auto-sync');
  END IF;
  PERFORM cron.schedule('ride24-caravel-auto-sync', '23 * * * *', $job$
   SELECT net.http_post(url := 'https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/caravel-admin',
     headers := jsonb_build_object('Content-Type', 'application/json',
       'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3eWVyZGV1dnl6Z2tnd2dsb3dyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNDY5NDgsImV4cCI6MjA4ODYyMjk0OH0.fcvE717d7v4mMwU70kbyAiuKaZaoQNYN8zUItIvYdLU',
       'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'caravel_auto_sync_cron')),
     body := '{"action":"auto-sync"}'::jsonb, timeout_milliseconds := 55000);
  $job$);
END $block$;
