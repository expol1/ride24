// Actual homepage scripts and map assets run in Chromium. All remote requests are
// isolated: fixture GET responses only, no accounts, reservations or notifications.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repo = resolve(directory, '../..');
const { chromium } = await import(process.env.RIDE24_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.RIDE24_PLAYWRIGHT_PATH).href : 'playwright');
const args = process.env.RIDE24_CHROMIUM_ARGS ? JSON.parse(process.env.RIDE24_CHROMIUM_ARGS) : [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.RIDE24_CHROMIUM_PATH || undefined, args });
const fixture = JSON.parse(await readFile(resolve(directory, 'locations-fixture.json'), 'utf8'));
const output = resolve(directory, 'test-results');
await mkdir(output, { recursive: true });
const external = new Map();
const resources = [
  ['supabase.js', 'https://unpkg.com/@supabase/supabase-js@2'],
  ['vector.js', 'https://cdn.jsdelivr.net/npm/jsvectormap/dist/js/jsvectormap.min.js'],
  ['world.js', 'https://cdn.jsdelivr.net/npm/jsvectormap/dist/maps/world.js'],
  ['vector.css', 'https://cdn.jsdelivr.net/npm/jsvectormap/dist/css/jsvectormap.min.css'],
  ['flatpickr.js', 'https://cdn.jsdelivr.net/npm/flatpickr'],
  ['flatpickr.css', 'https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css'],
  ['flatpickr-pl.js', 'https://npmcdn.com/flatpickr/dist/l10n/pl.js']
];
for (const [name, url] of resources) {
  const content = process.env.RIDE24_TEST_EXTERNAL_DIR
    ? await readFile(resolve(process.env.RIDE24_TEST_EXTERNAL_DIR, name))
    : Buffer.from(await (await fetch(url)).arrayBuffer());
  external.set(url, content);
}
const type = path => ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extname(path)] || 'application/octet-stream');
const report = [];

