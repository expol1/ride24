// Executes the actual admin submit function and Edge handler with isolated
// auth/database/email mocks. No production accounts, data or messages are created.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const edgeSource = readFileSync(root + 'supabase/functions/admin-create-partner/index.ts', 'utf8');
const edgeCode = stripTypeScriptTypes(edgeSource.replace(/^import[\s\S]*?;\s*/gm, ''));
const html = readFileSync(root + 'admin/index.html', 'utf8');
const submitCode = html.slice(html.indexOf('window.processAddPartner = async function()'),
  html.indexOf('window.togglePartnerType = function'));
assert(submitCode.includes('new-p-address'));
assert(html.includes('id="new-p-address" maxlength="500"'));
let handler, authorized = true, authCreates = 0, partnerInsert, credentialsInsert;
const reset = () => { authCreates = 0; partnerInsert = null; credentialsInsert = null; };
const admin = {
  auth: { admin: {
    createUser: async () => { authCreates++; return { data: { user: { id: 'fixture-user' } }, error: null }; },
    deleteUser: async () => ({ error: null })
  } },
  from(table) {
    return {
      upsert: async () => ({ error: null }),
      insert(row) {
        if (table === 'partners') partnerInsert = row;
        else if (table === 'partner_api_credentials') credentialsInsert = row;
        else throw new Error('Unexpected table: ' + table);
        return {
          select: () => ({ single: async () => ({ data: { id: 'fixture-partner' }, error: null }) }),
          then: resolve => resolve({ error: null })
        };
      },
      delete: () => ({ eq: async () => ({ error: null }) })
    };
  }
};
const context = vm.createContext({
  Request, Response, AbortController, TextDecoder, TextEncoder,
  setTimeout, clearTimeout, URL,
  console: { error() {} },
  Deno: { env: { get: () => undefined } },
  fetch: async () => { throw new Error('Network forbidden in fixture test'); },
  serve: callback => { handler = callback; },
  requireAdmin: async () => {
    if (!authorized) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return { admin };
  },
  corsHeaders: () => ({}),
  escapeHtml: value => String(value),
  jsonResponse: (_req, body, status = 200) => Response.json(body, { status }),
  publicErrorMessage: error => ({ message: error.message, status: error.status || 400 }),
  assertSafeApiUrl: value => value
});
vm.runInContext(edgeCode, context);
const base = { email: 'fixture@example.test', password: 'Ride24!Fixture123',
  company_name: 'Fixture company', country: 'Italy', region: 'Palermo', currency: 'EUR',
  discount_percent: 10, provider_type: 'local' };
const invoke = body => handler(new Request('https://fixture.test/create', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
}));
let passed = 0;
for (const [value, expected] of [
  ['  Via Roma 12, 90133 Palermo  ', 'Via Roma 12, 90133 Palermo'],
  ['ul. Żółta 12/3, 70-001 Szczecin', 'ul. Żółta 12/3, 70-001 Szczecin'],
  ['', null], ['   ', null], [undefined, null], [null, null], ['a'.repeat(500), 'a'.repeat(500)]
]) {
  reset();
  const response = await invoke({ ...base, address: value });
  assert.equal(response.status, 200);
  assert.equal(authCreates, 1);
  assert.equal(partnerInsert.address, expected);
  assert.equal(partnerInsert.account_status, 'pending');
  assert.equal(partnerInsert.active, false);
  passed++;
}
for (const invalid of ['a'.repeat(501), 42, {}, 'Street\nAddress', 'Street\u0000Address']) {
  reset();
  assert.equal((await invoke({ ...base, address: invalid })).status, 400);
  assert.equal(authCreates, 0, 'Invalid address must be rejected before account creation');
  assert.equal(partnerInsert, null);
  passed++;
}
reset();
assert.equal((await invoke({ ...base, provider_type: 'api', api_provider: 'custom',
  api_settings: {}, address: 'API office street 1' })).status, 200);
assert.equal(partnerInsert.address, 'API office street 1');
assert.equal(partnerInsert.api_enabled, false);
assert(credentialsInsert);
passed++;
authorized = false;
reset();
assert.equal((await invoke({ ...base, address: 'Private address' })).status, 403);
assert.equal(authCreates, 0);
assert.equal(partnerInsert, null);
passed++;
authorized = true;

// Browser form -> request JSON -> handler -> partners.address, including reset.
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', style: {} });
  return elements.get(id);
};
for (const [id, value] of Object.entries({
  'new-p-provider-type': 'local', 'new-p-currency': 'EUR',
  'new-p-email': base.email, 'new-p-pass': base.password, 'new-p-company': base.company_name,
  'new-p-country': base.country, 'new-p-region': base.region,
  'new-p-address': '  Via Roma 12, Palermo  ', 'new-p-discount': '10'
})) element(id).value = value;
const window = {};
const ui = vm.createContext({
  window, document: { getElementById: element }, AbortController,
  console: { error() {} }, alert() {},
  setTimeout: () => 1,
  closeAddPartnerModal() {}, loadPartnersData() {},
  db: { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-token' } } }) } },
  fetch: async (_url, options) => invoke(JSON.parse(options.body))
});
vm.runInContext(submitCode, ui);
reset();
await window.processAddPartner();
assert.equal(partnerInsert.address, 'Via Roma 12, Palermo');
assert.equal(element('new-p-address').value, '', 'Clear address after successful creation');
assert.equal(element('savePartnerBtn').disabled, false);
passed++;
console.log(JSON.stringify({ passed, scope: 'isolated admin form and Edge handler; no remote writes or email' }));
