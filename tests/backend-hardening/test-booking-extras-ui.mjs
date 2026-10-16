import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createBookingExtras } from '../../assets/helper/bookingExtras.js';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const html='<input id="acceptTerms" type="checkbox"><button id="confirmBookingBtn"></button><section id="bookingPriceBreakdown"></section><div id="bookingExtrasPicker"></div><div id="bookingExtrasTotal"></div><div id="equipmentLegacyInfo"></div>';
const baseQuote={enabled:true,fingerprint:'current',catalog:[],pricing:{currency:'EUR',items:[{kind:'rental',name_pl:'Wynajem',name_en:'Rental',customer_cents:12500}],total_cents:12500,online_pln_cents:10750,pickup_payment_cents:10000,loyalty_discount_cents:0}};
function setup(){globalThis.document=new JSDOM(html).window.document;const ctx={car_class_id:'car',additional_driver_id:null};return {ctx,ui:createBookingExtras({db:{auth:{getSession:async()=>({data:{session:{access_token:'test'}}})}},url:'https://example.test',key:'public',context:()=>({...ctx}),isEn:()=>true})};}
function response(value){return {ok:true,json:async()=>value};}
test('latest quote required and context cannot change behind acceptance',async()=>{const {ui,ctx}=setup();globalThis.fetch=async()=>response(baseQuote);await ui.start();assert.equal(ui.payload().pricing_fingerprint,'current');ctx.car_class_id='changed';assert.throws(()=>ui.payload(),/Review/);});
test('changing extras clears consent and waits for server quote',async()=>{const {ui}=setup();globalThis.fetch=async()=>response({...baseQuote,catalog:[{id:'seat',code:'child_seat',name_en:'Child seat',name_pl:'Fotelik',max_quantity:2,billing:'day',unit_customer_cents:300}]});await ui.start();document.getElementById('acceptTerms').checked=true;let resolve;globalThis.fetch=()=>new Promise(r=>resolve=r);const select=document.querySelector('#bookingExtrasPicker select');select.value='1';select.onchange();assert.equal(document.getElementById('acceptTerms').checked,false);assert.equal(document.getElementById('confirmBookingBtn').disabled,true);await Promise.resolve();await Promise.resolve();resolve(response(baseQuote));await new Promise(r=>setTimeout(r,0));assert.deepEqual(ui.payload().extras,[{id:'seat',quantity:1}]);});
test('late request does not overwrite a newer quote',async()=>{const {ui}=setup();const requests=[];globalThis.fetch=()=>new Promise(r=>requests.push(r));const first=ui.start();await Promise.resolve();await Promise.resolve();const second=ui.refresh();await Promise.resolve();await Promise.resolve();requests[1](response({...baseQuote,fingerprint:'new'}));await second;requests[0](response({...baseQuote,fingerprint:'old'}));await first;assert.equal(ui.payload().pricing_fingerprint,'new');});
test('network error never unlocks booking or silently falls back',async()=>{const {ui}=setup();globalThis.fetch=async()=>{throw new Error('offline')};await ui.start();assert.equal(ui.canSubmit(),false);assert.throws(()=>ui.payload());assert.match(document.getElementById('bookingPriceBreakdown').textContent,/Try again/);});
test('disabled flag retains legacy informational modal',async()=>{const {ui}=setup();globalThis.fetch=async()=>response({enabled:false});await ui.start();assert.deepEqual(ui.payload(),{});assert.equal(document.getElementById('equipmentLegacyInfo').hidden,false);});
test('catalog names are text, never executable HTML',async()=>{const {ui}=setup();globalThis.fetch=async()=>response({...baseQuote,catalog:[{id:'x',code:'custom',name_en:'<img src=x onerror=alert(1)>',name_pl:'X',max_quantity:1,billing:'rental',unit_customer_cents:0}]});await ui.start();assert.equal(document.querySelector('#bookingExtrasPicker img'),null);});
test('inline web scripts parse',async()=>{for(const name of ['klient.html','partner-dashboard.html']){const dom=new JSDOM(await readFile(new URL('../../'+name,import.meta.url),'utf8'));for(const script of dom.window.document.querySelectorAll('script:not([src])')){if(script.type&&!['module','text/javascript'].includes(script.type))continue;const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:script.textContent,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}}});

test('client extras modal shows authoritative selected item and separated Ride24 and partner totals',async()=>{
  const {ui}=setup();
  globalThis.fetch=async()=>response({...baseQuote,
    pricing:{...baseQuote.pricing,items:[
      {kind:'rental',name_pl:'Wynajem',name_en:'Rental',customer_cents:12500},
      {kind:'extra',name_pl:'Fotelik',name_en:'Child seat',quantity:2,days:3,billing:'day',customer_cents:1800}
    ],total_cents:14300,online_pln_cents:12500,pickup_payment_cents:11800}});
  await ui.start();
  const details=document.getElementById('bookingExtrasTotal');
  assert.equal(details.hidden,false);
  assert.match(details.textContent,/Child seat × 2 × 3 days/);
  assert.match(details.textContent,/143/);
  assert.match(details.textContent,/PLN/);
  assert.match(details.textContent,/118/);
});
test('feature flag disabled after selecting paid extra never submits a silent legacy booking',async()=>{
  const {ui}=setup();
  const catalog=[{id:'seat',code:'child_seat',name_en:'Seat',name_pl:'Fotelik',max_quantity:2,billing:'rental',unit_customer_cents:250}];
  globalThis.fetch=async()=>response({...baseQuote,catalog});
  await ui.start();
  const select=document.querySelector('#bookingExtrasPicker select');
  globalThis.fetch=async()=>response({enabled:false});
  select.value='1';
  select.onchange();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(ui.canSubmit(),false);
  assert.equal(document.getElementById('confirmBookingBtn').disabled,true);
  assert.throws(()=>ui.payload(),/unavailable/);
});
test('partner car form relies on refundable cash amount, not an insurance confirmation gate',async()=>{
  const panel=await readFile(new URL('../../partner-dashboard.html',import.meta.url),'utf8');
  assert.doesNotMatch(panel,/featureFullInsuranceConfirmed/);
  assert.match(panel,/if \(lowCash\) lowCash\.checked = amount > 0/);
  assert.match(panel,/cashDepositMethod: amount > 0 \? "cash" : null/);
  assert.match(panel,/featureFullInsurance" checked/);
});
test('client details and partner extras use real catalogue instead of static choice list',async()=>{
  const client=await readFile(new URL('../../klient.html',import.meta.url),'utf8');
  const partnerExtras=await readFile(new URL('../../assets/helper/partnerExtras.js',import.meta.url),'utf8');
  assert.match(client,/window\.ride24BookingsById/);
  assert.match(client,/bookingExtrasTotal/);
  assert.doesNotMatch(client,/Inne wyposażenie według dostępności partnera/);
  assert.match(partnerExtras,/r24-extras-dialog__head/);
  assert.match(partnerExtras,/className='r24-extras-dialog'/);
});
