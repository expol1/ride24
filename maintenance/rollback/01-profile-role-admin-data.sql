-- Restores only configuration changed by stage 1. Does not replace or delete data.
SET lock_timeout = '5s';
DROP TRIGGER IF EXISTS ride24_preserve_profile_role ON public.profiles;
DROP FUNCTION IF EXISTS public.ride24_preserve_profile_role();
DROP POLICY IF EXISTS ride24_transactions_admin ON public.transactions;
DROP POLICY IF EXISTS ride24_marketing_queue_admin ON public.marketing_queue;
ALTER TABLE public.transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_queue DISABLE ROW LEVEL SECURITY;
ALTER POLICY "Authenticated users can read contact messages" ON "public"."contact_messages" USING (true);
ALTER POLICY "Authenticated users can delete contact messages" ON "public"."contact_messages" USING (true);
ALTER POLICY "marketing_settings_select" ON "public"."marketing_settings" USING (true);
ALTER POLICY "marketing_settings_update" ON "public"."marketing_settings" USING (true) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION public.cleanup_old_bookings() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_email_logs() TO PUBLIC, anon, authenticated;
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

