// Production Caravel webhook private store: real PostgreSQL via PGlite.
// No real supplier calls, payments, emails, or customer records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const CARAVEL='78721481-7619-44df-a9b7-5faa344b69bb';
const AVIA='91e04805-31da-4242-9e6f-b6075019d784';
const RIDE='f5e28014-65bf-4dad-81db-c6173ac2f745';
const OTHER='f5e28014-65bf-4dad-81db-c6173ac2f746';
const SUPPLIER_BOOKING='cv_booked_01';
const REF='ride24-f5e28014-65bf-4dad-81db-c6173ac2f745';

async function setup() {
  const p=new PGlite();
  await p.exec(`create role anon; create role authenticated; create role service_role;
    create table public.bookings(id uuid primary key, partner_id uuid not null,
      api_booking_reference text, caravel_supplier_id text, created_at timestamptz default now(),
      manual_review boolean default false);
    create table public.booking_review_queue(id bigint generated always as identity primary key,
      booking_id text not null, provider_key text, provider_status text, api_response text,
      resolved boolean default false);`);
  const migration=await readFile(new URL('../../supabase/migrations/20261119081000_caravel_production_webhook_observation.sql',import.meta.url),'utf8');
  await p.exec(migration);
  await p.query(`insert into public.bookings(id,partner_id,api_booking_reference,caravel_supplier_id)
    values ($1,$2,$3,'supplier_eur'), ($4,$5,$3,'supplier_eur')`,
    [RIDE,CARAVEL,SUPPLIER_BOOKING,OTHER,AVIA]);
  return p;
}
const send=(p, {id='evt_a',kind='booking.confirmed',revision=1, fetched=1,seq=1,status='confirmed',supplier='supplier_eur'}={})=>
  p.query(`select public.caravel_record_verified_webhook_event(
    $1::text,$2::text,$3::timestamptz,$4::text,$5::text,$6::text,$7::text,
    $8::integer,$9::integer,$10::bigint,$11::text) as result`,
    [id,kind,'2026-11-19T08:15:00Z','operator_1',supplier,SUPPLIER_BOOKING,REF,
      revision,fetched,seq,status]);

test('production webhook SQL: idempotent, supplier verified, revisions and sequence gaps isolated to Caravel',async()=>{
  const p=await setup();
  try {
    const first=(await send(p)).rows[0].result;
    assert.equal(first.accepted,true);assert.equal(first.duplicate,false);
    assert.equal(first.linked,true);
    const dupe=(await send(p)).rows[0].result;
    assert.equal(dupe.duplicate,true);
    let n=(await p.query('select count(*)::int n from public.caravel_production_webhook_events')).rows[0].n;
    assert.equal(n,1);
    assert.equal((await p.query('select manual_review from bookings where id=$1',[RIDE])).rows[0].manual_review,false);
    const second=(await send(p,{id:'evt_b',kind:'booking.cancelled',revision:2,fetched:3,seq:3,status:'cancelled'})).rows[0].result;
    assert.equal(second.sequence_gap,true,'missing sequence=2 is a gap');
    assert.equal((await p.query('select manual_review from bookings where id=$1',[RIDE])).rows[0].manual_review,true);
    assert.equal((await p.query('select manual_review from bookings where id=$1',[OTHER])).rows[0].manual_review,false,'AVIA unchanged');
    const q=(await p.query(`select provider_key,provider_status,resolved from booking_review_queue where booking_id=$1`,[RIDE])).rows;
    assert.equal(q.length,1);assert.equal(q[0].provider_key,'caravel');
    const stale=(await send(p,{id:'evt_c',revision:1,fetched:1,seq:2})).rows[0].result;
    assert.equal(stale.stale,true);
    assert.equal((await p.query('select count(*)::int n from public.booking_review_queue')).rows[0].n,1);
    n=(await p.query('select count(*)::int n from public.caravel_production_webhook_events')).rows[0].n;
    assert.equal(n,3);
  }finally{await p.close();}
});
test('production webhook SQL rejects bad evidence and has no anon/authenticated access',async()=>{
  const p=await setup();
  try {
    await assert.rejects(send(p,{id:'bad;id'}),/CARAVEL_WEBHOOK_INVALID_EVIDENCE/);
    await assert.rejects(send(p,{fetched:0}),/CARAVEL_WEBHOOK_INVALID_EVIDENCE/);
    const priv=(await p.query(`select
      has_table_privilege('anon','public.caravel_production_webhook_events','SELECT') as anon_table,
      has_table_privilege('authenticated','public.caravel_production_webhook_events','INSERT') as auth_table,
      has_function_privilege('anon',
        'public.caravel_record_verified_webhook_event(text,text,timestamptz,text,text,text,text,integer,integer,bigint,text)',
        'EXECUTE') as anon_rpc`)).rows[0];
    assert.deepEqual(priv,{anon_table:false,auth_table:false,anon_rpc:false});
  }finally{await p.close();}
});
