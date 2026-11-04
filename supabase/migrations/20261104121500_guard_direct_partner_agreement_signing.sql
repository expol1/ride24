-- Protect legal agreement fields from direct partner REST writes.
-- Admins and controlled SECURITY DEFINER signing RPCs retain their existing privileges.
create or replace function public.guard_direct_partner_agreement_mutation()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and not exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role = 'admin'
  ) then
    if new.agreement_accepted is distinct from old.agreement_accepted
       or new.agreement_accepted_at is distinct from old.agreement_accepted_at
       or new.agreement_snapshot is distinct from old.agreement_snapshot
       or new.agreement_version is distinct from old.agreement_version
       or new.agreement_ip is distinct from old.agreement_ip then
      raise exception 'AGREEMENT_REQUIRES_SERVER_SIGNING';
    end if;
    if old.agreement_accepted is distinct from true and
       (new.active is distinct from old.active or
        new.account_status is distinct from old.account_status) then
      raise exception 'PENDING_ACCOUNT_REQUIRES_SERVER_ACTIVATION';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_direct_partner_agreement_mutation() from public;
create trigger guard_direct_partner_agreement_mutation
before update on public.partners for each row
execute function public.guard_direct_partner_agreement_mutation();
