-- One irreversible dispatch claim per Ride24 booking. Store a digest only.
create table public.arvent_dispatch_evidence (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  partner_id uuid not null references public.partners(id),
  agency_reference text not null,
  token_digest text not null check (token_digest ~ '^[0-9a-f]{64}$'),
  sipp text not null check (sipp ~ '^[A-Z]{4}$'),
  one_way_fee numeric(12,2) not null check (one_way_fee >= 0),
  extras jsonb not null check (jsonb_typeof(extras) = 'array'),
  attempted_at timestamptz not null default now(),
  unique (partner_id, agency_reference),
  unique (partner_id, token_digest)
);
alter table public.arvent_dispatch_evidence enable row level security;
revoke all on public.arvent_dispatch_evidence from public, anon, authenticated;
grant select, insert on public.arvent_dispatch_evidence to service_role;

create or replace function public.arvent_admin_confirm(
  p_booking_id uuid, p_provider_reference text, p_admin_user_id uuid, p_admin_email text,
  p_evidence text, p_supplier_status integer, p_supplier_evidence jsonb, p_provider_response jsonb)
returns boolean language plpgsql security definer set search_path = public
as $$
declare moved int;
begin
  if p_supplier_status is distinct from 1
     or p_provider_response->>'status' is distinct from 'confirmed'
     or p_provider_response->>'terms_verified' is distinct from 'true'
     or p_provider_response->>'extras_verified' is distinct from 'true'
     or p_provider_response->>'needs_manual_review' is distinct from 'false'
     or p_provider_response->>'booking_reference' is distinct from p_provider_reference
     or p_supplier_evidence->>'reservationStatusType' is distinct from '1'
  then return false; end if;
  update public.api_booking_workflows
     set state = 'confirmed', last_error = null, updated_at = now(), provider_response = p_provider_response
   where booking_id = p_booking_id and state = 'provider_pending'
     and provider_reference = p_provider_reference
     and prepared_quote->>'provider' = 'arvent_kolaycar';
  get diagnostics moved = row_count;
  if moved <> 1 then return false; end if;
  insert into public.arvent_manual_confirmations(booking_id, provider_reference, admin_user_id,
    admin_email, evidence, supplier_status_type, supplier_evidence)
  values (p_booking_id, p_provider_reference, p_admin_user_id, p_admin_email,
    p_evidence, p_supplier_status, p_supplier_evidence);
  return true;
end $$;
