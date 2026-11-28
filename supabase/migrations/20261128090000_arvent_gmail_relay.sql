-- Arvent confirmations relayed from a Gmail label by Google Apps Script
-- (read-only Gmail scope). The Zoho poller stays in the code base but its
-- every-minute cron is removed: no Zoho API access is configured.
alter table public.arvent_email_messages drop constraint if exists arvent_email_messages_source_check;
alter table public.arvent_email_messages add constraint arvent_email_messages_source_check
  check (source in ('zoho','admin_upload','gmail'));
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'ride24-arvent-mail-ingest';
  end if;
end $$;
