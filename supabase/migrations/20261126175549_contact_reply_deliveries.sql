create table public.contact_reply_deliveries (
  contact_id uuid not null references public.contact_messages(id) on delete cascade,
  fingerprint text not null,
  state text not null default 'pending' check (state in ('pending', 'sent')),
  created_at timestamptz not null default now(),
  primary key (contact_id, fingerprint)
);
alter table public.contact_reply_deliveries enable row level security;
revoke all on public.contact_reply_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.contact_reply_deliveries to service_role;
