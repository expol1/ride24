-- Automatic Arvent approval from the supplier's emailed confirmation PDF.
-- Every inbound message is logged once (mailbox id unique) with its delivery
-- time, PDF digest and authentication verdict. A booking can be approved by
-- at most one message. Written only by the arvent-mail-ingest edge function
-- (service role) through arvent_email_confirm().
create table if not exists public.arvent_email_messages (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('zoho','admin_upload')),
  mailbox_message_id text not null check (char_length(mailbox_message_id) between 1 and 200),
  rfc822_message_id text check (char_length(rfc822_message_id) <= 500),
  received_at timestamptz not null,
  from_address text check (char_length(from_address) <= 320),
  subject text check (char_length(subject) <= 500),
  pdf_sha256 text check (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  reservation_number text check (reservation_number ~ '^[0-9A-F]{12}$'),
  booking_id uuid references public.bookings(id),
  authentication jsonb,
  document jsonb,
  verdict text not null default 'received'
    check (verdict in ('received','approved','rejected','ignored','error')),
  reasons text[] not null default '{}',
  attempts integer not null default 0,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, mailbox_message_id)
);
create unique index if not exists arvent_email_messages_one_approval
  on public.arvent_email_messages(booking_id) where verdict = 'approved';
create index if not exists arvent_email_messages_reservation
  on public.arvent_email_messages(reservation_number, received_at);
alter table public.arvent_email_messages enable row level security;
revoke all on public.arvent_email_messages from anon, authenticated;
drop policy if exists arvent_email_messages_admin_read on public.arvent_email_messages;
create policy arvent_email_messages_admin_read on public.arvent_email_messages
  for select to authenticated using (public.is_admin());
grant select on public.arvent_email_messages to authenticated;

-- Atomic: provider_pending -> confirmed and the message marked approved, or
-- nothing. Uses the real delivery time against the persisted deadline (never
-- reset), refuses cancelled/refunding bookings, held refunds and races with
-- the timeout cancellation claim (which leaves provider_pending first).
create or replace function public.arvent_email_confirm(
  p_message_id uuid, p_booking_id uuid, p_provider_reference text,
  p_supplier_status integer, p_provider_response jsonb)
returns boolean language plpgsql security definer set search_path = public
as $$
declare w public.api_booking_workflows%rowtype; m public.arvent_email_messages%rowtype; moved int;
begin
  if p_supplier_status is null or p_supplier_status not in (0,1)
     or p_provider_response->>'status' is distinct from 'confirmed'
     or p_provider_response->>'terms_verified' is distinct from 'true'
     or p_provider_response->>'extras_verified' is distinct from 'true'
     or p_provider_response->>'needs_manual_review' is distinct from 'false'
     or p_provider_response->>'booking_reference' is distinct from p_provider_reference
     or p_provider_response#>>'{provider_payload,reservationStatusType}' is distinct from p_supplier_status::text
     or p_provider_response#>>'{email_confirmation,source}' is distinct from 'supplier_email_pdf'
     or p_provider_response#>>'{email_confirmation,message_id}' is distinct from p_message_id::text
  then return false; end if;

  select * into m from public.arvent_email_messages where id = p_message_id for update;
  if not found or m.verdict <> 'received' or m.reservation_number is distinct from p_provider_reference
     or m.pdf_sha256 is null or m.pdf_sha256 is distinct from p_provider_response#>>'{email_confirmation,pdf_sha256}'
  then return false; end if;

  select * into w from public.api_booking_workflows where booking_id = p_booking_id for update;
  if not found or w.state <> 'provider_pending' or w.provider_reference is distinct from p_provider_reference
     or w.paid_at is null or w.payment_intent is null
     or w.prepared_quote->>'provider' is distinct from 'arvent_kolaycar'
     or w.supplier_received_at is null or w.supplier_deadline_at is null
     or m.received_at > w.supplier_deadline_at
     or m.received_at < w.supplier_received_at - interval '1 minute'
  then return false; end if;
  if exists (select 1 from public.api_refund_holds h where h.booking_id = p_booking_id and h.released_at is null)
  then return false; end if;

  update public.api_booking_workflows
     set state = 'confirmed', last_error = null, updated_at = now(), provider_response = p_provider_response
   where booking_id = p_booking_id and state = 'provider_pending'
     and exists (select 1 from public.bookings b where b.id = p_booking_id
       and b.partner_id = 'bf29a373-c464-4cec-87a7-c3218ea1ea51'
       and b.status::text = 'pending' and b.api_booking_reference = p_provider_reference
       and b.cancelled_at is null and b.refund_status is null);
  get diagnostics moved = row_count;
  if moved <> 1 then return false; end if;

  update public.arvent_email_messages
     set verdict = 'approved', booking_id = p_booking_id, reasons = '{}', processed_at = now()
   where id = p_message_id;
  return true;
end $$;
revoke all on function public.arvent_email_confirm(uuid,uuid,text,integer,jsonb) from public, anon, authenticated;
grant execute on function public.arvent_email_confirm(uuid,uuid,text,integer,jsonb) to service_role;

-- Poll the Ride24 mailbox every minute (no webhook needed). The function
-- exits immediately when the mailbox secrets are not configured.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'ride24-arvent-mail-ingest';
    perform cron.schedule('ride24-arvent-mail-ingest', '* * * * *', $job$
      select net.http_post(
        url := 'https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/arvent-mail-ingest',
        headers := jsonb_build_object('Content-Type','application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                            where name = 'ride24_api_sync_cron_secret_20260806')),
        body := '{}'::jsonb, timeout_milliseconds := 55000);
    $job$);
  end if;
end $$;
