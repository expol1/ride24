-- CARAVEL SANDBOX ONLY — DRAFT. NOT EXECUTED IN SUPABASE.
-- Apply AFTER the base file caravel-sandbox-webhook-state.sql, never alone.
-- This delta adds durable gap recovery without rewriting existing Ride24 objects.
begin;

create table if not exists public.caravel_sbx_reconcile_jobs (
  job_id uuid primary key default gen_random_uuid(),
  trigger_event_id text not null unique
    references public.caravel_sbx_webhook_events(event_id),
  operator_id text not null,
  supplier_id text not null,
  since_at timestamptz not null,
  page_token text,
  seen_tokens text[] not null default array[]::text[],
  state text not null default 'pending'
    check (state in ('pending','running','done','error')),
  lease uuid,
  claimed_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 10000),
  processed_count bigint not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists caravel_sbx_reconcile_queue_idx
  on public.caravel_sbx_reconcile_jobs(state,created_at);
create index if not exists caravel_sbx_events_sequence_idx
  on public.caravel_sbx_webhook_events(operator_id,event_sequence)
  where state='done' and event_sequence is not null;
alter table public.caravel_sbx_reconcile_jobs enable row level security;
revoke all on public.caravel_sbx_reconcile_jobs from public, anon, authenticated;
grant select,insert,update,delete on public.caravel_sbx_reconcile_jobs to service_role;

-- An AFTER UPDATE trigger is part of the webhook-finalize transaction:
-- a completed webhook with a gap cannot be acknowledged without a queued job.
-- We compare to the latest PREVIOUS *processed* event in the operator stream.
create or replace function public.caravel_sbx_queue_sequence_gap()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare previous_sequence bigint; previous_at timestamptz;
begin
  if NEW.state<>'done' or OLD.state='done' or NEW.event_sequence is null
  then return NEW; end if;
  select event_sequence,occurred_at into previous_sequence,previous_at
  from public.caravel_sbx_webhook_events
  where operator_id=NEW.operator_id and state='done' and
    event_id<>NEW.event_id and event_sequence<NEW.event_sequence
  order by event_sequence desc limit 1;
  if found and NEW.event_sequence>previous_sequence+1 then
    insert into public.caravel_sbx_reconcile_jobs
      (trigger_event_id,operator_id,supplier_id,since_at)
    values (NEW.event_id,NEW.operator_id,NEW.supplier_id,
      greatest(timestamptz '2000-01-01 00:00:00+00',
        least(previous_at,NEW.occurred_at)-interval '5 minutes'))
    on conflict(trigger_event_id) do nothing;
  end if;
  return NEW;
end;
$$;
drop trigger if exists caravel_sbx_queue_gap_after_finalize
  on public.caravel_sbx_webhook_events;
create trigger caravel_sbx_queue_gap_after_finalize
after update of state on public.caravel_sbx_webhook_events
for each row when (new.state='done')
execute function public.caravel_sbx_queue_sequence_gap();

