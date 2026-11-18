-- Ride24 registered-client moderation: reversible suspension and guarded deletion.
-- Existing customer accounts and booking records are not changed by this migration.

create table if not exists public.client_account_controls (
  client_id uuid primary key references public.profiles(id) on delete cascade,
  suspended_at timestamptz,
  suspended_by uuid,
  reason text,
  updated_at timestamptz not null default now(),
  constraint client_account_reason_size check (reason is null or length(reason) <= 500)
);
alter table public.client_account_controls enable row level security;
revoke all on public.client_account_controls from anon,authenticated;
grant select on public.client_account_controls to authenticated;
grant all on public.client_account_controls to service_role;
drop policy if exists client_controls_admin_read on public.client_account_controls;
create policy client_controls_admin_read
  on public.client_account_controls for select to authenticated using (public.is_admin());

create table if not exists public.client_account_moderation_log (
  id bigint generated always as identity primary key,
  client_id uuid not null,
  admin_id uuid,
  action text not null check (action in ('suspend','restore','delete')),
  reason text,
  created_at timestamptz not null default now()
);
alter table public.client_account_moderation_log enable row level security;
revoke all on public.client_account_moderation_log from anon,authenticated;
grant select on public.client_account_moderation_log to authenticated;
grant all on public.client_account_moderation_log to service_role;
drop policy if exists client_moderation_log_admin_read on public.client_account_moderation_log;
create policy client_moderation_log_admin_read
  on public.client_account_moderation_log for select to authenticated using (public.is_admin());

create or replace function public.block_suspended_client_new_booking()
returns trigger language plpgsql security definer set search_path=pg_catalog as $body$
begin
  if NEW.client_id is not null
     and (TG_OP='INSERT' or NEW.client_id is distinct from OLD.client_id)
     and exists (
       select 1 from public.client_account_controls c
       where c.client_id=NEW.client_id and c.suspended_at is not null
     ) then
    raise exception using errcode='42501', message='CLIENT_ACCOUNT_SUSPENDED';
  end if;
  return NEW;
end;
$body$;
revoke all on function public.block_suspended_client_new_booking() from public, anon, authenticated;
drop trigger if exists trg_block_suspended_client_booking on public.bookings;
create trigger trg_block_suspended_client_booking
  before insert or update of client_id on public.bookings
  for each row execute function public.block_suspended_client_new_booking();

create or replace function public.admin_client_delete_preflight(p_uid uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $body$
declare
  user_kind text;
  blockers text[] := array[]::text[];
begin
  if current_setting('role',true) is distinct from 'service_role' then
    raise exception using errcode='42501', message='SERVICE_ROLE_REQUIRED';
  end if;
  select role::text into user_kind from public.profiles where id=p_uid;
  if user_kind is distinct from 'client' then
    blockers:=array_append(blockers,'Usuwać można wyłącznie konta klientów, nie administratorów ani partnerów.');
  end if;
  if exists(select 1 from public.bookings where client_id=p_uid) then
    blockers:=array_append(blockers,'Klient ma historię rezerwacji. Można zawiesić konto; usuwanie wymaga osobnej procedury retencji danych.');
  end if;
  if exists(select 1 from public.booking_logs where changed_by=p_uid) then
    blockers:=array_append(blockers,'Konto występuje w historii operacji rezerwacyjnych.');
  end if;
  if exists(select 1 from public.social_connections where user_id=p_uid) then
    blockers:=array_append(blockers,'Konto ma aktywne powiązania z usługami społecznościowymi.');
  end if;
  if exists(select 1 from public.user_invoice_profiles where user_id=p_uid) then
    blockers:=array_append(blockers,'Konto ma zapisane dane rozliczeniowe wymagające odrębnej weryfikacji.');
  end if;
  if exists(select 1 from storage.objects where owner_id=p_uid::text) then
    blockers:=array_append(blockers,'Konto ma pliki w Supabase Storage.');
  end if;
  return jsonb_build_object('eligible',cardinality(blockers)=0,'blockers',to_jsonb(blockers),'role',user_kind);
end;
$body$;
revoke all on function public.admin_client_delete_preflight(uuid) from public,anon,authenticated;
grant execute on function public.admin_client_delete_preflight(uuid) to service_role;
