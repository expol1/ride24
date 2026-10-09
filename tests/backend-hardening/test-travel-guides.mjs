import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGuideHandler, MAX_HTML_BYTES } from '../../supabase/functions/admin-travel-guides/handler.ts';

// Exercise the actual shared admin authorization code with an isolated Auth/DB fixture.
globalThis.Deno = { env: { get: k => ({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service' })[k] } };
let observedProfileId;
globalThis.guideTestCreateClient = () => ({
  auth: { getUser: async token => ({ data: { user: ['admin','client','partner'].includes(token)
    ? { id: token, user_metadata: { role: 'admin' } } : null }, error: null }) },
  from: table => ({ select: () => ({ eq: (column, id) => { observedProfileId = id; return {
    maybeSingle: async () => ({ data: { role: id }, error: null })
  }; } }) }),
});
const securitySource = readFileSync(new URL('../../supabase/functions/_shared/ride24-security.ts', import.meta.url), 'utf8')
  .replace(/^import .*\n/, 'const createClient = globalThis.guideTestCreateClient;\n');
const { requireAdmin } = await import('data:text/javascript;base64,' + Buffer.from(securitySource).toString('base64'));
const checks = [];
const html = '<!doctype html><html lang="pl"><head><meta charset="UTF-8"><title>Żółć — Varna</title></head><body><script>const trasa="Łódź";</script>Trasa</body></html>';
const input = { action: 'upload', title: 'Varna', slug: 'varna', file_name: 'Varna.html', html };
const token = 'github_pat_' + 'fixture'.repeat(5);
const blobSha = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(overrides = {}) {
  const state = { token, guides: [], file: null, http: [], vaultReads: 0, inserts: 0, ...overrides };
  const store = {
    getToken: async () => { state.vaultReads++; return state.token; },
    setToken: async value => { state.token = value; },
    findGuides: async () => state.guides,
    insertGuide: async (title, slug) => {
      state.inserts++;
      if (state.failInsert) throw new Error('DB failure contains private implementation detail');
      const guide = { id: 'fixture-guide', title, slug, folder_name: slug, active: true };
      state.guides.push(guide); return guide;
    },
  };
  const handler = createGuideHandler({
    authorize: async req => { await requireAdmin(req); return store; },
    fetch: async (url, options) => {
      state.http.push({ url, options });
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      if (state.githubError) return response({ token: 'should-never-leak' }, state.githubError);
      if (url === 'https://api.github.com/repos/expol1/ride24') return response({ full_name: 'expol1/ride24', permissions: { push: true } });
      assert.match(url, /^https:\/\/api\.github\.com\/repos\/expol1\/ride24\/contents\/travel-guides\/varna\.html(?:\?ref=main)?$/);
      if (options.method === 'PUT') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.branch, 'main');
        assert.equal('sha' in payload, false);
        const uploaded = Buffer.from(payload.content, 'base64').toString('utf8');
        if (state.file || state.raceFile) {
          state.file ||= { type: 'file', sha: blobSha(state.raceFile) };
          return response({}, 422);
        }
        state.uploaded = uploaded;
        state.file = { type: 'file', sha: blobSha(uploaded) };
        return response({ commit: { sha: 'fixture-commit' } }, 201);
      }
      return state.file ? response(state.file) : response({}, 404);
    },
  });
  return { state, handler };
}
async function call(f, payload = input, bearer = 'admin', extra = {}) {
  const headers = { 'content-type': 'application/json', origin: 'https://ride24.pl', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...extra };
  const r = await f.handler(new Request('https://fixture.test', { method: 'POST', headers, body: JSON.stringify(payload) }));
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function test(name, fn) { await fn(); checks.push(name); }

for (const [bearer, status] of [['',401],['expired',401],['client',403],['partner',403]]) {
  await test(`deny ${bearer || 'anonymous'} before secrets or GitHub`, async () => {
    const f = fixture(); const r = await call(f, input, bearer);
    assert.equal(r.status, status); assert.equal(f.state.vaultReads, 0); assert.equal(f.state.http.length, 0);
  });
}
await test('admin role is loaded for the verified Auth user; user_metadata cannot grant access', async () => {
  const f = fixture(); assert.equal((await call(f, input, 'client')).status, 403); assert.equal(observedProfileId, 'client');
});
await test('successful Unicode HTML is byte-preserved and registered after GitHub', async () => {
  const f = fixture(); const r = await call(f);
  assert.equal(r.status, 200); assert.equal(r.body.success, true); assert.equal(r.body.path, '/travel-guides/varna.html');
  assert.equal(f.state.uploaded, html); assert.equal(f.state.inserts, 1);
  assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(JSON.stringify(r.body).includes(token), false);
});
await test('path, repo and branch supplied by caller cannot redirect publishing', async () => {
  const f = fixture(); assert.equal((await call(f, { ...input, path: '../index.html', repository: 'other/repo', branch: 'evil' })).status, 200);
  assert.equal(f.state.http.some(c => c.url.includes('other/repo')), false);
});
for (const slug of ['../index', 'varna/../index', 'VARNA', 'x.html', 'x,slug.eq.y', '-varna']) {
  await test('reject unsafe slug ' + slug, async () => {
    const f = fixture(); assert.equal((await call(f, { ...input, slug })).status, 400); assert.equal(f.state.http.length, 0);
  });
}
for (const bad of [{ file_name: 'guide.zip' }, { file_name: '../varna.html' }, { html: '<body>fragment</body>' }, { html: html + '\0' }]) {
  await test('reject invalid file/document ' + Object.keys(bad)[0] + checks.length, async () => {
    const f = fixture(); assert.equal((await call(f, { ...input, ...bad })).status, 400); assert.equal(f.state.http.length, 0);
  });
}
await test('size limit uses UTF-8 bytes rather than character count', async () => {
  const f = fixture(); assert.equal((await call(f, { ...input, html: '<html><body>' + 'ą'.repeat(MAX_HTML_BYTES / 2) + '</body></html>' })).status, 413);
});
await test('missing token makes no GitHub write or guide insert', async () => {
  const f = fixture({ token: null }); assert.equal((await call(f)).status, 503); assert.equal(f.state.http.length, 0); assert.equal(f.state.inserts, 0);
});
await test('existing different HTML is never overwritten', async () => {
  const f = fixture({ file: { type: 'file', sha: blobSha('original') } }); assert.equal((await call(f)).status, 409);
  assert.equal(f.state.http.some(c => c.options.method === 'PUT'), false); assert.equal(f.state.inserts, 0);
});
await test('existing symlink/directory is rejected', async () => {
  const f = fixture({ file: { type: 'symlink', sha: blobSha(html) } }); assert.equal((await call(f)).status, 409); assert.equal(f.state.inserts, 0);
});
await test('database failure leaves file intact; retry finishes with one guide', async () => {
  const f = fixture({ failInsert: true }); const first = await call(f); assert.equal(first.status, 502); assert.equal(f.state.file.sha, blobSha(html));
  f.state.failInsert = false; assert.equal((await call(f)).status, 200);
  assert.equal(f.state.http.filter(c => c.options.method === 'PUT').length, 1); assert.equal(f.state.guides.length, 1);
});
await test('lost response retry is idempotent', async () => {
  const f = fixture(); await call(f); const again = await call(f); assert.equal(again.status, 200); assert.equal(again.body.already_saved, true);
  assert.equal(f.state.guides.length, 1); assert.equal(f.state.http.filter(c => c.options.method === 'PUT').length, 1);
});
await test('concurrent different file creation is protected by create-only GitHub PUT', async () => {
  const f = fixture({ raceFile: 'somebody else\'s file' }); assert.equal((await call(f)).status, 409); assert.equal(f.state.inserts, 0);
});
await test('concurrent identical file creation can safely finish registration', async () => {
  const f = fixture({ raceFile: html }); assert.equal((await call(f)).status, 200); assert.equal(f.state.guides.length, 1);
});
await test('status never returns the secret', async () => {
  const f = fixture(); const r = await call(f, { action: 'status' }); assert.deepEqual(r.body, { configured: true, repository: 'expol1/ride24' });
});
await test('configure checks only the fixed repository, then stores token without echoing', async () => {
  const f = fixture(); const r = await call(f, { action: 'configure', token }); assert.equal(r.status, 200);
  assert.deepEqual(r.body, { configured: true }); assert.equal(f.state.http[0].url, 'https://api.github.com/repos/expol1/ride24');
});
await test('invalid configuration cannot change existing credential', async () => {
  const f = fixture(); assert.equal((await call(f, { action: 'configure', token: 'not-a-pat' })).status, 400); assert.equal(f.state.token, token);
});
await test('GitHub permission failure is safe and does not register a guide', async () => {
  const f = fixture({ githubError: 403 }); const r = await call(f); assert.equal(r.status, 502); assert.equal(f.state.inserts, 0);
  assert.equal(JSON.stringify(r.body).includes('should-never-leak'), false);
});
await test('foreign origin denied before authorization or secret access', async () => {
  const f = fixture(); assert.equal((await call(f, input, 'admin', { origin: 'https://evil.example' })).status, 403); assert.equal(f.state.vaultReads, 0);
});
await test('CORS preflight supported without reading secrets', async () => {
  const f = fixture(); const r = await f.handler(new Request('https://fixture.test', { method: 'OPTIONS', headers: { origin: 'https://ride24.pl' } }));
  assert.equal(r.status, 204); assert.equal(f.state.vaultReads, 0);
});
console.log(JSON.stringify({ passed: checks.length, checks, scope: 'isolated Auth, DB and GitHub fixtures; no production writes' }));
