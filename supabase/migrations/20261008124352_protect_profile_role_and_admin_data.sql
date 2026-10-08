-- No application data or storage objects are removed by this migration.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ride24_preserve_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $guard$
DECLARE existing_role public.user_role;
BEGIN
  IF current_user IN ('postgres','supabase_admin','service_role') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Preserve the stored role, including when an existing Android client upserts defaults.
    NEW.role := OLD.role;
  ELSE
    SELECT p.role INTO existing_role FROM public.profiles p
    WHERE p.id = NEW.id AND p.id = auth.uid();
    IF FOUND THEN
      NEW.role := existing_role;
    ELSIF NEW.role IS DISTINCT FROM 'client'::public.user_role THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Profile role is managed by the server';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.ride24_preserve_profile_role() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ride24_preserve_profile_role
BEFORE INSERT OR UPDATE OF role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.ride24_preserve_profile_role();

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ride24_transactions_admin ON public.transactions
FOR ALL TO authenticated USING ((SELECT public.is_admin()))
WITH CHECK ((SELECT public.is_admin()));
ALTER TABLE public.marketing_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY ride24_marketing_queue_admin ON public.marketing_queue
FOR ALL TO authenticated USING ((SELECT public.is_admin()))
WITH CHECK ((SELECT public.is_admin()));

ALTER POLICY "Authenticated users can read contact messages" ON public.contact_messages
USING ((SELECT public.is_admin()));
ALTER POLICY "Authenticated users can delete contact messages" ON public.contact_messages
USING ((SELECT public.is_admin()));
ALTER POLICY marketing_settings_select ON public.marketing_settings
USING ((SELECT public.is_admin()));
ALTER POLICY marketing_settings_update ON public.marketing_settings
USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- These maintenance functions remain available to the scheduler and trusted server.
REVOKE EXECUTE ON FUNCTION public.cleanup_old_bookings() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_email_logs() FROM PUBLIC, anon, authenticated;

DO $pause$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname IN
    ('daily-booking-cleanup','daily-storage-cleanup','daily-email-log-cleanup')
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, active := false);
  END LOOP;
END;
$pause$;