async function pageFor(viewport, { language = 'pl', legacy = false, assetFailure = false, rows = fixture } = {}) {
  const context = await browser.newContext({ viewport });
  const requests = [];
  const writes = [];
  const errors = [];
  const warnings = [];
  await context.addInitScript(value => {
    localStorage.setItem('lang', value);
    // User dismisses the independent cookie banner before using the map.
    localStorage.setItem('cookie_consent', 'reject');
  }, language);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ url: request.url(), method: request.method() });
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(request.url());
      return route.abort();
    }
    if (url.hostname === 'ride24.test') {
      let file = resolve(repo, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(repo + '/')) return route.abort();
      if (assetFailure && url.pathname.endsWith('/maps/regions-v1.json')) return route.fulfill({ status: 503, body: 'Fixture asset failure' });
      try { return route.fulfill({ contentType: type(file), body: await readFile(file) }); }
      catch { return route.fulfill({ status: 404, body: 'Not found' }); }
    }
    if (url.hostname.endsWith('.supabase.co')) {
      let data = [];
      if (url.pathname.endsWith('/partner_locations')) {
        data = rows;
        const country = url.searchParams.get('country');
        if (country?.startsWith('eq.')) data = data.filter(item => item.country === country.slice(3));
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });
    }
    if (external.has(request.url())) return route.fulfill({ contentType: type(resources.find(item => item[1] === request.url())[0]), body: external.get(request.url()) });
    if (url.hostname === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={render:()=>1,reset:()=>{}};' });
    return route.fulfill({ status: 200, body: '' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await page.goto('https://ride24.test/' + (legacy ? '?ride24Map=legacy' : ''), { waitUntil: 'networkidle' });
  return { page, context, requests, writes, errors, warnings };
}

try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 640 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    const state = await pageFor(viewport);
    const { page } = state;
    assert(!state.requests.some(r => r.url.includes('regions-v1.json')), 'Geometry must load only after opening map');
    await page.evaluate(() => openWorldMap());
    await page.waitForSelector('.r24-map-coverage');
    assert.equal(await page.locator('.r24-map-coverage').count(), 5);
    assert.equal(await page.locator('#worldMapSvg svg text').count(), 0, 'No map labels or counters');
    assert.equal(await page.locator('.r24-area-count').count(), 0, 'No location count before selection');
    assert.equal(await page.locator('#worldMapModal img').count(), 0, 'No logo');
    const layout = await page.evaluate(() => {
      const m = document.querySelector('.world-map-content');
      const p = document.getElementById('worldMapSvg').getBoundingClientRect();
      const list = document.querySelector('.world-locations-panel').getBoundingClientRect();
      return { horizontalOverflow: m.scrollWidth - m.clientWidth, scroll: m.scrollHeight - m.clientHeight, sideBySide: list.left > p.left + p.width - 2, bottom: m.getBoundingClientRect().bottom };
    });
    assert(layout.horizontalOverflow <= 1, 'No horizontal scrolling');
    assert(layout.bottom <= viewport.height + 1, 'Modal must fit viewport');
    assert(layout.scroll <= 75, 'Initial view needs at most a short scroll on the smallest phones');
    assert.equal(layout.sideBySide, viewport.width > 768 || viewport.height < 500 && viewport.width > 600);
    await page.locator('.r24-map-target[data-area="CY"]').click();
    assert.equal(await page.locator('.r24-area-count strong').textContent(), '3');
    assert.equal(await page.locator('.r24-map-location').count(), 3);
    assert.equal(await page.locator('.r24-map-coverage.is-selected').count(), 1);
    assert.equal(await page.locator('#worldMapSvg svg text').count(), 0);
    await page.screenshot({ path: resolve(output, 'map-' + viewport.width + '-cyprus.png') });
    await page.locator('.r24-map-location').filter({ hasText: 'Larnaca Airport (LCA)' }).click();
    assert.equal(await page.inputValue('#smart-search-pickup'), 'Larnaca Airport (LCA)');
    assert.equal(await page.inputValue('#smart-search-drop'), 'Larnaca Airport (LCA)');
    await page.waitForTimeout(750);
    const selection = await page.evaluate(() => ({ pickup: SELECTED_PICKUP, drop: SELECTED_DROP, dropdowns: [...document.querySelectorAll('#pickup-results,#drop-results')].some(x => x.classList.contains('show')) }));
    assert.equal(selection.pickup.country, 'Cyprus');
    assert.equal(selection.pickup.city, 'Larnaca');
    assert.deepEqual(selection.pickup, selection.drop);
    assert.equal(selection.dropdowns, false);
    assert.equal(await page.locator('#worldMapModal').isVisible(), false);

    // Reopen and exercise separate island lists plus expansion of the mainland list.
    for (const [id, count] of [['PT-AZORES', 3], ['PT-MADEIRA', 4], ['BG', 2], ['PT', 10]]) {
      await page.evaluate(() => openWorldMap());
      await page.locator('.r24-map-target[data-area="' + id + '"]').click();
      assert.equal(await page.locator('.r24-area-count strong').textContent(), String(count));
      assert.equal(await page.locator('.r24-map-location').count(), Math.min(count, 4));
      if (count > 4) {
        await page.locator('.r24-map-more').click();
        assert.equal(await page.locator('.r24-map-location').count(), count);
      }
      await page.locator('.r24-map-back').click();
      assert.equal(await page.locator('.r24-area-count').count(), 0);
      await page.evaluate(() => closeWorldMap());
    }
    // Search proceeds with the existing object and dates, without creating a booking.
    await page.evaluate(() => openWorldMap());
    await page.locator('.r24-map-target[data-area="PT-AZORES"]').click();
    await page.locator('.r24-map-location').filter({ hasText: 'Ponta Delgada Airport (PDL)' }).click();
    const pickupDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const dropDate = new Date(Date.now() + 34 * 86400000).toISOString().slice(0, 10);
    await page.evaluate(([pickup, drop]) => {
      document.getElementById('pickup-date').value = pickup;
      document.getElementById('drop-date').value = drop;
    }, [pickupDate, dropDate]);
    await page.locator('#searchBtn').click();
    const search = await page.evaluate(() => JSON.parse(localStorage.getItem('searchParams')));
    assert.equal(search.pickup_location.location_name, 'Ponta Delgada Airport (PDL)');
    assert.equal(search.pickup_location.region, 'Azores');
    assert.deepEqual(search.pickup_location, search.drop_location);
    assert.equal(search.pickup_date, pickupDate);
    assert.equal(state.writes.length, 0, 'No remote writes');
    assert.deepEqual(state.errors, [], 'No homepage runtime errors');
    assert(!state.warnings.some(value => value.includes('restoring the previous map')), 'New map must not silently fall back in normal cases');
    report.push({ viewport, layout, locations: 22, selection: 'passed', search: 'passed' });
    await state.context.close();
  }

  const english = await pageFor({ width: 390, height: 844 }, { language: 'en' });
  await english.page.evaluate(() => openWorldMap());
  await english.page.locator('.r24-map-target[data-area="PT"]').click();
  assert.equal(await english.page.locator('#countryLocationsTitle').textContent(), 'Mainland Portugal');
  assert.match(await english.page.locator('.r24-area-count').textContent(), /10locations/);
  await english.page.evaluate(() => setLang('pl'));
  assert.equal(await english.page.locator('#countryLocationsTitle').textContent(), 'Portugalia kontynentalna');
  await english.page.keyboard.press('Escape');
  assert.equal(await english.page.locator('#worldMapModal').isVisible(), false);
  assert.deepEqual(english.errors, []);
  await english.context.close();

  // Island-only offers must not paint mainland Italy, and northern Cyprus must
  // not be grouped into the existing southern area.
  const island = await pageFor({ width: 1280, height: 800 }, { rows: [
    { id: 'sicily-fixture', country: 'Italy', region: 'Sicily', city: 'Catania', location_name: 'Catania Airport (CTA)', type: 'airport', active: true },
    { id: 'north-fixture', country: 'Cyprus', region: 'Northern Cyprus', city: 'Girne', location_name: 'Ercan Airport (ECN)', type: 'airport', active: true }
  ] });
  await island.page.evaluate(() => openWorldMap());
  assert.equal(await island.page.locator('.r24-map-coverage[data-area="IT-SICILY"]').count(), 1);
  assert.equal(await island.page.locator('.r24-map-coverage[data-area="IT"]').count(), 0);
  assert.equal(await island.page.locator('.r24-map-coverage[data-area="CY-NORTH"]').count(), 1);
  assert.equal(await island.page.locator('.r24-map-coverage[data-area="CY"]').count(), 0);
  await island.context.close();

  const empty = await pageFor({ width: 320, height: 568 }, { rows: [] });
  await empty.page.evaluate(() => openWorldMap());
  assert.equal(await empty.page.locator('.r24-map-coverage').count(), 0);
  assert.match(await empty.page.locator('#countryLocations').textContent(), /Brak aktywnych/);
  await empty.context.close();

  const closing = await pageFor({ width: 390, height: 844 });
  await closing.page.evaluate(() => {
    openWorldMap();
    closeWorldMap();
  });
  await closing.page.waitForTimeout(200);
  assert.equal(await closing.page.locator('#worldMapModal').isVisible(), false, 'Late load cannot reopen closed map');
  await closing.page.evaluate(() => Promise.all([openWorldMap(), openWorldMap()]));
  await closing.page.evaluate(() => closeWorldMap());
  assert.equal(await closing.page.evaluate(() => document.body.style.overflow), '', 'Rapid repeated opening must restore page scrolling');
  await closing.context.close();

  for (const options of [{ legacy: true }, { assetFailure: true }]) {
    const state = await pageFor({ width: 1280, height: 800 }, options);
    await state.page.evaluate(() => openWorldMap());
    await state.page.waitForSelector('#worldMapSvg.jvm-container svg');
    assert.equal(await state.page.locator('#worldMapModal.r24-regions').count(), 0, 'Legacy fallback active');
    await state.page.evaluate(() => loadLocations('Cyprus'));
    await state.page.locator('.country-location-item').filter({ hasText: 'Larnaca Airport (LCA)' }).click();
    assert.equal(await state.page.inputValue('#smart-search-pickup'), 'Larnaca Airport (LCA)');
    assert.equal(state.writes.length, 0);
    await state.context.close();
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, report, language: 'PL/EN', fallback: 'passed', islands: 'passed', empty: 'passed', closeRace: 'passed', remoteWrites: 0 }, null, 2));
  console.log(JSON.stringify({ passed: true, viewports: report.length, language: 'PL/EN', fallback: 'passed', islands: 'passed', empty: 'passed', closeRace: 'passed', remoteWrites: 0 }));
} finally {
  await browser.close();
}
