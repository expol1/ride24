// caravel_set_release on a real PostgreSQL engine (PGlite) with the actual migrations.
// Open requires certification + reviewed terms + production credentials + synced catalogue
// in ONE transaction; close is an immediate kill switch; the log is append-only;
// other partners (AVIA etc.) are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const sql = (f) => readFile(new URL('../../supabase/migrations/' + f, import.meta.url), 'utf8');
const CARAVEL = '78721481-7619-44df-a9b7-5faa344b69bb', AVIA = '91e04805-31da-4242-9e6f-b6075019d784';
const HASH = 'a'.repeat(64);

async function db({credentials = true, catalog = true, terms = true, termsVersion = 5, freeCancellation = true} = {}) {
  const p = new PGlite();
  await p.exec(`create role anon; create role authenticated; create role service_role;
  create table partners(id uuid primary key, api_provider text, api_enabled boolean, api_status text, provider_type text, active boolean, account_status text);
  create table partner_locations(id uuid primary key default gen_random_uuid(), partner_id uuid, external_id text, is_api_managed boolean, active boolean);
  create table car_classes(id uuid primary key default gen_random_uuid(), partner_id uuid, external_id text, is_api_managed boolean, active boolean);
  create table partner_api_credentials(partner_id uuid primary key, api_url text, api_key text);
  create table bookings(id uuid primary key, partner_id uuid, provider_type text, stripe_session_id text,
    caravel_stripe_payment_confirmed_at timestamptz, caravel_supplier_dispatch_claimed_at timestamptz, stripe_amount_cents bigint, stripe_currency text);
  create table api_booking_workflows(booking_id uuid primary key, state text, paid_at timestamptz, amount_cents bigint, currency text, stripe_session_id text);
  create table api_quotes(id uuid);`);
  await p.exec((await sql('20261118141251_caravel_atomic_pending_booking_release_closed_20261118.sql')));
  await p.exec(await sql('20261118170000_caravel_reviewed_terms_store.sql'));
  await p.exec(await sql('20261118210000_caravel_reviewed_terms_key_clauses.sql'));
  await p.exec(await sql('20261118190000_caravel_release_switch.sql'));
  await p.query(`insert into partners values($1,'custom',false,'draft','api',true,'active'),($2,'renteon_aggregator',true,'synced','api',true,'active')`, [CARAVEL, AVIA]);
  await p.query(`insert into partner_locations(partner_id,external_id,is_api_managed,active) values($1,'AV-1',true,true)`, [AVIA]);
  if (catalog) {
    await p.query(`insert into partner_locations(partner_id,external_id,is_api_managed,active) values($1,'1',true,false)`, [CARAVEL]);
    await p.query(`insert into car_classes(partner_id,external_id,is_api_managed,active) values($1,'veh-a',true,false)`, [CARAVEL]);
  }
  if (credentials) await p.query(`insert into partner_api_credentials values($1,'https://api.caravelway.com','prod-key-fixture')`, [CARAVEL]);
  if (terms) await p.query(`insert into caravel_reviewed_terms(document_id,supplier_id,language,version,title,format,content_hash,published_at,body,
    documented_excluded_codes,damage_admin_fee_minor,damage_admin_fee_currency,exclusion_clause_refs,admin_fee_clause_ref,free_cancellation_until_pickup,approved_by,approved_at)
    values('caravel-en-v5','acct_eur','en',$2,'Terms','clauses/v1',$1,now(),'{"title":"Terms","language":"en","clauses":[]}','["glass"]',10000,'EUR','["5.4"]','7.1',$3,'op',now())`, [HASH, termsVersion, freeCancellation]);
  return p;
}
const open = (p, patch = {}) => p.query(`select caravel_set_release(true,$1,$2,$3,'admin:test','certified run') as s`,
  [patch.at ?? new Date(Date.now() - 3600000).toISOString(), patch.doc ?? 'caravel-en-v5', patch.hash ?? HASH]);
const state = async (p) => ({
  gate: (await p.query('select certified, allow_customer_checkout, terms_document_id from caravel_release_control')).rows[0],
  partner: (await p.query('select api_provider, api_enabled, api_status from partners where id=$1', [CARAVEL])).rows[0],
  avia: (await p.query('select api_provider, api_enabled, api_status from partners where id=$1', [AVIA])).rows[0],
  aviaLoc: (await p.query('select active from partner_locations where partner_id=$1', [AVIA])).rows[0].active,
  log: (await p.query('select count(*)::int n from caravel_release_log')).rows[0].n,
});

