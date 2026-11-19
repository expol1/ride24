// WWW Caravel consent block (assets/caravel-consent.js) in a real DOM (jsdom):
// shown only for Caravel, renders the server view, requires both confirmations,
// echoes exactly what was shown, re-renders after a driver-age re-quote.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {loadCaravelRelease} from '../../supabase/functions/_shared/caravel-release.ts';
import {buildCaravelConsentView} from '../../supabase/functions/_shared/caravel-consent.ts';
import {fakeDb, releasedState, quoteRow, PARTNER, NOW} from '../fixtures/caravel/checkout-fixtures.mjs';

const script = await readFile(new URL('../../assets/caravel-consent.js', import.meta.url), 'utf8');
async function page(responses) {
  const dom = new JSDOM(`<a id="partnerTermsLink" style="display:block"></a><a id="partnerRulesLink" style="display:block"></a>
    <section id="caravelConsent" hidden></section>`, {runScripts: 'outside-only', url: 'https://ride24.pl/klient.html'});
  const calls = [];
  dom.window.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push({url, body, auth: opts.headers.Authorization});
    const r = responses.shift();
    return {ok: r.status === 200, status: r.status, json: async () => r.body};
  };
  dom.window.eval(script);
  return {dom, w: dom.window, calls};
}
const view = async (patch = {}) => buildCaravelConsentView(await quoteRow(patch), await loadCaravelRelease(fakeDb(await releasedState())), 'pl', NOW);

test('non-Caravel partner: block stays hidden, PDF links untouched (AVIA and others unchanged)', async () => {
  const {w, calls} = await page([]);
  assert.equal(await w.Ride24CaravelConsent.prepare({partnerId: '91e04805-31da-4242-9e6f-b6075019d784'}), false);
  assert.equal(w.document.getElementById('caravelConsent').hidden, true);
  assert.equal(w.document.getElementById('partnerTermsLink').style.display, 'block');
  assert.equal(calls.length, 0);
  assert.equal(w.Ride24CaravelConsent.active(), false);
});

test('Caravel: server terms + exclusions shown, both confirmations required, echo equals what was shown', async () => {
  const v = await view();
  const {w, calls} = await page([{status: 200, body: {success: true, consent: v}}]);
  assert.equal(await w.Ride24CaravelConsent.prepare({partnerId: PARTNER, apiQuoteId: v.api_quote_id, accessToken: 'jwt',
    supabaseUrl: 'https://example.invalid', supabaseKey: 'k'}), true);
  const d = w.document;
  assert.equal(calls[0].body.action, 'consent-view');
  assert.equal(calls[0].auth, 'Bearer jwt');
  assert.equal(d.getElementById('partnerTermsLink').style.display, 'none', 'supplier PDFs are comparison only');
  const box = d.getElementById('caravelConsent');
  assert.equal(box.hidden, false);
  const disclosures = [...box.querySelectorAll('details')];
  assert.equal(disclosures.length, 2, 'the binding terms and details are individually clickable');
  assert.ok(disclosures.every(section => !section.open), 'lengthy legal text must be collapsed by default');
  assert.match(disclosures[0].querySelector('summary').textContent, /Otwórz regulamin Caravel/);
  assert.match(disclosures[1].querySelector('summary').textContent, /Ochrona, wyłączenia i opłaty/);
  assert.match(box.querySelector('strong').textContent, /przeczytaj przed zaznaczeniem zgód/);
  assert.match(box.textContent, /Pakiet Premium w cenie/);
  assert.match(box.textContent, /szyby, opony i koła, podwozie/);
  assert.match(box.textContent, /100\.00 EUR/);
  assert.match(box.textContent, /Stripe pobiera wyłącznie osobną opłatę rezerwacyjną Ride24/);
  assert.match(d.getElementById('caravelTermsBody').innerHTML, /<strong>An administration fee of EUR 100/);
  assert.equal(w.Ride24CaravelConsent.canSubmit(), false);
  d.getElementById('caravelTermsAccept').checked = true;
  assert.equal(w.Ride24CaravelConsent.canSubmit(), false, 'coverage acknowledgement is separate');
  d.getElementById('caravelCoverageAck').checked = true;
  assert.equal(w.Ride24CaravelConsent.canSubmit(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(w.Ride24CaravelConsent.consentPayload())),
    {...v.echo, accepted: true, coverage_acknowledged: true});
});

test('Caravel: unbookable quote shows the server message and blocks submission', async () => {
  const {w} = await page([{status: 409, body: {code: 'CARAVEL_CERTIFICATION_PENDING', error: 'Oferty Caravel są chwilowo niedostępne.'}}]);
  assert.equal(await w.Ride24CaravelConsent.prepare({partnerId: PARTNER, apiQuoteId: 'x', accessToken: 'jwt', supabaseUrl: 'u', supabaseKey: 'k'}), false);
  assert.match(w.document.getElementById('caravelConsent').textContent, /chwilowo niedostępne/);
  assert.equal(w.Ride24CaravelConsent.canSubmit(), false);
});

test('Caravel: driver-age re-quote re-renders the new price and requires confirming again', async () => {
  const v = await view();
  const fresh = {...v, api_quote_id: '5ea5e8db-7244-4416-ab7b-2632bd5f882a', money: {...v.money, rental_at_pickup: '180.00 EUR'},
    statements: v.statements.map((s) => s.replace('150.00 EUR', '180.00 EUR'))};
  const {w, calls} = await page([{status: 200, body: {success: true, consent: v}},
    {status: 409, body: {code: 'CARAVEL_REQUOTED_FOR_DRIVER_AGE', consent: fresh, error: 'Cena została przeliczona'}}]);
  await w.Ride24CaravelConsent.prepare({partnerId: PARTNER, apiQuoteId: v.api_quote_id, accessToken: 'jwt', supabaseUrl: 'u', supabaseKey: 'k'});
  w.document.getElementById('caravelTermsAccept').checked = true;
  w.document.getElementById('caravelCoverageAck').checked = true;
  const r = await w.Ride24CaravelConsent.book({accessToken: 'jwt', supabaseUrl: 'u', supabaseKey: 'k', driverId: 'd1'});
  assert.equal(calls[1].body.action, 'book');
  assert.equal(calls[1].body.consent.accepted, true);
  assert.equal(r.body.code, 'CARAVEL_REQUOTED_FOR_DRIVER_AGE');
  assert.match(w.document.getElementById('caravelConsent').textContent, /180\.00 EUR/);
  assert.equal(w.Ride24CaravelConsent.canSubmit(), false, 'checkboxes reset after a new price');
  assert.equal(w.localStorage.getItem('selectedApiQuoteId'), fresh.api_quote_id);
});
