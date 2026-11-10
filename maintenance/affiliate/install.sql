-- Additive pilot. No triggers, cron, extensions, new cloud functions or booking mutations.
begin;
create schema if not exists ride24_affiliate;
revoke all on schema ride24_affiliate from public, anon;
grant usage on schema ride24_affiliate to authenticated;
create table ride24_affiliate.settings (id boolean primary key default true check(id), enabled boolean not null default false);
insert into ride24_affiliate.settings values(true,false);
create table ride24_affiliate.partners (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 2 and 150),
 email text not null check(length(email) between 3 and 254), code text unique not null check(code ~ '^[A-Z0-9]{6,24}$'),
 active boolean not null default true, created_at timestamptz not null default now()
);
create table ride24_affiliate.payouts (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references ride24_affiliate.partners(id),
 amount_pln numeric(12,2) not null check(amount_pln>=100), reference text not null check(length(reference) between 3 and 200),
 created_at timestamptz not null default now(), created_by uuid not null,
 unique(partner_id,reference)
);
create table ride24_affiliate.referrals (
 id uuid primary key default gen_random_uuid(), booking_id uuid unique references public.bookings(id) on delete set null,
 partner_id uuid not null references ride24_affiliate.partners(id), booking_code text not null,
 rate numeric(4,3) not null default .100 check(rate=.100), created_at timestamptz not null default now(),
 decision text not null default 'pending' check(decision in ('pending','approved','rejected')),
 approved_amount numeric(12,2), reviewed_by uuid, reviewed_at timestamptz, review_note text,
 payout_id uuid references ride24_affiliate.payouts(id)
);
create index if not exists ride24_affiliate_payments_booking_idx on public.payments(booking_id);
create index on ride24_affiliate.referrals(partner_id);
create index on ride24_affiliate.referrals(payout_id);
create index on ride24_affiliate.payouts(partner_id);
alter table ride24_affiliate.settings enable row level security;
alter table ride24_affiliate.partners enable row level security;
alter table ride24_affiliate.referrals enable row level security;
alter table ride24_affiliate.payouts enable row level security;
revoke all on all tables in schema ride24_affiliate from public,anon,authenticated;
-- Internal computation only: actual paid PLN amount, after loyalty discounts.
create function ride24_affiliate.evaluation(p_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare r record; b record; p record; reason text; amount numeric; state text;
begin
 select * into r from ride24_affiliate.referrals where id=p_id;
 if not found then raise exception 'REFERRAL_NOT_FOUND'; end if;
 select * into b from public.bookings where id=r.booking_id;
 if not found then reason:='booking_deleted';
 elsif b.status::text in ('cancelled','rejected','expired','payment_expired') or b.cancelled_at is not null then reason:='cancelled_or_closed';
 elsif b.manual_review is true or b.refund_status is not null or coalesce(b.refund_amount_pln,0)>0 or coalesce(b.refund_amount,0)>0 then reason:='manual_review_or_refund';
 elsif b.status::text<>'paid' then reason:='awaiting_payment';
 else
   select count(distinct pay.stripe_session_id) as sessions, count(*) as rows,
     min(pay.amount) as minimum, max(pay.amount) as maximum,
     bool_and(coalesce(lower(pay.currency)='pln' and pay.status='paid' and pay.amount>0 and pay.stripe_session_id=b.stripe_session_id,false)) as valid
   into p from public.payments pay where pay.booking_id=b.id;
   if p.rows=0 or p.sessions<>1 or p.valid is distinct from true or p.minimum is distinct from p.maximum
      or p.minimum<=0 or abs(p.minimum-coalesce(b.online_payment_pln,0))>.01 then reason:='payment_verification';
   else amount:=round(p.minimum*r.rate,2); end if;
 end if;
 if r.payout_id is not null then
   state:=case when reason is not null or r.decision='rejected' or r.approved_amount is distinct from amount then 'correction_required' else 'paid_out' end;
 elsif r.decision='rejected' or reason in ('booking_deleted','cancelled_or_closed') then state:='rejected';
 elsif reason is not null then state:=case when reason='awaiting_payment' then 'awaiting_payment' else 'held' end;
 elsif r.decision='approved' and r.approved_amount=amount and b.end_date<current_date then state:='approved';
 elsif b.end_date<current_date then state:='review';
 else state:='pending'; end if;
 return jsonb_build_object('id',r.id,'partner_id',r.partner_id,'booking_code',r.booking_code,
   'end_date',b.end_date,'state',state,'reason',reason,'amount_pln',case when state='rejected' then 0 else coalesce(amount,0) end,
   'approved_amount',r.approved_amount,'payout_id',r.payout_id,'review_note',r.review_note,'created_at',r.created_at);
end $$;
revoke all on function ride24_affiliate.evaluation(uuid) from public,anon,authenticated;

create function ride24_affiliate.attach(p_booking uuid,p_code text) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare b record; a record; client_email text; existing record;
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
 if not exists(select 1 from ride24_affiliate.settings where enabled) then return jsonb_build_object('status','disabled'); end if;
 select * into b from public.bookings where id=p_booking and client_id=auth.uid() for update;
 if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
 select * into existing from ride24_affiliate.referrals where booking_id=p_booking;
 if found then return jsonb_build_object('status','already_attached'); end if;
 if b.status::text not in ('pending','accepted','awaiting_payment') or b.cancelled_at is not null
   or b.created_at<now()-interval '10 minutes' then raise exception 'ATTRIBUTION_CLOSED'; end if;
 select * into a from ride24_affiliate.partners where code=upper(trim(p_code)) and active;
 if not found then raise exception 'INVALID_REFERRAL_CODE'; end if;
 select email into client_email from public.profiles where id=auth.uid();
 if lower(a.email)=lower(coalesce(client_email,'')) or lower(a.email)=lower(coalesce(b.client_email,'')) then raise exception 'SELF_REFERRAL'; end if;
 insert into ride24_affiliate.referrals(booking_id,partner_id,booking_code)
 values(b.id,a.id,coalesce(b.reservation_code,b.id::text));
 return jsonb_build_object('status','attached');
end $$;
revoke all on function ride24_affiliate.attach(uuid,text) from public,anon;
grant execute on function ride24_affiliate.attach(uuid,text) to authenticated;
create function public.affiliate_attach(p_booking uuid,p_code text) returns jsonb language sql security invoker set search_path=pg_catalog as $$select ride24_affiliate.attach(p_booking,p_code)$$;
revoke all on function public.affiliate_attach(uuid,text) from public,anon;
grant execute on function public.affiliate_attach(uuid,text) to authenticated;

create function ride24_affiliate.admin(p_action text,p_data jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r record; e jsonb; pid uuid; payout uuid; total numeric; ref text; enabled_now boolean; selected_ids uuid[]:=array[]::uuid[];
begin
 if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and role='admin') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_action='settings' then
   update ride24_affiliate.settings set enabled=(p_data->>'enabled')::boolean where id;
 elsif p_action='create' then
   if not (p_data->>'email' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'INVALID_EMAIL'; end if;
   insert into ride24_affiliate.partners(name,email,code) values(trim(p_data->>'name'),lower(trim(p_data->>'email')),upper(trim(p_data->>'code')));
 elsif p_action='toggle' then
   update ride24_affiliate.partners set active=(p_data->>'active')::boolean where id=(p_data->>'id')::uuid;
 elsif p_action in ('approve','reject') then
   if not exists(select 1 from ride24_affiliate.settings where enabled) then raise exception 'PROGRAM_DISABLED'; end if;
   select * into r from ride24_affiliate.referrals where id=(p_data->>'id')::uuid for update;
   if not found or r.payout_id is not null then raise exception 'INVALID_REFERRAL'; end if;
   perform 1 from public.bookings where id=r.booking_id for update;
   e:=ride24_affiliate.evaluation(r.id);
   if length(trim(coalesce(p_data->>'note','')))<5 then raise exception 'REVIEW_NOTE_REQUIRED'; end if;
   if p_action='approve' then
     if e->>'state' not in ('review','approved') or (p_data->>'verified') is distinct from 'true' then raise exception 'REALIZED_RENTAL_AND_PAYMENT_REQUIRED'; end if;
     update ride24_affiliate.referrals set decision='approved',approved_amount=(e->>'amount_pln')::numeric,
       reviewed_by=auth.uid(),reviewed_at=now(),review_note=left(p_data->>'note',500) where id=r.id;
   else
     update ride24_affiliate.referrals set decision='rejected',reviewed_by=auth.uid(),reviewed_at=now(),review_note=left(p_data->>'note',500) where id=r.id;
   end if;
 elsif p_action='paid' then
   if not exists(select 1 from ride24_affiliate.settings where enabled) then raise exception 'PROGRAM_DISABLED'; end if;
   pid:=(p_data->>'partner_id')::uuid;
   ref:=trim(p_data->>'reference');
   if length(coalesce(ref,''))<3 or length(ref)>200 then raise exception 'TRANSFER_REFERENCE_REQUIRED'; end if;
   -- Serialize payout records for a referrer; never initiate a bank transfer.
   perform 1 from ride24_affiliate.partners where id=pid for update;
   if not found then raise exception 'PARTNER_NOT_FOUND'; end if;
   if exists(select 1 from ride24_affiliate.payouts where partner_id=pid and reference=ref) then return jsonb_build_object('status','already_recorded'); end if;
   total:=0;
   for r in select * from ride24_affiliate.referrals where partner_id=pid and payout_id is null and decision='approved' order by id for update loop
     perform 1 from public.bookings where id=r.booking_id for update;
     e:=ride24_affiliate.evaluation(r.id);
     if e->>'state'<>'approved' then raise exception 'PAYOUT_RECHECK_FAILED'; end if;
     total:=total+(e->>'amount_pln')::numeric;
     selected_ids:=array_append(selected_ids,r.id);
   end loop;
   if total<100 then raise exception 'MINIMUM_PAYOUT_100_PLN'; end if;
   if total is distinct from (p_data->>'expected_amount')::numeric then raise exception 'PAYOUT_AMOUNT_CHANGED'; end if;
   insert into ride24_affiliate.payouts(partner_id,amount_pln,reference,created_by) values(pid,total,ref,auth.uid()) returning id into payout;
   update ride24_affiliate.referrals set payout_id=payout where id=any(selected_ids) and payout_id is null;
 elsif p_action<>'list' then raise exception 'INVALID_ACTION'; end if;
 select enabled into enabled_now from ride24_affiliate.settings where id;
 return jsonb_build_object('enabled',enabled_now,
 'partners',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from ride24_affiliate.partners a),'[]'::jsonb),
 'referrals',coalesce((select jsonb_agg(ride24_affiliate.evaluation(x.id)) from (select id from ride24_affiliate.referrals order by created_at desc limit 500) x),'[]'::jsonb),
 'payouts',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from ride24_affiliate.payouts order by created_at desc limit 100) x),'[]'::jsonb));
end $$;
revoke all on function ride24_affiliate.admin(text,jsonb) from public,anon;
grant execute on function ride24_affiliate.admin(text,jsonb) to authenticated;
create function public.affiliate_admin(p_action text,p_data jsonb default '{}'::jsonb) returns jsonb language sql security invoker set search_path=pg_catalog as $$select ride24_affiliate.admin(p_action,p_data)$$;
revoke all on function public.affiliate_admin(text,jsonb) from public,anon;
grant execute on function public.affiliate_admin(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
