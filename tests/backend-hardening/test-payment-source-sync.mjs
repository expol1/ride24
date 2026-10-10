import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('maintenance/2026-10-10-production-source-manifest.json', root)));
let checks = 0;
function check(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; }

function harness(name, options = {}) {
  const state = {sessions: [], updates: [], reads: [], auth: [], writes: []};
  const booking = {id: 'booking-fixture', client_id: 'client-fixture', status: 'awaiting_payment', online_payment_pln: 42, reservation_code: 'R24-FIXTURE', ...options.booking};
  let handler;
  function createClient(url, key, config) {
    return {
      auth: {getUser: async token => {
        state.auth.push({token, config});
        return options.invalidAuth ? {data: {user: null}, error: Error('Invalid token')} : {data: {user: {id: 'client-fixture'}}, error: null};
      }},
      from(table) {
        state.reads.push(table);
        const query = {
          select() { return query; },
          eq() { return query; },
          update(values) { state.updates.push(values); return query; },
          insert(values) { state.writes.push(values); return query; },
          single: async () => ({data: table === 'bookings' ? (options.missingBooking ? null : booking) : table === 'payments' ? {status: 'paid', amount: 42} : null, error: null}),
          maybeSingle: async () => ({data: table === 'bookings' ? (options.missingBooking ? null : booking) : null, error: null}),
        };
        return query;
      },
      rpc() { throw Error('Unexpected database write'); },
    };
  }
  class Stripe {
    checkout = {sessions: {create: async payload => {
      state.sessions.push(payload);
      return {id: 'session-fixture', url: 'https://checkout.example/fixture'};
    }}};
    webhooks = {constructEventAsync: async () => {
      if (options.invalidSignature) throw Error('Invalid signature');
      return {type: 'customer.updated', data: {object: {}}};
    }};
  }
  const source = readFileSync(new URL(`supabase/functions/${name}/index.ts`, root), 'utf8');
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  check(parsed.parseDiagnostics.length, 0, `${name}: TypeScript syntax`);
  const code = ts.transpileModule(source.replace(/^import .*?;?\r?\n/gm, ''), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
  const serve = callback => { handler = callback; };
  const context = vm.createContext({serve, Stripe, createClient, Request, Response, URL, console: {log() {}, error() {}}, Deno: {serve, env: {get: key => ({SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'public-fixture', SUPABASE_SERVICE_ROLE_KEY: 'server-fixture', STRIPE_SECRET_KEY: 'stripe-fixture', STRIPE_WEBHOOK_SECRET: 'signature-fixture'}[key])}}, fetch() { throw Error('Unexpected external request'); }});
  vm.runInContext(code, context);
  return {state, async request(body = {booking_id: 'booking-fixture'}, headers = {Authorization: 'Bearer user-fixture'}, method = 'POST') {
    return handler(new Request('https://fixture.example', {method, headers, ...(method === 'POST' ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})}));
  }};
}

for (const entry of manifest.functions) {
  const source = readFileSync(new URL(entry.path, root));
  check(createHash('sha256').update(source).digest('hex'), entry.source_sha256, `${entry.slug}: exact production source snapshot`);
}

for (const [options, body, headers, status, name] of [
  [{}, {}, {}, 401, 'anonymous'],
  [{invalidAuth: true}, {}, undefined, 401, 'invalid user token'],
  [{}, {}, undefined, 400, 'missing booking ID'],
  [{missingBooking: true}, undefined, undefined, 404, 'unknown booking'],
  [{booking: {client_id: 'other-client'}}, undefined, undefined, 403, 'another client booking'],
  ...['pending', 'paid', 'rejected', 'cancelled', 'expired'].map(status => [{booking: {status}}, undefined, undefined, 409, `closed/unaccepted status ${status}`]),
  ...[0, -1, 'invalid'].map(amount => [{booking: {online_payment_pln: amount}}, undefined, undefined, 409, `invalid database amount ${amount}`]),
]) {
  const h = harness('create_checkout_session', options);
  check((await h.request(body, headers)).status, status, name);
  check(h.state.sessions.length, 0, `${name}: no Stripe session`);
  check(h.state.updates.length, 0, `${name}: no booking update`);
}
for (const client of ['web', 'android']) {
  const h = harness('create_checkout_session');
  const response = await h.request({booking_id: 'booking-fixture', amount: 0.01, client});
  check(response.status, 200, `${client}: checkout response`);
  check((await response.json()).url, 'https://checkout.example/fixture', `${client}: response URL contract`);
  const payload = h.state.sessions[0];
  check(payload.line_items[0].price_data.unit_amount, 4200, `${client}: ignores tampered client amount`);
  check(payload.metadata.client_id, 'client-fixture', `${client}: verified owner metadata`);
  check(payload.success_url, client === 'android' ? 'https://fixture.supabase.co/functions/v1/payment-return?status=success&booking_id=booking-fixture&session_id={CHECKOUT_SESSION_ID}' : 'https://ride24.pl/klient.html?payment=success', `${client}: success redirect`);
  check(payload.cancel_url, client === 'android' ? 'https://fixture.supabase.co/functions/v1/payment-return?status=cancel&booking_id=booking-fixture' : 'https://ride24.pl/klient.html?payment=cancel', `${client}: cancellation redirect`);
  check(h.state.auth[0].config.global.headers.Authorization, 'Bearer user-fixture', `${client}: forwards user authentication`);
  check(h.state.updates[0].stripe_session_id, 'session-fixture', `${client}: records payment session`);
}
for (const [options, body, headers, status, name] of [
  [{}, {}, {}, 400, 'missing receipt booking ID'],
  [{}, undefined, {}, 401, 'anonymous receipt'],
  [{invalidAuth: true}, undefined, undefined, 401, 'invalid receipt token'],
  [{missingBooking: true}, undefined, undefined, 404, 'unknown receipt booking'],
  [{booking: {status: 'paid', client_id: 'other-client'}}, undefined, undefined, 403, 'another client receipt'],
  [{}, undefined, undefined, 409, 'unpaid receipt'],
  [{booking: {status: 'paid'}}, undefined, undefined, 400, 'incomplete invoice profile'],
]) {
  const h = harness('generate-receipt', options);
  check((await h.request(body, headers)).status, status, name);
  check(h.state.updates.length + h.state.writes.length, 0, `${name}: no database writes`);
}
for (const [options, headers, status, name] of [
  [{}, {}, 400, 'missing webhook signature'],
  [{invalidSignature: true}, {'stripe-signature': 'invalid'}, 400, 'invalid webhook signature'],
  [{}, {'stripe-signature': 'fixture'}, 200, 'unrelated signed Stripe event'],
]) {
  const h = harness('stripe-webhook', options);
  check((await h.request({}, headers)).status, status, name);
  check(h.state.reads.length + h.state.updates.length + h.state.writes.length, 0, `${name}: no booking side effects`);
}
console.log(JSON.stringify({passed: checks, scope: 'exact source snapshots and isolated payment API guards/contracts; no production network, payments, PDF generation or pushes'}));
