-- DRAFT ONLY. NOT EXECUTED. SANDBOX WEBHOOK CERTIFICATION STATE.
-- Review and apply explicitly only for the dedicated sandbox receiver.
-- No existing Ride24 tables, bookings, Stripe or AVIA objects are touched.
-- IMPORTANT: keep all three tables private with RLS and no anon/auth policies.
begin;

create table if not exists public.caravel_sbx_webhook_events (
  event_id text primary key,
  operator_id text not null,
  booking_id text not null,
  supplier_id text not null,
  event_revision bigint not null check (event_revision >= 1),
  event_sequence bigint check (event_sequence is null or event_sequence >= 1),
  occurred_at timestamptz not null,
  lease uuid not null,
  lease_started_at timestamptz not null default now(),
  attempt integer not null default 1 check (attempt between 1 and 10000),
  state text not null default 'processing' check (state in ('processing','done')),
  processed_at timestamptz
);
create table if not exists public.caravel_sbx_webhook_bookings (
  operator_id text not null,
  booking_id text not null,
  supplier_id text not null,
  last_revision bigint not null check(last_revision >= 1),
  observed_status text not null,
  observed_at timestamptz not null default now(),
  primary key (operator_id, booking_id)
);
create table if not exists public.caravel_sbx_webhook_streams (
  operator_id text primary key,
  last_sequence bigint not null check(last_sequence >= 1),
  last_occurred_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists caravel_sbx_webhook_event_state_idx
  on public.caravel_sbx_webhook_events(state,lease_started_at);

alter table public.caravel_sbx_webhook_events enable row level security;
alter table public.caravel_sbx_webhook_bookings enable row level security;
alter table public.caravel_sbx_webhook_streams enable row level security;
revoke all on public.caravel_sbx_webhook_events from public, anon, authenticated;
revoke all on public.caravel_sbx_webhook_bookings from public, anon, authenticated;
revoke all on public.caravel_sbx_webhook_streams from public, anon, authenticated;
grant select,insert,update,delete on public.caravel_sbx_webhook_events to service_role;
grant select,insert,update,delete on public.caravel_sbx_webhook_bookings to service_role;
grant select,insert,update,delete on public.caravel_sbx_webhook_streams to service_role;

-- All functions SECURITY INVOKER, and only service_role may execute.
-- Claims survive independently of any Edge instance (at-least-once delivery).
create or replace function public.caravel_sbx_webhook_claim(
  p_event_id text, p_operator_id text, p_booking_id text, p_supplier_id text,
  p_revision bigint, p_sequence bigint, p_occurred_at timestamptz, p_lease uuid
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare r public.caravel_sbx_webhook_events%rowtype;
begin
  if p_event_id is null or length(p_event_id)>128 or p_operator_id is null or length(p_operator_id)>128
     or p_booking_id is null or length(p_booking_id)>128 or p_supplier_id is null or length(p_supplier_id)>128
     or p_lease is null or p_revision is null or p_revision<1
     or p_sequence is not null and p_sequence<1 or p_occurred_at is null
  then raise exception 'CARAVEL_BAD_EVENT'; end if;

  insert into public.caravel_sbx_webhook_events
    (event_id,operator_id,booking_id,supplier_id,event_revision,event_sequence,occurred_at,lease)
  values (p_event_id,p_operator_id,p_booking_id,p_supplier_id,p_revision,p_sequence,p_occurred_at,p_lease)
  on conflict (event_id) do nothing;
  if found then return 'claimed'; end if;

  select * into r from public.caravel_sbx_webhook_events
  where event_id=p_event_id for update;
  if not found then raise exception 'CARAVEL_CLAIM_MISSING'; end if;
  if r.operator_id<>p_operator_id or r.booking_id<>p_booking_id or
     r.supplier_id<>p_supplier_id or r.event_revision<>p_revision
  then raise exception 'CARAVEL_EVENT_ID_COLLISION'; end if;

  if r.state='done' then return 'complete'; end if;
  if r.lease_started_at < clock_timestamp() - interval '120 seconds' then
    update public.caravel_sbx_webhook_events
    set lease=p_lease, lease_started_at=clock_timestamp(), attempt=attempt+1
    where event_id=p_event_id and state='processing' and attempt<10000;
    if found then return 'claimed'; end if;
  end if;
  return 'busy';
end;
$$;

-- Re-fetched Caravel status is committed ONLY if newer than the stored revision.
-- A past event can still be recorded as done without rolling state backwards.
create or replace function public.caravel_sbx_webhook_finalize(
  p_event_id text, p_lease uuid, p_fetched_revision bigint, p_fetched_status text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  r public.caravel_sbx_webhook_events%rowtype;
  previous_revision bigint;
  prior_sequence bigint;
  outcome text := 'applied';
  gap boolean := false;
begin
  if p_lease is null or p_fetched_revision is null or p_fetched_revision<1
     or p_fetched_status is null or length(p_fetched_status) not between 1 and 64
  then raise exception 'CARAVEL_FINALIZE_BAD_INPUT'; end if;

  select * into r from public.caravel_sbx_webhook_events
    where event_id=p_event_id and state='processing' and lease=p_lease for update;
  if not found then raise exception 'CARAVEL_LEASE_NOT_OWNED'; end if;
  if p_fetched_revision < r.event_revision then raise exception 'CARAVEL_REFETCH_BEHIND_EVENT'; end if;

  select last_revision into previous_revision from public.caravel_sbx_webhook_bookings
    where operator_id=r.operator_id and booking_id=r.booking_id for update;
  if not found then
    insert into public.caravel_sbx_webhook_bookings
      (operator_id,booking_id,supplier_id,last_revision,observed_status)
    values (r.operator_id,r.booking_id,r.supplier_id,p_fetched_revision,p_fetched_status);
  elsif p_fetched_revision > previous_revision then
    update public.caravel_sbx_webhook_bookings
    set last_revision=p_fetched_revision, observed_status=p_fetched_status,
      observed_at=clock_timestamp()
    where operator_id=r.operator_id and booking_id=r.booking_id;
  else
    outcome := 'stale';
  end if;

  if r.event_sequence is not null then
    select last_sequence into prior_sequence from public.caravel_sbx_webhook_streams
      where operator_id=r.operator_id for update;
    if not found then
      insert into public.caravel_sbx_webhook_streams
        (operator_id,last_sequence,last_occurred_at)
      values (r.operator_id,r.event_sequence,r.occurred_at);
    else
      gap := r.event_sequence > prior_sequence + 1;
      update public.caravel_sbx_webhook_streams
      set last_sequence=greatest(last_sequence,r.event_sequence),
        last_occurred_at=greatest(last_occurred_at,r.occurred_at),
        updated_at=clock_timestamp()
      where operator_id=r.operator_id;
    end if;
  end if;

  update public.caravel_sbx_webhook_events
  set state='done', processed_at=clock_timestamp()
  where event_id=p_event_id and lease=p_lease;
  return jsonb_build_object('outcome',outcome,'sequence_gap',gap);
end;
$$;

-- Release only an unfinished claim owned by the caller. A failed GET/DB write
-- must cause non-2xx so that Caravel retries the same signed event.
create or replace function public.caravel_sbx_webhook_release(
  p_event_id text, p_lease uuid
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
begin
  delete from public.caravel_sbx_webhook_events
  where event_id=p_event_id and lease=p_lease and state='processing';
  return found;
end;
$$;

revoke all on function public.caravel_sbx_webhook_claim(text,text,text,text,bigint,bigint,timestamptz,uuid) from public, anon, authenticated;
revoke all on function public.caravel_sbx_webhook_finalize(text,uuid,bigint,text) from public, anon, authenticated;
revoke all on function public.caravel_sbx_webhook_release(text,uuid) from public, anon, authenticated;
grant execute on function public.caravel_sbx_webhook_claim(text,text,text,text,bigint,bigint,timestamptz,uuid) to service_role;
grant execute on function public.caravel_sbx_webhook_finalize(text,uuid,bigint,text) to service_role;
grant execute on function public.caravel_sbx_webhook_release(text,uuid) to service_role;

commit;

-- IMPORTANT: This state is sandbox telemetry only; a separate reconciliation
-- service must consume sequence_gap and compare GET /v1/bookings?updated_since.
-- Do NOT treat this as a production webhook integration or a certification pass.
