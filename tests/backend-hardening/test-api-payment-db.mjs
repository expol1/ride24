import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const migration=await readFile(new URL('../../supabase/migrations/20261114110526_api_payment_first_workflow_20261113.sql',import.meta.url),'utf8');
const b='10000000-0000-4000-8000-000000000001';
async function db() {
 const p=new PGlite();await p.exec(`
 create role anon; create role authenticated; create role service_role;
 create type booking_status as enum ('pending','awaiting_payment','accepted','paid','cancelled','expired','payment_expired','rejected');
 create table bookings(id uuid primary key,provider_type text,status booking_status,stripe_session_id text,online_payment_pln numeric,
 cancelled_at timestamptz,api_booking_reference text,payment_intent_id text,api_status text,partner_response_deadline timestamptz,
 payment_deadline timestamptz,expires_at timestamptz,manual_review boolean,api_response jsonb);
 create table payments(id bigserial primary key,booking_id uuid,stripe_session_id text,amount numeric,currency text,status text,provider text);
 insert into bookings(id,provider_type,status,stripe_session_id,online_payment_pln) values('${b}','api','awaiting_payment','cs_test',123.45);`);
 await p.exec(migration);return p;
}
const record=(p,amount=12345)=>p.query(`select api_record_verified_payment($1,'cs_test','pi_test','evt_test',$2,'pln') as w`,[b,amount]);
test('verified API payment and durable state are atomic and idempotent',async()=>{
 const p=await db();try {await record(p);await record(p);
 assert.equal((await p.query('select count(*)::int as n from payments')).rows[0].n,1);
 assert.equal((await p.query('select status from bookings')).rows[0].status,'pending');
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'paid');
 }finally{await p.close();}
});
test('mismatched payment rolls back both payment and workflow',async()=>{
 const p=await db();try {await assert.rejects(record(p,1),/API_PAYMENT_MISMATCH/);
 assert.equal((await p.query('select count(*)::int as n from payments')).rows[0].n,0);
 assert.equal((await p.query('select count(*)::int as n from api_booking_workflows')).rows[0].n,0);
 }finally{await p.close();}
});
test('cancelled or expired internal cart refunds a late payment without dispatch',async()=>{
 const p=await db();try {await p.exec("update bookings set status='payment_expired'");await record(p);
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'refund_pending');
 assert.equal((await p.query('select status from bookings')).rows[0].status,'payment_expired');
 }finally{await p.close();}
});
test('cancellation wins before dispatch and retains payment record',async()=>{
 const p=await db();try {await record(p);await p.exec("update api_booking_workflows set state='revalidating'");
 const cancel=await p.query('select api_cancel_unfulfilled($1) as ok',[b]);
 assert.equal(cancel.rows[0].ok,false);
 await p.exec("update bookings set status='cancelled',cancelled_at=now()");
 const result=await p.query("select api_claim_paid_dispatch($1,'{}') as w",[b]);assert.equal(result.rows[0].w,null);
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'refund_pending');
 await assert.rejects(p.query('delete from bookings where id=$1',[b]),/foreign key/);
 }finally{await p.close();}
});
test('database rejects fake paid confirmation; only verified provider confirmation publishes paid',async()=>{
 const p=await db();try {await assert.rejects(p.exec("update bookings set status='paid'"),/API_CONFIRMATION_REQUIRED/);
 await record(p);await p.exec("update api_booking_workflows set state='confirmed',provider_reference='DEMO-1'");
 await p.query('select api_finalize_confirmed($1)',[b]);
 assert.equal((await p.query('select status,api_booking_reference from bookings')).rows[0].status,'paid');
 }finally{await p.close();}
});
test('ordinary local partner paid transition is unchanged',async()=>{
 const p=await db();try {await p.exec("update bookings set provider_type='local',status='paid'");assert.equal((await p.query('select status from bookings')).rows[0].status,'paid');}finally{await p.close();}
});
test('untrusted clients cannot write workflows or invoke payment recorder',async()=>{
 const p=await db();try {
 await p.exec('set role authenticated');
 await assert.rejects(p.query('select * from api_booking_workflows'),/permission denied/);
 await assert.rejects(record(p),/permission denied/);
 }finally{await p.close();}
});

test('missing verified payment identifiers cannot create paid records',async()=>{
 const p=await db();try {
 await assert.rejects(p.query("select api_record_verified_payment($1,'cs_test',null,'evt_test',12345,'pln')",[b]),/API_PAYMENT_MISMATCH/);
 assert.equal((await p.query('select count(*)::int as n from payments')).rows[0].n,0);
 }finally{await p.close();}
});
test('unpaid cancellation retains cart and late payment cannot dispatch',async()=>{
 const p=await db();try {
 assert.equal((await p.query('select api_cancel_unfulfilled($1) as ok',[b])).rows[0].ok,true);
 await record(p);
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'refund_pending');
 }finally{await p.close();}
});

