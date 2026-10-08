-- Restores the previous scheduled command only; no data is removed.
DO $restore$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname='invoke-email-worker'
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, command := $original$
    SELECT net.http_post(
      url:='https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/email-worker',
      headers:='{"Content-Type": "application/json"}'::jsonb
    );
  $original$);
  END LOOP;
END;
$restore$;

