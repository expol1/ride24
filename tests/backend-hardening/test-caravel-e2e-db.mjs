// Caravel end-to-end on a REAL PostgreSQL engine (PGlite) with the actual
// migrations: consent -> caravel_commit_pending_booking -> Stripe verified payment
// (duplicate webhook) -> single dispatch claim -> Caravel booking (mocked supplier
// HTTP only) -> api_finalize_confirmed -> voucher guard; plus cancellation, late
// payment refund, declined payment, closed gate and tampered consent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadCaravelRelease} from '../../supabase/functions/_shared/caravel-release.ts';
import {buildCaravelConsentView, buildCaravelCommitPayload} from '../../supabase/functions/_shared/caravel-consent.ts';
import {revalidatePaidCaravel, createPaidCaravel, caravelBookingUuid} from '../../supabase/functions/_shared/caravel-paid-fulfillment.ts';
import {isCaravelVoucherAllowed} from '../../supabase/functions/_shared/caravel-voucher-confirmation-guard.mjs';
import {fakeDb, releasedState, quoteRow, termsRow, PARTNER} from '../fixtures/caravel/checkout-fixtures.mjs';

const sql = (f) => readFile(new URL('../../supabase/migrations/' + f, import.meta.url), 'utf8');
const MIGRATIONS = ['20261114110526_api_payment_first_workflow_20261113.sql',
  '20261118124748_caravel_booking_evidence_additive_20261118.sql',
  '20261118141251_caravel_atomic_pending_booking_release_closed_20261118.sql',
  '20261118170000_caravel_reviewed_terms_store.sql', '20261118210000_caravel_reviewed_terms_key_clauses.sql'];
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-1234567890ab';
const PICK = '0aa18fda-4e7c-4b31-98b9-480d53e086e8';
const CAR = 'd20bbca4-678c-4abf-bf4d-cf5356220170';
const CARAVEL_BOOKING = 'c0ffee00-1111-4222-8333-444455556666';
const FLAGS = {CARAVEL_PRODUCTION_WRITES_ALLOWED: 'true', CARAVEL_STRIPE_FIRST_APPROVED: 'true'};

