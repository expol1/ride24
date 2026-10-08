-- Restore scheduled processing without weakening email-worker authentication.
SET lock_timeout = '5s';
DO $configure$
DECLARE j record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY') THEN
    RAISE EXCEPTION 'Missing service-role Vault entry';
  END IF;
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'invoke-email-worker'
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, command := $request$
SELECT net.http_post(
  url := 'https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/email-worker',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (
      SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE name = 'SUPABASE_SERVICE_ROLE_KEY' LIMIT 1
    )
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 10000
);
$request$);
  END LOOP;
END;
$configure$;

