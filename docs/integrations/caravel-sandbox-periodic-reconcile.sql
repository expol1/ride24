-- CARAVEL SANDBOX ONLY — REVIEW DRAFT. NOT EXECUTED.
-- Apply after caravel-sandbox-webhook-state.sql (for optional comparison).
-- Does not mutate any Ride24 booking, AVIA, Stripe, customer or partner table.
begin;

create table if not exists public.caravel_sbx_periodic_scans (
  supplier_id text primary key check(supplier_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  state text not null default 'idle' check(state in ('idle','pending','running','error')),
  watermark_at timestamptz, -- only moves after ALL pages finish
  scan_from timestamptz,
  scan_to timestamptz,
  page_token text,
  seen_tokens text[] not null default array[]::text[],
  pages_completed integer not null default 0,
  lease uuid,
  lease_started_at timestamptz,
  attempts integer not null default 0,
  last_completed_at timestamptz,
  last_attempt_at timestamptz,
  error_at timestamptz
);

create table if not exists public.caravel_sbx_periodic_observations (
  supplier_id text not null references public.caravel_sbx_periodic_scans(supplier_id),
  booking_id text not null check(booking_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  last_revision bigint not null check(last_revision>=1),
  last_status text not null check(last_status ~ '^[a-z_]{1,64}$'),
  observed_at timestamptz not null default now(),
  -- Advisory only: may be true while a webhook is still in flight.
  webhook_missing_or_behind boolean not null default false,
  primary key(supplier_id,booking_id)
);

alter table public.caravel_sbx_periodic_scans enable row level security;
alter table public.caravel_sbx_periodic_observations enable row level security;
revoke all on public.caravel_sbx_periodic_scans from public,anon,authenticated;
revoke all on public.caravel_sbx_periodic_observations from public,anon,authenticated;
grant select,insert,update,delete on public.caravel_sbx_periodic_scans to service_role;
grant select,insert,update,delete on public.caravel_sbx_periodic_observations to service_role;

-- Register only suppliers freshly returned by the Caravel sandbox API.
-- Existing successful watermarks are never reset on re-registration.
create or replace function public.caravel_sbx_periodic_register(p_suppliers text[])
returns integer
language plpgsql security invoker set search_path=''
as $$
declare
  sid text;
  added integer:=0;
begin
  if p_suppliers is null or cardinality(p_suppliers) not between 1 and 10 then
    raise exception 'CARAVEL_PERIODIC_SUPPLIERS_INVALID';
  end if;
  foreach sid in array p_suppliers loop
    if sid is null or sid !~ '^[A-Za-z0-9_-]{1,128}$' then
      raise exception 'CARAVEL_PERIODIC_SUPPLIER_INVALID';
    end if;
    insert into public.caravel_sbx_periodic_scans(supplier_id) values(sid)
      on conflict(supplier_id) do nothing;
    if found then added:=added+1; end if;
  end loop;
  return added;
end;
$$;

-- One atomic lease per supplier. Regular scans run no more frequently than
-- every five minutes. First scan covers previous 24h, then overlaps 5 min.
-- No pagination cursor or watermark may advance on a failed attempt.
create or replace function public.caravel_sbx_periodic_claim(p_lease uuid)
returns jsonb
language plpgsql security invoker set search_path=''
as $$
declare
  s public.caravel_sbx_periodic_scans%rowtype;
  clock_at timestamptz:=clock_timestamp();
  from_at timestamptz;
  to_at timestamptz;
  cursor text;
begin
  if p_lease is null then raise exception 'CARAVEL_PERIODIC_LEASE_REQUIRED'; end if;
  select * into s from public.caravel_sbx_periodic_scans
  where attempts<10 and
    ((state='pending') or
     (state='running' and lease_started_at < clock_at-interval '120 seconds') or
     (state='idle' and
       (last_completed_at is null or last_completed_at<=clock_at-interval '5 minutes')))
  order by case when state='pending' then 0 when state='running' then 1 else 2 end,
    coalesce(last_attempt_at,timestamptz '2000-01-01 00:00:00+00'),supplier_id
  for update skip locked limit 1;
  if not found then return null; end if;
  if s.state='idle' then
    from_at:=case when s.watermark_at is null then clock_at-interval '24 hours'
      else s.watermark_at-interval '5 minutes' end;
    to_at:=clock_at;
    cursor:=null;
    update public.caravel_sbx_periodic_scans
    set state='running',scan_from=from_at,scan_to=to_at,
      page_token=null,seen_tokens=array[]::text[],pages_completed=0,
      lease=p_lease,lease_started_at=clock_at,
      attempts=1,last_attempt_at=clock_at,error_at=null
    where supplier_id=s.supplier_id;
  else
    from_at:=s.scan_from;to_at:=s.scan_to;cursor:=s.page_token;
    if from_at is null or to_at is null then raise exception 'CARAVEL_PERIODIC_CHECKPOINT_MISSING'; end if;
    update public.caravel_sbx_periodic_scans
    set state='running',lease=p_lease,lease_started_at=clock_at,
      attempts=attempts+1,last_attempt_at=clock_at
    where supplier_id=s.supplier_id;
  end if;
  return jsonb_build_object(
    'supplier_id',s.supplier_id,'scan_from',to_char(from_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'scan_to',to_char(to_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'page_token',cursor
  );
end;
$$;

-- Monotonic DB update + cursor checkpoint in ONE transaction. Only provider
-- booking IDs, revisions and status are stored; customer PII is discarded.
create or replace function public.caravel_sbx_periodic_commit(
  p_supplier_id text,p_lease uuid,p_items jsonb,p_next_page text
) returns jsonb
language plpgsql security invoker set search_path=''
as $$
declare
  s public.caravel_sbx_periodic_scans%rowtype;
  entry jsonb;
  bid text;
  brevision bigint;
  bstatus text;
  behind boolean;
  n integer:=0;
  changed integer:=0;
begin
  if p_supplier_id is null or p_lease is null or p_items is null or
     jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100
  then raise exception 'CARAVEL_PERIODIC_BAD_PAGE'; end if;

  select * into s from public.caravel_sbx_periodic_scans
  where supplier_id=p_supplier_id and state='running' and lease=p_lease for update;
  if not found then raise exception 'CARAVEL_PERIODIC_LEASE_NOT_OWNED'; end if;
  if p_next_page is not null and
    (length(p_next_page) not between 1 and 2048 or p_next_page ~ '[[:cntrl:]]' or
     p_next_page=s.page_token or p_next_page=any(s.seen_tokens) or
     s.pages_completed>=29)
  then raise exception 'CARAVEL_PERIODIC_CURSOR_INVALID'; end if;

  for entry in select value from jsonb_array_elements(p_items) as x(value) loop
    if jsonb_typeof(entry)<>'object' then raise exception 'CARAVEL_PERIODIC_BAD_ITEM'; end if;
    bid:=entry->>'booking_id';
    bstatus:=entry->>'status';
    if bid is null or bid !~ '^[A-Za-z0-9_-]{1,128}$' or
       bstatus is null or bstatus !~ '^[a-z_]{1,64}$' or
       coalesce(entry->>'revision','') !~ '^[0-9]{1,15}$'
    then raise exception 'CARAVEL_PERIODIC_BAD_ITEM'; end if;
    brevision:=(entry->>'revision')::bigint;
    if brevision<1 then raise exception 'CARAVEL_PERIODIC_BAD_REVISION'; end if;

    -- Gap detection against the independent webhook state is *advisory*.
    -- An event may still be in transit. Do not mutate webhook records here.
    select not exists (
      select 1 from public.caravel_sbx_webhook_bookings wb
      where wb.supplier_id=p_supplier_id and wb.booking_id=bid
        and wb.last_revision>=brevision
    ) into behind;

    insert into public.caravel_sbx_periodic_observations(
      supplier_id,booking_id,last_revision,last_status,observed_at,webhook_missing_or_behind)
    values(p_supplier_id,bid,brevision,bstatus,clock_timestamp(),behind)
    on conflict(supplier_id,booking_id) do update
      set last_revision=greatest(public.caravel_sbx_periodic_observations.last_revision,excluded.last_revision),
          last_status=case when excluded.last_revision>public.caravel_sbx_periodic_observations.last_revision
            then excluded.last_status else public.caravel_sbx_periodic_observations.last_status end,
          observed_at=clock_timestamp(),
          webhook_missing_or_behind=excluded.webhook_missing_or_behind;
    n:=n+1;
    if behind then changed:=changed+1; end if;
  end loop;

  update public.caravel_sbx_periodic_scans
    set state=case when p_next_page is null then 'idle' else 'pending' end,
      watermark_at=case when p_next_page is null then s.scan_to else watermark_at end,
      last_completed_at=case when p_next_page is null then clock_timestamp() else last_completed_at end,
      scan_from=case when p_next_page is null then null else scan_from end,
      scan_to=case when p_next_page is null then null else scan_to end,
      page_token=p_next_page,
      seen_tokens=case when p_next_page is null then array[]::text[]
        when s.page_token is null then s.seen_tokens
        else array_append(s.seen_tokens,s.page_token) end,
      pages_completed=case when p_next_page is null then 0 else s.pages_completed+1 end,
      attempts=0,lease=null,lease_started_at=null
    where supplier_id=p_supplier_id;
  return jsonb_build_object('accepted',true,'complete',p_next_page is null,
    'changed',changed,'processed',n);
end;
$$;

create or replace function public.caravel_sbx_periodic_release(
  p_supplier_id text,p_lease uuid
) returns boolean
language plpgsql security invoker set search_path=''
as $$
begin
  update public.caravel_sbx_periodic_scans
    set state=case when attempts>=10 then 'error' else 'pending' end,
      error_at=case when attempts>=10 then clock_timestamp() else error_at end,
      lease=null,lease_started_at=null
    where supplier_id=p_supplier_id and state='running' and lease=p_lease;
  return found;
end;
$$;

revoke all on function public.caravel_sbx_periodic_register(text[]) from public,anon,authenticated;
revoke all on function public.caravel_sbx_periodic_claim(uuid) from public,anon,authenticated;
revoke all on function public.caravel_sbx_periodic_commit(text,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.caravel_sbx_periodic_release(text,uuid) from public,anon,authenticated;
grant execute on function public.caravel_sbx_periodic_register(text[]) to service_role;
grant execute on function public.caravel_sbx_periodic_claim(uuid) to service_role;
grant execute on function public.caravel_sbx_periodic_commit(text,uuid,jsonb,text) to service_role;
grant execute on function public.caravel_sbx_periodic_release(text,uuid) to service_role;
commit;

-- No cron, pg_net or Edge Function deployed by this SQL.
-- AFTER applying, test with service_role and ensure anon/authenticated have
-- no SELECT/INSERT/UPDATE/DELETE or EXECUTE privileges before enabling.