create or replace function public.caravel_sbx_reconcile_claim(p_lease uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare j public.caravel_sbx_reconcile_jobs%rowtype;
begin
  if p_lease is null then raise exception 'CARAVEL_RECONCILE_LEASE_REQUIRED'; end if;
  select * into j from public.caravel_sbx_reconcile_jobs
    where attempts<10 and
      (state='pending' or
       (state='running' and claimed_at<clock_timestamp()-interval '120 seconds'))
    order by created_at,job_id for update skip locked limit 1;
  if not found then return null; end if;
  update public.caravel_sbx_reconcile_jobs
    set state='running',lease=p_lease,claimed_at=clock_timestamp(),
        attempts=attempts+1,updated_at=clock_timestamp()
    where job_id=j.job_id;
  return jsonb_build_object('job_id',j.job_id,'operator_id',j.operator_id,
    'supplier_id',j.supplier_id,
    'since_at',to_char(j.since_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'page_token',j.page_token);
end;
$$;

-- Commit the entire re-fetched page and cursor atomically. A failed page must
-- be repeated (idempotent UPSERT, and old revisions never replace newer ones).
create or replace function public.caravel_sbx_reconcile_apply_page(
  p_job_id uuid,p_lease uuid,p_items jsonb,p_next_page text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  j public.caravel_sbx_reconcile_jobs%rowtype;
  item jsonb;
  bid text;
  brevision bigint;
  bstatus text;
  old_supplier text;
  applied_count integer:=0;
begin
  if p_job_id is null or p_lease is null or p_items is null or
     jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100
  then raise exception 'CARAVEL_RECONCILE_INVALID_PAGE'; end if;
  select * into j from public.caravel_sbx_reconcile_jobs
    where job_id=p_job_id and state='running' and lease=p_lease
    for update;
  if not found then raise exception 'CARAVEL_RECONCILE_LEASE_NOT_OWNED'; end if;

  if p_next_page is not null and
    (length(p_next_page) not between 1 and 2048 or
     p_next_page ~ '[[:cntrl:]]' or p_next_page=j.page_token or
     p_next_page=any(j.seen_tokens) or cardinality(j.seen_tokens)>=30)
  then raise exception 'CARAVEL_RECONCILE_CURSOR_INVALID'; end if;

  for item in select value from jsonb_array_elements(p_items) x(value) loop
    if jsonb_typeof(item)<>'object' then raise exception 'CARAVEL_RECONCILE_BAD_ITEM'; end if;
    bid:=item->>'booking_id';
    bstatus:=item->>'status';
    if bid is null or bid !~ '^[A-Za-z0-9_-]{1,128}$' or
       bstatus is null or bstatus !~ '^[a-z_]{1,64}$' or
       coalesce(item->>'revision','') !~ '^[0-9]{1,18}$'
    then raise exception 'CARAVEL_RECONCILE_BAD_ITEM'; end if;
    brevision:=(item->>'revision')::bigint;
    if brevision<1 then raise exception 'CARAVEL_RECONCILE_BAD_REVISION'; end if;

    select supplier_id into old_supplier
      from public.caravel_sbx_webhook_bookings
      where operator_id=j.operator_id and booking_id=bid for update;
    if found and old_supplier<>j.supplier_id
    then raise exception 'CARAVEL_RECONCILE_SUPPLIER_COLLISION'; end if;

    insert into public.caravel_sbx_webhook_bookings
      (operator_id,booking_id,supplier_id,last_revision,observed_status)
    values (j.operator_id,bid,j.supplier_id,brevision,bstatus)
    on conflict(operator_id,booking_id) do update
      set last_revision=excluded.last_revision,
          observed_status=excluded.observed_status,
          observed_at=clock_timestamp()
    where public.caravel_sbx_webhook_bookings.last_revision<excluded.last_revision;
    applied_count:=applied_count+1;
  end loop;

  update public.caravel_sbx_reconcile_jobs
    set state=case when p_next_page is null then 'done' else 'pending' end,
        lease=null,claimed_at=null,page_token=p_next_page,
        seen_tokens=case when j.page_token is null then j.seen_tokens
          else array_append(j.seen_tokens,j.page_token) end,
        processed_count=processed_count+applied_count,
        attempts=0, -- count failures per page, not successful pages across the job
        completed_at=case when p_next_page is null then clock_timestamp() else null end,
        updated_at=clock_timestamp()
    where job_id=j.job_id;
  return jsonb_build_object('accepted',true,'complete',p_next_page is null,
    'applied',applied_count);
end;
$$;

create or replace function public.caravel_sbx_reconcile_release(
  p_job_id uuid,p_lease uuid
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
begin
  update public.caravel_sbx_reconcile_jobs
  set state=case when attempts>=10 then 'error' else 'pending' end,
      lease=null,claimed_at=null,updated_at=clock_timestamp()
  where job_id=p_job_id and state='running' and lease=p_lease;
  return found;
end;
$$;

revoke all on function public.caravel_sbx_queue_sequence_gap() from public,anon,authenticated;
revoke all on function public.caravel_sbx_reconcile_claim(uuid) from public,anon,authenticated;
revoke all on function public.caravel_sbx_reconcile_apply_page(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.caravel_sbx_reconcile_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.caravel_sbx_queue_sequence_gap() to service_role;
grant execute on function public.caravel_sbx_reconcile_claim(uuid) to service_role;
grant execute on function public.caravel_sbx_reconcile_apply_page(uuid,uuid,jsonb,text) to service_role;
grant execute on function public.caravel_sbx_reconcile_release(uuid,uuid) to service_role;
commit;

-- IMPORTANT: These are proposed SQL changes only. Running the script does
-- not start a worker or a Caravel certification. An explicit schedule and
-- isolated Edge worker deployment are separate decisions.
