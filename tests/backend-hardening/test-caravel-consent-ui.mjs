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
async function page(responses, catalogResponse = {success:true,catalog:[],unavailable:[]}) {
  const dom = new JSDOM(`<a id="partnerTermsLink" style="display:block"></a><a id="partnerRulesLink" style="display:block"></a>
    <section id="caravelConsent" hidden></section>
    <section id="bookingExtrasPicker" hidden></section><section id="bookingExtrasTotal" hidden></section>
    <section id="equipmentLegacyInfo"></section>
    <input id="acceptTerms" type="checkbox"><button id="confirmBookingBtn"></button>`, {runScripts: 'outside-only', url: 'https://ride24.pl/klient.html'});
  const calls = [];
  dom.window.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'extras-catalog') return {
      ok:true,status:200,json:async()=>catalogResponse,
    };
    calls.push({url, body, auth: opts.headers.Authorization});
    const r = responses.shift();
    return {ok: r.status === 200, status: r.status, json: async () => r.body};
  };
  dom.window.eval(script);
  return {dom, w: dom.window, calls};
}
const view = async (patch = {}) => {
  const v = buildCaravelConsentView(await quoteRow(patch), await loadCaravelRelease(fakeDb(await releasedState())), 'pl', NOW);
  const minor=Math.round(v.money.ride24_fee_minor*4.3);
  v.money.ride24_fee_pln_minor=minor;
  v.money.ride24_fee_pln=(minor/100).toFixed(2)+' PLN';
  return v;
};

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
  assert.match(box.querySelector('.caravel-legal-heading').textContent, /Warunki wynajmu Caravel/);
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

test('Caravel: supplier-confirmed age and one-way fees appear as separate rows, no double-charge',async()=>{
 const v=await view();
 v.money.breakdown={rental_base:'100.00 EUR',customer_rental:'115.00 EUR',fee_total:'50.00 EUR',partner_total:'150.00 EUR',
  fees:[
   {type:'airport_tax',label:'Airport TAX',amount:'0.00 EUR'},
    {type:'young_driver',label:'Młody kierowca',original_label:'Young driver 3 days',amount:'33.00 EUR'},
   {type:'one_way',label:'Zwrot w innym punkcie',original_label:'One-way return',amount:'17.00 EUR'},
  ]};
 const {w}=await page([{status:200,body:{success:true,consent:v}}]);
 await w.Ride24CaravelConsent.prepare({partnerId:PARTNER,apiQuoteId:v.api_quote_id,accessToken:'jwt',supabaseUrl:'u',supabaseKey:'k'});
 const doc=w.document;
 const b=doc.getElementById('caravelConsent');
 const s=b.querySelector('section[aria-label="Rozliczenie Caravel"]');
 assert.ok(s,'visible summary must not be hidden in legal details');
  assert.equal(s.querySelector('h4').textContent, 'Podsumowanie ceny');
  assert.equal(s.classList.contains('booking-price-breakdown'), true, 'Caravel must use the same layout class as AVIA');
  assert.match(s.textContent,/Airport TAX.*0,00\s€/, 'supplier-confirmed free fees remain visible');
  assert.doesNotMatch(s.textContent,/Young driver 3 days/, 'do not duplicate the original supplier label');
 assert.match(s.textContent,/Wynajem samochodu.*115,00\s€/);
 assert.match(s.textContent,/Młody kierowca.*33,00\s€/);
 assert.match(s.textContent,/Zwrot w innym punkcie.*17,00\s€/);
 assert.doesNotMatch(s.textContent,/Łącznie/);
 assert.match(s.textContent,/Do zapłaty partnerowi.*150,00\s€/);
 assert.match(s.textContent,/Online po potwierdzeniu.*64,50/);
 assert.match(s.textContent,/Opłatę Ride24/);
 assert.equal(w.Ride24CaravelConsent.canSubmit(),false);
 doc.getElementById('caravelTermsAccept').checked=true;
 doc.getElementById('caravelCoverageAck').checked=true;
 assert.equal(w.Ride24CaravelConsent.canSubmit(),true);
});