async function db({certified = true} = {}) {
  const p = new PGlite();
  await p.exec(`
  create role anon; create role authenticated; create role service_role;
  create type booking_status as enum ('pending','awaiting_payment','accepted','paid','cancelled','expired','payment_expired','rejected');
  create table partners(id uuid primary key, api_provider text, api_enabled boolean, api_status text, provider_type text, active boolean, account_status text);
  create table car_classes(id uuid primary key, partner_id uuid, external_id text, active boolean);
  create table partner_locations(id uuid primary key, partner_id uuid, external_id text, active boolean, is_api_managed boolean, return_only boolean default false, location_name text);
  create table api_quotes(id uuid primary key, partner_id uuid, car_class_id uuid, external_group_id text, pickup_location_external_id text,
    dropoff_location_external_id text, start_date date, end_date date, public_price_per_day numeric, partner_discount_percent numeric default 0,
    platform_margin_percent numeric, partner_net_total numeric, commission_total numeric, final_total numeric, currency text,
    external_quote_reference text, raw_response jsonb, expires_at timestamptz, booking_id uuid, used_at timestamptz);
  create table bookings(id uuid primary key default gen_random_uuid(), client_id uuid, partner_id uuid, car_class_id uuid,
    pickup_location_id uuid, dropoff_location_id uuid, start_date date, end_date date, pickup_time time, return_time time,
    pickup_location text, return_location text, partner_currency text, partner_public_price_snapshot numeric,
    partner_discount_snapshot numeric, partner_net_price_snapshot numeric, platform_margin_snapshot numeric,
    final_price_snapshot numeric, commission_snapshot numeric, online_payment_pln numeric, pickup_payment_partner_currency numeric,
    exchange_rate_snapshot numeric, deposit_snapshot numeric, status booking_status, provider_type text, api_status text,
    manual_review boolean, api_quote_id uuid, terms_accepted boolean, terms_accepted_at timestamptz,
    main_driver_name text, main_driver_age bigint, client_email text, client_phone text, add_driver_name text, add_driver_age int,
    reservation_code text, stripe_session_id text, cancelled_at timestamptz, api_booking_reference text, payment_intent_id text,
    partner_response_deadline timestamptz, payment_deadline timestamptz, expires_at timestamptz, api_response jsonb,
    stripe_currency text, stripe_amount_cents bigint);
  create table payments(id bigserial primary key, booking_id uuid, stripe_session_id text, amount numeric, currency text, status text, provider text);
  create table booking_review_queue(id bigserial primary key, booking_id uuid, provider_key text, provider_status text, api_response text, resolved boolean);`);
  for (const m of MIGRATIONS) await p.exec(await sql(m));
  const t = await termsRow();
  const q = await quoteRow({expires_at: new Date(Date.now() + 40 * 60000).toISOString()},
    {expires_at: undefined});
  q.raw_response.provider_quote_data.expires_at = q.expires_at;
  await p.query(`insert into partners values($1,'caravel',true,'synced','api',true,'active')`, [PARTNER]);
  await p.query(`insert into car_classes values($1,$2,'opaque-group',true)`, [CAR, PARTNER]);
  await p.query(`insert into partner_locations values($1,$2,'ath-airport',true,true,false,'Athens Airport')`, [PICK, PARTNER]);
  await p.query(`insert into caravel_reviewed_terms(document_id,supplier_id,language,version,title,format,content_hash,published_at,body,
    documented_excluded_codes,damage_admin_fee_minor,damage_admin_fee_currency,exclusion_clause_refs,admin_fee_clause_ref,approved_by,approved_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [t.document_id, t.supplier_id, t.language, t.version, t.title,
    t.format, t.content_hash, t.published_at, t.body, JSON.stringify(t.documented_excluded_codes), t.damage_admin_fee_minor,
    'EUR', JSON.stringify(t.exclusion_clause_refs), t.admin_fee_clause_ref, t.approved_by, t.approved_at]);
  await p.query(`update caravel_release_control set certified=$1, allow_customer_checkout=$1, official_certified_at=case when $1 then now() end,
    terms_document_id=$2, terms_content_hash=$3`, [certified, t.document_id, t.content_hash]);
  await p.query(`insert into api_quotes values($1,$2,$3,'opaque-group','ath-airport','ath-airport','2027-01-10','2027-01-13',50,0,10,150,15,165,'EUR',$4,$5,$6,null,null)`,
    [q.id, PARTNER, CAR, q.external_quote_reference, q.raw_response, q.expires_at]);
  return {p, q};
}

async function commit(p, q, mutate = (x) => x) {
  const release = await loadCaravelRelease(fakeDb(await releasedState()));
  const view = buildCaravelConsentView(q, release, 'pl');
  const built = buildCaravelCommitPayload(q, release, {...view.echo, accepted: true, coverage_acknowledged: true}, {
    clientId: USER, clientEmail: 'sandbox@example.test', clientPhone: '+48000000000', mainDriverName: 'Jan Kowalski',
    mainDriverAge: 30, pickupLocationId: PICK, dropoffLocationId: PICK, pickupLocationName: 'Athens Airport',
    returnLocationName: 'Athens Airport', pickupTime: '10:00', returnTime: '10:00', exchangeRate: 4.3});
  assert.equal(built.ok, true);
  const r = await p.query('select caravel_commit_pending_booking($1,$2,$3) as id', [q.id, USER, mutate(built.payload)]);
  return r.rows[0].id;
}
const row = async (p, id) => (await p.query(`select *, start_date::text as start_date, end_date::text as end_date,
  online_payment_pln::float8 as online_payment_pln, partner_net_price_snapshot::float8 as partner_net_price_snapshot,
  caravel_stripe_payment_confirmed_at::text as caravel_stripe_payment_confirmed_at,
  caravel_supplier_dispatch_claimed_at::text as caravel_supplier_dispatch_claimed_at, terms_accepted_at::text as terms_accepted_at,
  caravel_coverage_accepted_at::text as caravel_coverage_accepted_at, caravel_supplier_quote_id::text as caravel_supplier_quote_id
  from bookings where id=$1`, [id])).rows[0];
const quoteFromDb = async (p, id) => (await p.query(`select *, start_date::text as start_date, end_date::text as end_date,
  booking_id::text as booking_id from api_quotes where id=$1`, [id])).rows[0];
const wf = async (p, id) => (await p.query('select * from api_booking_workflows where booking_id=$1', [id])).rows[0];
const pay = (p, id, amount) => p.query(`select api_record_verified_payment($1,'cs_test','pi_test','evt_test',$2,'pln') as w`, [id, amount]);
async function supplier() {
  const calls = [];
  const hash = (await termsRow()).content_hash;
  const factory = () => ({environment: 'production',
    async referenceTerms() { return {data: [{document_id: 'caravel-en-v5', language: 'en', content_hash: hash, withdrawn_at: null}]}; },
    async suppliers() { return {data: [{supplier_id: 'acct_eur', status: 'active', currency: 'EUR', tax_inclusive: true}]}; },
    async quote(req, key) { calls.push(['quote', key]); return {data: {quote_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', status: 'active',
      plan: 'premium', currency: 'EUR', payment_model: 'pay_on_arrival', rental_days: 3, expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
      totals: {grand_total: {amount: 15000, currency: 'EUR'}, pay_now: {amount: 0, currency: 'EUR'}, pay_at_pickup: {amount: 15000, currency: 'EUR'}},
      deposit: {amount: {amount: 0, currency: 'EUR'}}, line_items: [{kind: 'base_rate', total: {amount: 15000, currency: 'EUR'}}]}}; },
    async book(req, key) { calls.push(['book', key, req]); return {data: {booking_id: CARAVEL_BOOKING, revision: 1, status: 'confirmed',
      quote_id: req.quote_id, external_ref: req.external_ref, price: {totals: {grand_total: {amount: 15000, currency: 'EUR'}}},
      protection: {deposit: {amount: 0, currency: 'EUR'}, excess: {amount: 0, currency: 'EUR'}},
      payment: {model: 'pay_on_arrival', amount_on_arrival: {amount: 15000, currency: 'EUR'}, amount_prepaid: {amount: 0, currency: 'EUR'}}}}; },
  });
  return {calls, factory};
}
const withFlags = async (fn) => { const prev = globalThis.Deno; globalThis.Deno = {env: {get: (k) => FLAGS[k]}};
  try { return await fn(); } finally { if (prev === undefined) delete globalThis.Deno; else globalThis.Deno = prev; } };

test('Caravel DB e2e: consent -> pending booking -> Stripe -> one supplier booking -> confirmation -> voucher', () => withFlags(async () => {
  const {p, q} = await db();
  try {
    const id = await commit(p, q);
    let b = await row(p, id);
    assert.equal(b.status, 'awaiting_payment');
    assert.equal(b.online_payment_pln, 64.5, 'only the Ride24 fee (15 EUR x 4.3) goes to Stripe');
    assert.equal(b.partner_net_price_snapshot, 150, 'full rental is paid to Caravel at pickup');
    assert.deepEqual(b.caravel_coverage_excluded_codes, ['glass', 'tyres_and_wheels', 'undercarriage']);
    assert.equal(b.caravel_coverage_damage_admin_fee_minor, 10000);
    assert.ok(b.caravel_coverage_accepted_at && b.terms_accepted === true);
    assert.equal((await quoteFromDb(p, q.id)).booking_id, id, 'quote consumed atomically');
    await assert.rejects(p.query('select caravel_commit_pending_booking($1,$2,$3)', [q.id, USER, {}]), /QUOTE_USED_OR_EXPIRED/);
    assert.equal(isCaravelVoucherAllowed({...b, api_provider: 'caravel'}), false, 'no voucher before payment');

    await p.query(`update bookings set stripe_session_id='cs_test' where id=$1`, [id]);
    await pay(p, id, 6450); await pay(p, id, 6450); // duplicate signed webhook
    assert.equal((await p.query('select count(*)::int n from payments')).rows[0].n, 1);
    assert.equal((await wf(p, id)).state, 'paid');

    await p.query(`update api_booking_workflows set state='revalidating' where booking_id=$1`, [id]);
    const s = await supplier();
    b = await row(p, id);
    const prepared = await revalidatePaidCaravel({api_key: 'k', api_url: 'https://api.caravelway.com'},
      {...b, partners: {api_provider: 'caravel'}}, await quoteFromDb(p, q.id), {factory: s.factory});
    assert.equal(prepared.idempotency_key, await caravelBookingUuid(id, 'book'));
    const claimed = (await p.query('select api_claim_paid_dispatch($1,$2) as w', [id, prepared])).rows[0].w;
    assert.equal(claimed.state, 'dispatching');
    assert.equal((await p.query('select api_claim_paid_dispatch($1,$2) as w', [id, prepared])).rows[0].w, null, 'second claim refused');
    b = await row(p, id);
    assert.ok(b.caravel_stripe_payment_confirmed_at && b.caravel_supplier_dispatch_claimed_at, 'trigger recorded Stripe evidence');
    assert.equal(Number(b.stripe_amount_cents), 6450);

    const result = await createPaidCaravel({api_key: 'k', api_url: 'https://api.caravelway.com'}, prepared, {factory: s.factory});
    assert.equal(result.status, 'confirmed');
    assert.equal(s.calls.filter((c) => c[0] === 'book').length, 1);
    await p.query(`update api_booking_workflows set state='confirmed', provider_reference=$2, provider_response=$3 where booking_id=$1`,
      [id, result.booking_reference, result]);
    assert.equal((await p.query('select api_finalize_confirmed($1) as ok', [id])).rows[0].ok, true);
    b = await row(p, id);
    assert.equal(b.status, 'paid'); assert.equal(b.api_status, 'confirmed');
    assert.equal(b.api_booking_reference, CARAVEL_BOOKING, 'voucher carries the real Caravel booking number');
    assert.equal(isCaravelVoucherAllowed({...b, api_provider: 'caravel'}), true);
  } finally { await p.close(); }
}));

test('Caravel DB: direct status=paid without confirmed workflow is refused by the shared guard trigger', async () => {
  const {p, q} = await db();
  try {
    const id = await commit(p, q);
    await assert.rejects(p.query(`update bookings set status='paid' where id=$1`, [id]), /API_CONFIRMATION_REQUIRED/);
  } finally { await p.close(); }
});

test('Caravel DB: closed release gate refuses the booking; tampered consent refused; terms immutable', async () => {
  const closed = await db({certified: false});
  try { await assert.rejects(commit(closed.p, closed.q), /CARAVEL_RELEASE_GATE_CLOSED/); } finally { await closed.p.close(); }
  const {p, q} = await db();
  try {
    await assert.rejects(commit(p, q, (x) => ({...x, caravel_coverage_excluded_codes: ['glass']})), /EXCLUSION_CONSENT_REQUIRED/);
    await assert.rejects(commit(p, q, (x) => ({...x, caravel_coverage_damage_admin_fee_minor: 0})), /EXCLUSION_CONSENT_REQUIRED/);
    await assert.rejects(commit(p, q, (x) => ({...x, online_payment_pln: 1})), /FEE_OR_FX_MISMATCH/);
    await assert.rejects(commit(p, q, (x) => ({...x, caravel_terms_content_hash: 'b'.repeat(64)})), /SNAPSHOT_TAMPERED/);
    await assert.rejects(p.query(`update caravel_reviewed_terms set damage_admin_fee_minor=0`), /IMMUTABLE/);
    await assert.rejects(p.query(`delete from caravel_reviewed_terms`), /IMMUTABLE/);
  } finally { await p.close(); }
});

test('Caravel DB: cancel before payment, late payment -> refund; declined/expired checkout never dispatches', async () => {
  const {p, q} = await db();
  try {
    const id = await commit(p, q);
    await p.query(`update bookings set stripe_session_id='cs_test' where id=$1`, [id]);
    assert.equal((await p.query(`select api_record_unpaid_session($1,'cs_test',false) as ok`, [id])).rows[0].ok, true);
    assert.equal((await row(p, id)).status, 'awaiting_payment', 'declined payment keeps the cart unpaid');
    assert.equal((await p.query('select api_cancel_unfulfilled($1) as ok', [id])).rows[0].ok, true);
    assert.equal((await row(p, id)).status, 'cancelled');
    await pay(p, id, 6450); // payment arrives after cancellation
    assert.equal((await wf(p, id)).state, 'refund_pending', 'refund via the existing Stripe refund path');
    assert.equal((await p.query('select api_claim_paid_dispatch($1,$2) as w', [id, {}])).rows[0].w, null);
    assert.equal((await row(p, id)).caravel_supplier_dispatch_claimed_at, null, 'no supplier dispatch evidence');
  } finally { await p.close(); }
});
