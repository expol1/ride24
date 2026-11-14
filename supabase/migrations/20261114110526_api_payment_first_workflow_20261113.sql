-- Additive, API-only. No historic booking is migrated or deleted.
create table if not exists public.api_payment_settings (
 id boolean primary key default true check (id), enabled boolean not null default false
);
insert into public.api_payment_settings(id,enabled) values(true,false) on conflict do nothing;
alter table public.api_payment_settings enable row level security;
revoke all on public.api_payment_settings from public,anon,authenticated;
grant select,update on public.api_payment_settings to service_role;

create table if not exists public.api_booking_workflows (
 booking_id uuid primary key references public.bookings(id) on delete restrict,
 state text not null default 'awaiting_payment' check(state in
 ('awaiting_payment','paid','revalidating','dispatching','unknown','provider_pending','confirmed','refund_pending','refunding','refunded','refund_failed','abandoned')),
 stripe_session_id text unique, payment_intent text unique, stripe_event_id text,
 amount_cents bigint check(amount_cents>0), currency text check(currency='pln'),
 paid_at timestamptz, provider_reference text, provider_response jsonb,
 prepared_quote jsonb, last_error text, refund_id text unique, refund_status text,refund_started_at timestamptz,fulfilled_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.api_booking_workflows enable row level security;
revoke all on public.api_booking_workflows from public,anon,authenticated;
grant select,insert,update on public.api_booking_workflows to service_role;
create index if not exists api_booking_workflows_pending_idx on public.api_booking_workflows(updated_at)
 where state not in ('awaiting_payment','abandoned','refunded','refund_failed');

create or replace function public.api_record_verified_payment(p_booking_id uuid,p_session_id text,p_intent text,p_event_id text,p_amount bigint,p_currency text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare b public.bookings%rowtype; w public.api_booking_workflows%rowtype; target text;
begin
 insert into public.api_booking_workflows(booking_id) values(p_booking_id) on conflict do nothing;
 select * into w from public.api_booking_workflows where booking_id=p_booking_id for update;
 select * into b from public.bookings where id=p_booking_id for update;
 if b.provider_type is distinct from 'api' or b.stripe_session_id is distinct from p_session_id
   or p_amount is distinct from round(b.online_payment_pln*100)::bigint or p_currency is distinct from 'pln'
   or p_intent is null or p_event_id is null or p_session_id is null or p_amount is null or p_amount<=0
   or p_intent not like 'pi_%' or p_event_id not like 'evt_%' then raise exception 'API_PAYMENT_MISMATCH'; end if;
 if w.paid_at is not null then
   if w.stripe_session_id is distinct from p_session_id or w.payment_intent is distinct from p_intent then raise exception 'API_PAYMENT_CONFLICT'; end if;
   return to_jsonb(w);
 end if;
 target:=case when b.status::text in ('cancelled','rejected','expired','payment_expired') or b.cancelled_at is not null
   then case when b.api_booking_reference is null then 'refund_pending' else 'unknown' end
   when b.api_booking_reference is not null then 'provider_pending' else 'paid' end;
 update public.api_booking_workflows set state=target,stripe_session_id=p_session_id,payment_intent=p_intent,
   stripe_event_id=p_event_id,amount_cents=p_amount,currency=p_currency,paid_at=now(),updated_at=now(),provider_reference=b.api_booking_reference
 where booking_id=p_booking_id returning * into w;
 insert into public.payments(booking_id,stripe_session_id,amount,currency,status,provider)
 select p_booking_id,p_session_id,p_amount/100.0,p_currency,'paid','stripe'
 where not exists(select 1 from public.payments where stripe_session_id=p_session_id and booking_id=p_booking_id and status='paid');
 update public.bookings set payment_intent_id=p_intent,
   status=case when target in ('paid','provider_pending') then 'pending'::public.booking_status else status end,
   api_status='payment_'||target,partner_response_deadline=null,payment_deadline=null,expires_at=null
 where id=p_booking_id;
 return to_jsonb(w);
end $$;

create or replace function public.api_claim_paid_dispatch(p_booking_id uuid,p_prepared jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare w public.api_booking_workflows%rowtype; b public.bookings%rowtype;
begin
 select * into w from public.api_booking_workflows where booking_id=p_booking_id for update;
 if w.state is distinct from 'revalidating' or w.paid_at is null then return null; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if b.status::text <> 'pending' or b.cancelled_at is not null then
   update public.api_booking_workflows set state='refund_pending',last_error='CANCELLED_BEFORE_DISPATCH',updated_at=now() where booking_id=p_booking_id;
   return null;
 end if;
 update public.api_booking_workflows set state='dispatching',prepared_quote=p_prepared,updated_at=now()
 where booking_id=p_booking_id returning * into w;
 return to_jsonb(w);
end $$;

create or replace function public.api_finalize_confirmed(p_booking_id uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare w public.api_booking_workflows%rowtype; b public.bookings%rowtype;
begin
 select * into w from public.api_booking_workflows where booking_id=p_booking_id for update;
 if w.state is distinct from 'confirmed' or w.paid_at is null or w.provider_reference is null then return false; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if b.cancelled_at is not null or b.status::text in ('cancelled','rejected','expired','payment_expired') then
   update public.api_booking_workflows set state='unknown',last_error='CANCELLED_DURING_DISPATCH',updated_at=now() where booking_id=p_booking_id;
   update public.bookings set api_booking_reference=w.provider_reference,api_status='cancel_pending',manual_review=true where id=p_booking_id;
   return false;
 end if;
 update public.bookings set status='paid',api_status='confirmed',api_booking_reference=w.provider_reference,
   manual_review=false,api_response=w.provider_response,partner_response_deadline=null,expires_at=null
 where id=p_booking_id and status::text<>'paid';
 return true;
end $$;

revoke all on function public.api_record_verified_payment(uuid,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.api_claim_paid_dispatch(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.api_finalize_confirmed(uuid) from public,anon,authenticated;
grant execute on function public.api_record_verified_payment(uuid,text,text,text,bigint,text) to service_role;
grant execute on function public.api_claim_paid_dispatch(uuid,jsonb) to service_role;
grant execute on function public.api_finalize_confirmed(uuid) to service_role;

-- Defense in depth: no alternate webhook/RPC may publish an API confirmation.
create or replace function public.api_guard_confirmation() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.provider_type='api' and new.status::text='paid' and (tg_op='INSERT' or old.status::text is distinct from 'paid') then
   if not exists(select 1 from public.api_booking_workflows w where w.booking_id=new.id and w.state='confirmed'
     and w.paid_at is not null and w.provider_reference=new.api_booking_reference and new.api_status='confirmed') then
     raise exception 'API_CONFIRMATION_REQUIRED';
   end if;
 end if;
 return new;
end $$;
revoke all on function public.api_guard_confirmation() from public,anon,authenticated;
drop trigger if exists api_guard_confirmation on public.bookings;
create trigger api_guard_confirmation before insert or update on public.bookings for each row execute function public.api_guard_confirmation();

create or replace function public.api_cancel_unfulfilled(p_booking_id uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
declare w public.api_booking_workflows%rowtype; b public.bookings%rowtype;
begin
 insert into public.api_booking_workflows(booking_id) values(p_booking_id) on conflict do nothing;
 select * into w from public.api_booking_workflows where booking_id=p_booking_id for update;
 select * into b from public.bookings where id=p_booking_id for update;
 if b.provider_type is distinct from 'api' or w.paid_at is not null
   or w.state not in ('awaiting_payment','abandoned') or b.api_booking_reference is not null
   or b.status::text not in ('pending','awaiting_payment') then return false; end if;
 update public.bookings set status='cancelled',cancelled_at=now(),api_status='payment_cancelled',partner_response_deadline=null where id=p_booking_id;
 update public.api_booking_workflows set state=case
   when state in ('dispatching','unknown') then 'unknown'
   when paid_at is not null then 'refund_pending' else 'abandoned' end,
   last_error='CANCELLED_BEFORE_CONFIRMATION',updated_at=now() where booking_id=p_booking_id;
 return true;
end $$;
revoke all on function public.api_cancel_unfulfilled(uuid) from public,anon,authenticated;
grant execute on function public.api_cancel_unfulfilled(uuid) to service_role;

-- Signed webhook handler calls this only after retrieving the bound Stripe session.
create or replace function public.api_record_unpaid_session(p_booking_id uuid,p_session_id text,p_expired boolean)
returns boolean language plpgsql security invoker set search_path=public as $$
declare w public.api_booking_workflows%rowtype; b public.bookings%rowtype;
begin
 insert into public.api_booking_workflows(booking_id) values(p_booking_id) on conflict do nothing;
 select * into w from public.api_booking_workflows where booking_id=p_booking_id for update;
 select * into b from public.bookings where id=p_booking_id for update;
 if b.provider_type is distinct from 'api' or p_session_id is null or b.stripe_session_id is distinct from p_session_id then
   raise exception 'API_PAYMENT_MISMATCH'; end if;
 if w.paid_at is not null or w.state not in ('awaiting_payment','abandoned') then return false; end if;
 update public.api_booking_workflows set state=case when p_expired then 'abandoned' else state end,
 last_error=case when p_expired then 'CHECKOUT_EXPIRED' else 'PAYMENT_NOT_COMPLETED' end,updated_at=now() where booking_id=p_booking_id;
 update public.bookings set status=case when p_expired then 'payment_expired'::public.booking_status else status end,
 api_status=case when p_expired then 'payment_abandoned' else 'payment_awaiting_payment' end
 where id=p_booking_id and status::text='awaiting_payment';
 return true;
end $$;
revoke all on function public.api_record_unpaid_session(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.api_record_unpaid_session(uuid,text,boolean) to service_role;