test('late unpaid events cannot erase a verified payment',async()=>{
 const p=await db();try {
 await record(p);
 assert.equal((await p.query("select api_record_unpaid_session($1,'cs_test',true) as ok",[b])).rows[0].ok,false);
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'paid');
 }finally{await p.close();}
});
test('expired checkout cannot dispatch, but a later verified payment is retained',async()=>{
 const p=await db();try {
 await p.query("select api_record_unpaid_session($1,'cs_test',true)",[b]);
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'abandoned');
 await record(p);
 assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'refund_pending');
 }finally{await p.close();}
});

const refundGuardMigration=await readFile(new URL('../../supabase/migrations/20261114111238_admin_api_refund_settlement_guard_20261114.sql',import.meta.url),'utf8');
async function adminRefundDb(provider='api') {
 const p=await db();
 await p.exec(`
 create schema if not exists auth;
 create or replace function auth.uid() returns uuid language sql stable as
   'select ''10000000-0000-4000-8000-000000000090''::uuid';
 create table profiles (id uuid primary key,role text);
 insert into profiles values('10000000-0000-4000-8000-000000000090','admin');
 alter table bookings add column refund_status text;
 alter table bookings add column refund_completed_at timestamptz;
 update bookings set provider_type='${provider}',status='cancelled',refund_status='pending',
 api_booking_reference='DEMO-BOOKING',api_status='cancel_error',manual_review=true;
 `);
 await p.exec(refundGuardMigration);
 return p;
}
test('manual API refund cannot be marked completed while supplier cancellation is unresolved',async()=>{
 const p=await adminRefundDb();try{
 await assert.rejects(p.query('select admin_mark_refund_done($1)',[b]),/API_CANCELLATION_NOT_VERIFIED/);
 const row=(await p.query('select refund_status from bookings')).rows[0];
 assert.equal(row.refund_status,'pending');
 }finally{await p.close();}
});
test('manual API refund may be marked completed after supplier cancellation is verified',async()=>{
 const p=await adminRefundDb();try{
 await p.exec("update bookings set api_status='cancelled',manual_review=false");
 await p.query('select admin_mark_refund_done($1)',[b]);
 assert.equal((await p.query('select refund_status from bookings')).rows[0].refund_status,'completed');
 }finally{await p.close();}
});
test('local-partner manual refund follows unchanged historical admin procedure even without pending state',async()=>{
 const p=await adminRefundDb('local');try{
 await p.exec("update bookings set status='paid',refund_status=null");
 await p.query('select admin_mark_refund_done($1)',[b]);
 assert.equal((await p.query('select refund_status from bookings')).rows[0].refund_status,'completed');
 }finally{await p.close();}
});
test('ordinary local-partner manual refund remains available',async()=>{
 const p=await adminRefundDb('local');try{
 await p.query('select admin_mark_refund_done($1)',[b]);
 assert.equal((await p.query('select refund_status from bookings')).rows[0].refund_status,'completed');
 }finally{await p.close();}
});
test('manual refund completion requires a pending request and administrator authorization',async()=>{
 const p=await adminRefundDb();try{
 await p.exec("update bookings set api_status='cancelled',manual_review=false,refund_status=null");
 await assert.rejects(p.query('select admin_mark_refund_done($1)',[b]),/REFUND_NOT_PENDING/);
 await p.exec("update bookings set refund_status='pending';update profiles set role='client'");
 await assert.rejects(p.query('select admin_mark_refund_done($1)',[b]),/Brak dostępu/);
 }finally{await p.close();}
});

test('legacy supplier reference with late paid Stripe checkout cannot dispatch again',async()=>{
 const p=await db();try {
  // The original supplier booking pre-dated the payment-first rollout.
  await p.exec("update bookings set api_booking_reference='26-P2-8302',api_status='confirmed'");
  await record(p);
  const workflow=(await p.query('select state,provider_reference from api_booking_workflows')).rows[0];
  assert.equal(workflow.state,'provider_pending');
  assert.equal(workflow.provider_reference,'26-P2-8302');
  const dispatch=await p.query("select api_claim_paid_dispatch($1,'{}'::jsonb) as result",[b]);
  assert.equal(dispatch.rows[0].result,null);
  assert.equal((await p.query('select count(*)::int as n from payments')).rows[0].n,1);
 }finally{await p.close();}
});

test('late Stripe payment on cancelled legacy supplier reference is held for reconciliation, never dispatched',async()=>{
 const p=await db();try {
  await p.exec("update bookings set api_booking_reference='26-P2-8302',api_status='cancelled',status='cancelled',cancelled_at=now()");
  await record(p);
  const w=(await p.query('select state,provider_reference from api_booking_workflows')).rows[0];
  assert.equal(w.state,'unknown');
  assert.equal(w.provider_reference,'26-P2-8302');
  const bRow=(await p.query('select status,api_booking_reference from bookings')).rows[0];
  assert.equal(bRow.status,'cancelled');
  assert.equal(bRow.api_booking_reference,'26-P2-8302');
  const dispatch=await p.query("select api_claim_paid_dispatch($1,'{}'::jsonb) as result",[b]);
  assert.equal(dispatch.rows[0].result,null);
  assert.equal((await p.query('select count(*)::int as n from payments')).rows[0].n,1);
 }finally {await p.close();}
});
