-- Restore the original retention schedules after confirming the intended retention.
DO $resume$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname IN
    ('daily-booking-cleanup','daily-storage-cleanup','daily-email-log-cleanup')
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, active := true);
  END LOOP;
END;
$resume$;

