-- Keeps the original daily schedule and 180-day cleanup rules.
DO $configure$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname='daily-storage-cleanup'
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, command := $request$
SELECT net.http_post(
  url := 'https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/cleanup-storage',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (
      SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE name = 'SUPABASE_SERVICE_ROLE_KEY' LIMIT 1
    )
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 30000
);
$request$);
  END LOOP;
END;
$configure$;

