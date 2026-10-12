// Runs the actual homepage in Chromium. Remote mutations are always blocked.
// Default: isolated fixtures. RIDE24_SEARCH_LIVE=1: anonymous REST GETs only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repo = resolve(directory, '../..');
const live = process.env.RIDE24_SEARCH_LIVE === '1';
const { chromium } = await import(process.env.RIDE24_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.RIDE24_PLAYWRIGHT_PATH).href : 'playwright');
const launchOptions = { headless: true,
  executablePath: process.env.RIDE24_CHROMIUM_PATH || undefined,
  args: process.env.RIDE24_CHROMIUM_ARGS ? JSON.parse(process.env.RIDE24_CHROMIUM_ARGS) : [] };
let browser;

const contentType = file => ({ '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
const resources = [
  ['supabase.js', 'https://unpkg.com/@supabase/supabase-js@2'],
  ['vector.js', 'https://cdn.jsdelivr.net/npm/jsvectormap/dist/js/jsvectormap.min.js'],
  ['world.js', 'https://cdn.jsdelivr.net/npm/jsvectormap/dist/maps/world.js'],
  ['vector.css', 'https://cdn.jsdelivr.net/npm/jsvectormap/dist/css/jsvectormap.min.css'],
  ['flatpickr.js', 'https://cdn.jsdelivr.net/npm/flatpickr'],
  ['flatpickr.css', 'https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css'],
  ['flatpickr-pl.js', 'https://npmcdn.com/flatpickr/dist/l10n/pl.js']
];
const external = new Map();
for (const [file, url] of resources) external.set(url, {
  body: process.env.RIDE24_TEST_EXTERNAL_DIR
    ? await readFile(resolve(process.env.RIDE24_TEST_EXTERNAL_DIR, file))
    : Buffer.from(await (await fetch(url)).arrayBuffer()), contentType: contentType(file) });

const locations = [
  { country: 'Albania', region: 'Tirana', city: 'Tirana', location_name: 'Tirana Airport', type: 'airport', active: true },
  { country: 'Albania', region: '', city: 'Durrës', location_name: 'Durres City', type: 'hotel', active: true },
  { country: 'Cyprus', region: '', city: 'Larnaca', location_name: 'Larnaca Airport (LCA)', type: 'airport', active: true },
  { country: 'Cyprus', region: '', city: 'Paphos', location_name: 'Paphos Airport (PFO)', type: 'airport', active: true },
  { country: 'Cyprus', region: '', city: 'Paphos', location_name: 'Paphos City', type: 'city', active: true },
  { country: 'Cyprus', region: '', city: 'Inactive', location_name: 'Closed Office', type: 'office', active: false },
  { country: 'Bulgaria', region: 'Varna', city: 'Varna', location_name: 'Varna Airport (VAR)', type: 'airport', active: true },
  { country: 'Portugal', region: 'Madeira', city: 'Funchal', location_name: 'Madeira Airport (FNC)', type: 'airport', active: true }
];
const dictionary = [
  { name_en: 'Albania', name_pl: 'Albania', keywords: 'Tirana' },
  { name_en: 'Cyprus', name_pl: 'Cypr', keywords: 'wyspa' },
  { name_en: 'Varna', name_pl: 'Warna', keywords: '' },
  { name_en: 'Madeira', name_pl: 'Madera', keywords: '' },
  { name_en: 'Durrës', name_pl: 'Durres', keywords: 'Dures' }
];
function filtered(rows, url) {
  const filters = [...(url.searchParams.get('or') || '').matchAll(/(\w+)\.ilike\.%([^%]*)%/g)];
  return rows.filter(row => (!filters.length || filters.some(([, field, term]) =>
    String(row[field] || '').toLowerCase().includes(term.toLowerCase()))) &&
    (url.searchParams.get('active') !== 'eq.true' || row.active === true));
}

const report = [];
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    for (const language of ['pl', 'en']) {
      browser = await chromium.launch(launchOptions);
      const context = await browser.newContext({ viewport });
      const writes = [], errors = [], requests = [];
      await context.addInitScript(lang => {
        localStorage.setItem('lang', lang);
        localStorage.setItem('cookie_consent', 'reject');
      }, language);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (!['GET', 'HEAD'].includes(request.method())) {
          writes.push(url.pathname); return route.abort();
        }
        if (url.hostname === 'ride24.test') {
          const file = resolve(repo, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
          if (!file.startsWith(repo + '/')) return route.abort();
          try { return route.fulfill({ body: await readFile(file), contentType: contentType(file) }); }
          catch { return route.fulfill({ status: 404, body: '' }); }
        }
        if (url.hostname.endsWith('.supabase.co')) {
          const table = url.pathname.split('/').pop();
          if (['partner_locations', 'locations_dictionary'].includes(table)) {
            requests.push({ table, filter: url.searchParams.get('or'), active: url.searchParams.get('active') });
            if (live) return route.fulfill({ response: await route.fetch({ timeout: 20000 }) });
          }
          const rows = table === 'partner_locations' ? locations : table === 'locations_dictionary' ? dictionary : [];
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(filtered(rows, url)),
            headers: { 'access-control-allow-origin': '*' } });
        }
        if (external.has(request.url())) return route.fulfill(external.get(request.url()));
        if (url.hostname === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript',
          body: 'window.turnstile={render:()=>1,reset:()=>{}};' });
        return route.fulfill({ body: '' });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('https://ride24.test/', { waitUntil: 'networkidle' });
      for (const [query, expected] of [
        ['albania', ['Durres City', 'Tirana Airport']],
        ['cypr', ['Larnaca Airport (LCA)', 'Paphos Airport (PFO)', 'Paphos City']],
        ['cyprus', ['Larnaca Airport (LCA)', 'Paphos Airport (PFO)', 'Paphos City']],
        ['varna', ['Varna Airport (VAR)']], ['warna', ['Varna Airport (VAR)']],
        ['madera', live ? ['Madeira Airport (FNC)', 'Funchal Office', 'Câmara de Lobos', 'Hotel (Madeira)'] : ['Madeira Airport (FNC)']],
        ['duRES', ['Durres City']],
        ['larnaca', ['Larnaca Airport (LCA)']], ['zzzzride24unknown', []]
      ]) {
        await page.locator('#smart-search-pickup').fill(query);
        await page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname.endsWith('/partner_locations') && url.searchParams.has('or');
        });
        await page.waitForFunction(() => document.getElementById('pickup-results').classList.contains('show'));
        await page.waitForTimeout(80);
        const names = await page.locator('#pickup-results .search-dropdown-item span[style*="font-weight"]').allTextContents();
        assert.deepEqual(names.sort(), [...expected].sort(), `${query}: ${language}, ${viewport.width}`);
        if (expected.length) {
          const first = expected[0];
          await page.locator('#pickup-results .search-dropdown-item').filter({ hasText: first }).click();
          const selection = await page.evaluate(() => ({ pickup: SELECTED_PICKUP, drop: SELECTED_DROP }));
          assert.equal(selection.pickup.location_name, first);
          assert.deepEqual(selection.pickup, selection.drop, 'Pickup still copies to return');
          assert((await page.inputValue('#smart-search-pickup')).includes(first));
          assert.equal(await page.inputValue('#smart-search-pickup'), await page.inputValue('#smart-search-drop'));
          await page.waitForTimeout(320);
        }
        report.push({ query, language, width: viewport.width, matches: names.length });
      }
      // Return can independently search by a Polish country name.
      await page.locator('#smart-search-drop').fill('cypr');
      await page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/partner_locations') && (url.searchParams.get('or') || '').includes('country.ilike.%cyprus%');
      });
      await page.waitForTimeout(80);
      await page.locator('#drop-results .search-dropdown-item').filter({ hasText: 'Paphos City' }).click();
      assert.equal(await page.evaluate(() => SELECTED_DROP.location_name), 'Paphos City');
      assert.equal(await page.evaluate(() => SELECTED_PICKUP.location_name), 'Larnaca Airport (LCA)');
      assert(requests.filter(r => r.table === 'partner_locations' && r.filter).every(r => r.active === 'eq.true'));
      assert.equal(writes.length, 0, 'No remote mutations');
      assert.deepEqual(errors, [], 'No homepage runtime errors');
      await context.close();
      await browser.close();
    }
  }
  console.log(JSON.stringify({ mode: live ? 'anonymous-live-rest' : 'fixtures', passed: report.length,
    selection: 'pickup/drop passed', writes: 0, cases: report }, null, 2));
} finally { await browser?.close(); }