test('Caravel: voluntary GPS switch requests an exact new supplier quote, resets acceptance and updates amounts', async () => {
  const old=await view();
  const newId='5ea5e8db-7244-4416-ab7b-2632bd5f882a';
  const updated={...old,api_quote_id:newId,money:{...old.money,
    rental_at_pickup:'171.00 EUR',customer_total:'188.10 EUR',customer_total_minor:18810,ride24_fee:'17.10 EUR',ride24_fee_minor:1710,ride24_fee_pln_minor:7353,ride24_fee_pln:'73.53 PLN',breakdown:{
      rental_base:'150.00 EUR',customer_rental:'167.10 EUR',fee_total:'0.00 EUR',extras_total:'21.00 EUR',partner_total:'171.00 EUR',
      fees:[],extras:[{extra_id:'gps-1',name:'Nawigacja GPS',quantity:1,amount:'21.00 EUR'}],
    }}};
  const catalog={success:true,catalog:[{
    extra_id:'gps-1',code:'EQ-GPS',name_pl:'Nawigacja GPS',name_en:'GPS',currency:'EUR',
    unit_minor:700,price_cap_minor:null,max_quantity:1,pricing_type:'per_day',
  }],unavailable:[]};
  const {w,calls}=await page([
    {status:200,body:{success:true,consent:old}},
    {status:200,body:{success:true,consent:updated,api_quote_id:newId}},
  ],catalog);
  const d=w.document;
  await w.Ride24CaravelConsent.prepare({partnerId:PARTNER,apiQuoteId:old.api_quote_id,
    accessToken:'jwt',supabaseUrl:'https://example.invalid',supabaseKey:'k'});
  d.getElementById('acceptTerms').checked=true;
  d.getElementById('caravelTermsAccept').checked=true;
  d.getElementById('caravelCoverageAck').checked=true;
  const toggle=d.querySelector('#bookingExtrasPicker input[role="switch"]');
  assert.ok(toggle,'selected Caravel equipment must be accessible in the shared Ride24 modal');
  toggle.checked=true;
  toggle.dispatchEvent(new w.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls[1].body.action,'extras-requote');
  assert.deepEqual(calls[1].body.extras,[{extra_id:'gps-1',quantity:1}]);
  assert.equal(w.localStorage.getItem('selectedApiQuoteId'),newId);
  assert.match(d.getElementById('caravelConsent').textContent,/Nawigacja GPS/);
  assert.match(d.getElementById('caravelConsent').textContent,/171,00\s€/);
  assert.match(d.getElementById('caravelConsent').textContent,/167,10\s€/);
  assert.equal(d.getElementById('acceptTerms').checked,false);
  assert.equal(w.Ride24CaravelConsent.canSubmit(),false,'changed supplier quote always clears the legal consent');
});

test('Caravel second driver selection requotes supplier, updates price and resets consent',async()=>{
 const old=await view();
 const fresh={...old,api_quote_id:'5ea5e8db-7244-4416-ab7b-2632bd5f882a',
   additional_driver_age:22,money:{...old.money,customer_total:'187.00 EUR',
     rental_at_pickup:'170.00 EUR',ride24_fee:'17.00 EUR',ride24_fee_minor:1700,
     ride24_fee_pln_minor:7310,ride24_fee_pln:'73.10 PLN'}};
 const {w,calls}=await page([
   {status:200,body:{success:true,consent:old}},
   {status:200,body:{success:true,consent:fresh,api_quote_id:fresh.api_quote_id}},
 ]);
 await w.Ride24CaravelConsent.prepare({partnerId:PARTNER,apiQuoteId:old.api_quote_id,
   accessToken:'jwt',supabaseUrl:'u',supabaseKey:'k'});
 const d=w.document;
 d.getElementById('acceptTerms').checked=true;
 d.getElementById('caravelTermsAccept').checked=true;
 d.getElementById('caravelCoverageAck').checked=true;
 const selected='9d9d9d9d-1111-4222-8333-444455556666';
 assert.equal(await w.Ride24CaravelConsent.requoteDrivers({
   driverId:null,additionalDriverId:selected}),true);
 assert.equal(calls[1].body.action,'drivers-requote');
 assert.equal(calls[1].body.additional_driver_id,selected);
 assert.equal(w.localStorage.getItem('selectedApiQuoteId'),fresh.api_quote_id);
 assert.match(d.getElementById('caravelConsent').textContent,/187,00\s€/);
 assert.match(d.getElementById('caravelConsent').textContent,/73,10/);
 assert.equal(d.getElementById('acceptTerms').checked,false);
 assert.equal(w.Ride24CaravelConsent.canSubmit(),false);
});

test('Caravel initial profile age 22 triggers supplier re-quote even without changing driver dropdown',async()=>{
 const old=await view();
 const newer={...old,api_quote_id:'5ea5e8db-7244-4416-ab7b-2632bd5f882a',
   driver_age:22,money:{...old.money,customer_total:'198.00 EUR',
     rental_at_pickup:'180.00 EUR',ride24_fee:'18.00 EUR',
     ride24_fee_pln_minor:7740,ride24_fee_pln:'77.40 PLN'}};
 const {w,calls}=await page([
  {status:200,body:{success:true,consent:old}},
  {status:200,body:{success:true,consent:newer}},
 ]);
 await w.Ride24CaravelConsent.prepare({partnerId:PARTNER,apiQuoteId:old.api_quote_id,
   accessToken:'jwt',supabaseUrl:'u',supabaseKey:'k'});
 assert.equal(w.Ride24CaravelConsent.requiresAgeRequote(22),true);
 assert.equal(w.Ride24CaravelConsent.requiresAgeRequote(30),false);
 assert.equal(await w.Ride24CaravelConsent.requoteDrivers({
   driverId:null,additionalDriverId:null,force:true}),true);
 assert.equal(calls[1].body.action,'drivers-requote');
 assert.equal(w.Ride24CaravelConsent.requiresAgeRequote(22),false);
 assert.match(w.document.getElementById('caravelConsent').textContent,/198,00\s€/);
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
  assert.match(w.document.getElementById('caravelConsent').textContent, /180,00\s€/);
  assert.equal(w.Ride24CaravelConsent.canSubmit(), false, 'checkboxes reset after a new price');
  assert.equal(w.localStorage.getItem('selectedApiQuoteId'), fresh.api_quote_id);
});