test('open fails closed without each piece of evidence and changes nothing', async () => {
  for (const [opts, patch, code] of [[{terms: false}, {}, /REVIEWED_TERMS_V5_CONTRACT_REQUIRED/], [{credentials: false}, {}, /PRODUCTION_CREDENTIALS_REQUIRED/],
    [{catalog: false}, {}, /CATALOG_NOT_SYNCED/],
    [{termsVersion: 4}, {}, /REVIEWED_TERMS_V5_CONTRACT_REQUIRED/],
    [{freeCancellation: false}, {}, /REVIEWED_TERMS_V5_CONTRACT_REQUIRED/], [{}, {hash: 'b'.repeat(64)}, /REVIEWED_TERMS_V5_CONTRACT_REQUIRED/],
    [{}, {at: new Date(Date.now() + 86400000).toISOString()}, /CERTIFICATION_EVIDENCE_REQUIRED/]]) {
    const p = await db(opts);
    try {
      await assert.rejects(open(p, patch), code);
      const s = await state(p);
      assert.equal(s.gate.allow_customer_checkout, false); assert.equal(s.partner.api_enabled, false); assert.equal(s.log, 0);
    } finally { await p.close(); }
  }
});

test('open activates Caravel atomically; close is a kill switch; AVIA untouched; log append-only', async () => {
  const p = await db();
  try {
    await open(p);
    let s = await state(p);
    assert.deepEqual(s.gate, {certified: true, allow_customer_checkout: true, terms_document_id: 'caravel-en-v5'});
    assert.deepEqual(s.partner, {api_provider: 'caravel', api_enabled: true, api_status: 'synced'});
    assert.equal((await p.query('select bool_and(active) a from partner_locations where partner_id=$1', [CARAVEL])).rows[0].a, true);
    await p.query(`select caravel_set_release(false,null,null,null,'admin:test','pause sales')`);
    s = await state(p);
    assert.equal(s.gate.allow_customer_checkout, false); assert.equal(s.gate.certified, true, 'evidence kept');
    assert.deepEqual(s.partner, {api_provider: 'caravel', api_enabled: false, api_status: 'paused'});
    assert.deepEqual(s.avia, {api_provider: 'renteon_aggregator', api_enabled: true, api_status: 'synced'});
    assert.equal(s.aviaLoc, true);
    assert.equal(s.log, 2);
    await assert.rejects(p.query('update caravel_release_log set reason=$1', ['x']), /IMMUTABLE/);
    await assert.rejects(p.query('delete from caravel_release_log'), /IMMUTABLE/);
    await assert.rejects(p.query(`select caravel_set_release(false,null,null,null,'','')`), /AUDIT_REQUIRED/);
  } finally { await p.close(); }
});

test('operator-hidden Caravel locations stay inactive through "Aktywuj API" and any later write', async () => {
  const p = await db();
  try {
    await p.query(`insert into partner_locations(partner_id,external_id,is_api_managed,active) values($1,'4',true,true),($1,'23',true,true),($1,'5',true,false)`, [CARAVEL]);
    await p.exec(await sql('20261120094416_caravel_operator_hidden_locations.sql'));
    const loc = async () => Object.fromEntries((await p.query(
      `select external_id, active, operator_hidden from partner_locations where partner_id=$1 order by external_id`, [CARAVEL])).rows
      .map((r) => [r.external_id, [r.active, r.operator_hidden]]));
    assert.deepEqual(await loc(), {'1': [false, false], '23': [false, true], '4': [false, true], '5': [false, false]});
    await open(p);
    assert.deepEqual(await loc(), {'1': [true, false], '23': [false, true], '4': [false, true], '5': [true, false]},
      'release activates the catalogue except the hidden desks');
    assert.equal((await state(p)).aviaLoc, true, 'other partners untouched');
    await p.query(`update partner_locations set active = true where partner_id=$1`, [CARAVEL]);
    assert.deepEqual((await loc())['4'], [false, true], 'a manual or sync write cannot re-show a hidden desk');
    await p.query(`update partner_locations set operator_hidden = false, active = true where external_id='4'`);
    assert.deepEqual((await loc())['4'], [true, false], 'clearing the flag is the explicit way back');
  } finally { await p.close(); }
});
