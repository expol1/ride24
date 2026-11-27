alter table public.arvent_manual_confirmations
  add column confirmation_source text check (confirmation_source in ('supplier_email_pdf','supplier_api')),
  add column pdf_sha256 text check (pdf_sha256 ~ '^[a-f0-9]{64}$');

create or replace function public.arvent_admin_confirm(
  p_booking_id uuid, p_provider_reference text, p_admin_user_id uuid, p_admin_email text,
  p_evidence text, p_supplier_status integer, p_supplier_evidence jsonb, p_provider_response jsonb)
returns boolean language plpgsql security definer set search_path = public
as $$
declare moved int;
begin
  if p_supplier_status is null or p_supplier_status not in (0,1)
     or p_provider_response->>'status' is distinct from 'confirmed'
     or p_provider_response->>'terms_verified' is distinct from 'true'
     or p_provider_response->>'extras_verified' is distinct from 'true'
     or p_provider_response->>'needs_manual_review' is distinct from 'false'
     or p_provider_response->>'booking_reference' is distinct from p_provider_reference
     or p_supplier_evidence->>'reservationStatusType' is distinct from p_supplier_status::text
     or p_supplier_evidence->>'reservationNumber' is distinct from p_provider_reference
     or (p_supplier_status = 0 and (
       p_provider_response#>>'{manual_confirmation,source}' is distinct from 'supplier_email_pdf'
       or p_provider_response#>>'{manual_confirmation,document_reference}' is distinct from p_provider_reference
       or p_provider_response#>>'{manual_confirmation,sender}' is distinct from 'info@arventcarrental.com'
       or coalesce(p_provider_response#>>'{manual_confirmation,pdf_sha256}', '') !~ '^[a-f0-9]{64}$'))
  then return false; end if;
  update public.api_booking_workflows
     set state = 'confirmed', last_error = null, updated_at = now(), provider_response = p_provider_response
   where booking_id = p_booking_id and state = 'provider_pending'
     and paid_at is not null and payment_intent is not null
     and supplier_deadline_at > clock_timestamp()
     and exists (select 1 from public.bookings b where b.id=p_booking_id
       and b.partner_id='bf29a373-c464-4cec-87a7-c3218ea1ea51'
       and b.status::text='pending' and b.api_booking_reference=p_provider_reference
       and b.cancelled_at is null and b.refund_status is null)
     and provider_reference = p_provider_reference
     and prepared_quote->>'provider' = 'arvent_kolaycar';
  get diagnostics moved = row_count;
  if moved <> 1 then return false; end if;
  insert into public.arvent_manual_confirmations(booking_id, provider_reference, admin_user_id,
    admin_email, evidence, supplier_status_type, supplier_evidence, confirmation_source, pdf_sha256)
  values (p_booking_id, p_provider_reference, p_admin_user_id, p_admin_email,
    p_evidence, p_supplier_status, p_supplier_evidence,
    case when p_supplier_status=0 then 'supplier_email_pdf' else 'supplier_api' end,
    case when p_supplier_status=0 then p_provider_response#>>'{manual_confirmation,pdf_sha256}' end);
  return true;
end $$;
