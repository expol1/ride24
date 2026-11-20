-- Audit trail for Arvent bookings confirmed by a Ride24 admin after an
-- explicit confirmation from Arvent while its API still showed status 0.
-- Written only through arvent_admin_confirm() by the arvent-admin-confirm
-- edge function (service role), together with the workflow transition.
create table if not exists public.arvent_manual_confirmations (
  booking_id uuid primary key references public.bookings(id),
  provider_reference text not null,
  admin_user_id uuid not null,
  admin_email text,
  evidence text not null check (char_length(evidence) between 15 and 1000),
  supplier_status_type integer not null check (supplier_status_type in (0, 1)),
  supplier_evidence jsonb,
  created_at timestamptz not null default now()
);
alter table public.arvent_manual_confirmations enable row level security;
revoke all on public.arvent_manual_confirmations from anon, authenticated;
drop policy if exists arvent_manual_confirmations_admin_read on public.arvent_manual_confirmations;
create policy arvent_manual_confirmations_admin_read on public.arvent_manual_confirmations
  for select to authenticated using (public.is_admin());
grant select on public.arvent_manual_confirmations to authenticated;

-- Atomic: provider_pending -> confirmed AND the audit row, or nothing.
create or replace function public.arvent_admin_confirm(
  p_booking_id uuid, p_provider_reference text, p_admin_user_id uuid, p_admin_email text,
  p_evidence text, p_supplier_status integer, p_supplier_evidence jsonb, p_provider_response jsonb)
returns boolean language plpgsql security definer set search_path = public
as $$
declare moved int;
begin
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
revoke all on function public.arvent_admin_confirm(uuid,text,uuid,text,text,integer,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.arvent_admin_confirm(uuid,text,uuid,text,text,integer,jsonb,jsonb) to service_role;
