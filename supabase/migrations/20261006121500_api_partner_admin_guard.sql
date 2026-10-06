-- Keep API-managed technical/commercial data under Ride24 Admin control
-- without changing LOCAL partner CRUD behavior.

create or replace function public.guard_api_partner_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' or public.is_admin() then
    return new;
  end if;

  if coalesce(old.provider_type, 'local') = 'api' and (
       new.provider_type is distinct from old.provider_type
    or new.api_provider is distinct from old.api_provider
    or new.api_enabled is distinct from old.api_enabled
    or new.api_status is distinct from old.api_status
    or new.api_settings is distinct from old.api_settings
    or new.discount_percent is distinct from old.discount_percent
    or new.commission is distinct from old.commission
    or new.currency is distinct from old.currency
  ) then
    raise exception 'API partner technical and commercial fields are managed by Ride24 Admin';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_api_partner_admin_fields() from public;
revoke all on function public.guard_api_partner_admin_fields() from anon;
revoke all on function public.guard_api_partner_admin_fields() from authenticated;

drop trigger if exists trg_guard_api_partner_admin_fields on public.partners;
create trigger trg_guard_api_partner_admin_fields
before update on public.partners
for each row
execute function public.guard_api_partner_admin_fields();

-- Existing LOCAL partners keep the same write access. API-managed rows become
-- read-only for the Partner account; service-role synchronization remains able
-- to insert/update them.

drop policy if exists "Partner manages own cars" on public.car_classes;

drop policy if exists "Partner reads own cars" on public.car_classes;
create policy "Partner reads own cars"
on public.car_classes
for select
to authenticated
using (
  partner_id in (
    select p.id from public.partners p where p.user_id = auth.uid()
  )
);

drop policy if exists "Partner inserts own non API cars" on public.car_classes;
create policy "Partner inserts own non API cars"
on public.car_classes
for insert
to authenticated
with check (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
);

drop policy if exists "Partner updates own non API cars" on public.car_classes;
create policy "Partner updates own non API cars"
on public.car_classes
for update
to authenticated
using (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
)
with check (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
);

drop policy if exists "Partner deletes own non API cars" on public.car_classes;
create policy "Partner deletes own non API cars"
on public.car_classes
for delete
to authenticated
using (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
);

drop policy if exists "Partner manages own locations" on public.partner_locations;

drop policy if exists "Partner reads own locations" on public.partner_locations;
create policy "Partner reads own locations"
on public.partner_locations
for select
to authenticated
using (
  partner_id in (
    select p.id from public.partners p where p.user_id = auth.uid()
  )
);

drop policy if exists "Partner inserts own non API locations" on public.partner_locations;
create policy "Partner inserts own non API locations"
on public.partner_locations
for insert
to authenticated
with check (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
);

drop policy if exists "Partner updates own non API locations" on public.partner_locations;
create policy "Partner updates own non API locations"
on public.partner_locations
for update
to authenticated
using (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
)
with check (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
);

drop policy if exists "Partner deletes own non API locations" on public.partner_locations;
create policy "Partner deletes own non API locations"
on public.partner_locations
for delete
to authenticated
using (
  coalesce(is_api_managed, false) = false
  and partner_id in (
    select p.id
    from public.partners p
    where p.user_id = auth.uid()
      and coalesce(p.provider_type, 'local') <> 'api'
  )
);
