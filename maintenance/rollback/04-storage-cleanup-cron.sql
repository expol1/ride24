DO $restore$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname='daily-storage-cleanup'
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, command := $original$
SELECT net.http_post(
url:='https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/cleanup-storage',
headers:='{"Content-Type": "application/json"}'::jsonb
);
$original$);
  END LOOP;
END;
$restore$;

