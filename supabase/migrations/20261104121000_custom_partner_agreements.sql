-- Optional, administrator-approved PDF agreement per partner.
-- No entry here => existing HTML agreement generation remains unchanged.
-- The source PDF is PRIVATE; after signing, neither the metadata nor the signed file
-- may be changed or deleted through the usual admin/storage endpoints.

create table if not exists public.partner_agreement_documents (
  partner_id uuid primary key references public.partners(id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now(),
  constraint partner_agreement_path_valid check (storage_path ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.pdf$'),
  constraint partner_agreement_filename_valid check (length(original_filename) between 5 and 160)
);
alter table public.partner_agreement_documents enable row level security;
revoke all on public.partner_agreement_documents from public, anon, authenticated;
grant select on public.partner_agreement_documents to authenticated;

create policy partner_agreement_documents_read
on public.partner_agreement_documents for select to authenticated
using (
  exists (select 1 from public.partners p
          where p.id = partner_id and p.user_id = (select auth.uid()))
  or exists (select 1 from public.profiles profile
             where profile.id = (select auth.uid()) and profile.role = 'admin')
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('partner-agreements', 'partner-agreements', false, 5242880, array['application/pdf']::text[])
on conflict (id) do nothing;

-- Partner can download only their own assigned PDF. Admins can review it.
-- No authenticated storage INSERT/UPDATE/DELETE policy is added.
create policy partner_agreement_pdf_private_read
on storage.objects for select to authenticated
using (
  bucket_id = 'partner-agreements'
  and (
    exists (
      select 1 from public.partner_agreement_documents d
      join public.partners p on p.id = d.partner_id
      where d.storage_path = storage.objects.name and p.user_id = (select auth.uid())
    )
    or exists (
      select 1 from public.profiles profile
      where profile.id = (select auth.uid()) and profile.role = 'admin'
    )
  )
);

-- Serialize uploads/removals with signing to prevent a signed standard agreement
-- from being silently replaced by a custom PDF during a race.
create or replace function public.guard_partner_agreement_document_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_signed boolean;
begin
  if tg_op = 'UPDATE' then
    raise exception 'CUSTOM_AGREEMENT_IMMUTABLE';
  end if;
  select p.agreement_accepted into v_signed
  from public.partners p
  where p.id = case when tg_op = 'DELETE' then old.partner_id else new.partner_id end
  for update;
  if not found then raise exception 'PARTNER_NOT_FOUND'; end if;
  if coalesce(v_signed, false) then raise exception 'SIGNED_AGREEMENT_IMMUTABLE'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

revoke all on function public.guard_partner_agreement_document_change() from public;
create trigger guard_partner_custom_pdf
before insert or update or delete on public.partner_agreement_documents
for each row execute function public.guard_partner_agreement_document_change();

-- Even an admin with an existing broad storage-delete rule cannot silently
-- erase a PDF after the partner has signed that exact document.
create or replace function public.guard_signed_agreement_pdf_storage()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.bucket_id = 'partner-agreements' and exists (
    select 1 from public.partner_agreement_documents d
    join public.partners p on p.id = d.partner_id
    where d.storage_path = old.name and p.agreement_accepted = true
  ) then
    raise exception 'SIGNED_AGREEMENT_PDF_CANNOT_BE_DELETED';
  end if;
  return old;
end $$;

revoke all on function public.guard_signed_agreement_pdf_storage() from public;
create trigger protect_signed_partner_pdf_in_storage
before delete on storage.objects
for each row execute function public.guard_signed_agreement_pdf_storage();

-- Keep the current standard contract mechanism, but fail closed when the
-- administrator assigned a custom PDF. The partner may never choose between
-- two different documents at signing time.
create or replace function public.partner_accept_agreement(
  p_version text, p_snapshot text, p_ip text
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_partner_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'AUTH_REQUIRED'; end if;
  if length(coalesce(p_snapshot,'')) < 50 then raise exception 'INVALID_AGREEMENT_SNAPSHOT'; end if;
  select p.id into v_partner_id from public.partners p
  where p.user_id = (select auth.uid()) for update;
  if not found then raise exception 'AGREEMENT_NOT_AVAILABLE'; end if;
  if exists (select 1 from public.partner_agreement_documents d
             where d.partner_id = v_partner_id) then
    raise exception 'CUSTOM_AGREEMENT_ASSIGNED';
  end if;
  update public.partners
  set agreement_accepted = true, agreement_accepted_at = now(),
      agreement_version = left(coalesce(p_version,'v1.1'),30),
      agreement_snapshot = p_snapshot, agreement_ip = left(coalesce(p_ip,''),100),
      profile_completed = true, active = true, account_status = 'active'
  where id = v_partner_id and agreement_accepted = false
    and profile_completed = true
    and rental_terms_url is not null and rental_rules_url is not null;
  if not found then raise exception 'AGREEMENT_NOT_AVAILABLE'; end if;
  return true;
end $$;

-- For a custom document the signed record is assembled SERVER-SIDE, using the
-- stored file checksum, never an HTML snapshot supplied by the browser.
create or replace function public.partner_accept_custom_agreement(
  p_sha256 text, p_ip text
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_partner public.partners%rowtype;
  v_doc public.partner_agreement_documents%rowtype;
  v_time timestamptz := clock_timestamp();
begin
  if (select auth.uid()) is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_partner from public.partners p
  where p.user_id = (select auth.uid()) for update;
  if not found then raise exception 'AGREEMENT_NOT_AVAILABLE'; end if;
  if v_partner.agreement_accepted is distinct from false
     or v_partner.profile_completed is distinct from true
     or v_partner.rental_terms_url is null
     or v_partner.rental_rules_url is null then
    raise exception 'AGREEMENT_NOT_AVAILABLE';
  end if;
  select * into v_doc from public.partner_agreement_documents d
  where d.partner_id = v_partner.id;
  if not found or v_doc.sha256 <> lower(coalesce(p_sha256,'')) then
    raise exception 'CUSTOM_AGREEMENT_VERSION_MISMATCH';
  end if;
  update public.partners set
    agreement_accepted = true, agreement_accepted_at = v_time,
    agreement_version = 'custom_pdf_v1',
    agreement_snapshot = jsonb_build_object(
      'version','custom_pdf_v1',
      'source','custom_pdf',
      'partner_id',v_partner.id,
      'sha256',v_doc.sha256,
      'filename',v_doc.original_filename,
      'signed_at',v_time
    )::text,
    agreement_ip = left(coalesce(p_ip,''),100),
    profile_completed = true, active = true, account_status = 'active'
  where id = v_partner.id and agreement_accepted = false;
  if not found then raise exception 'AGREEMENT_NOT_AVAILABLE'; end if;
  return true;
end $$;

revoke all on function public.partner_accept_custom_agreement(text,text) from public, anon;
grant execute on function public.partner_accept_custom_agreement(text,text) to authenticated;

comment on table public.partner_agreement_documents is
'Optional administrator-uploaded private agreement PDFs. No row means standard agreement; signed documents are immutable.';
