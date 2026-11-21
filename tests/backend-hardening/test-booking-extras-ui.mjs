import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { createBookingExtras } from '../../assets/helper/bookingExtras.js';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const html='<input id="acceptTerms" type="checkbox"><button id="confirmBookingBtn"></button><section id="bookingPriceBreakdown"></section><div id="bookingExtrasPicker"></div><div id="bookingExtrasTotal"></div><div id="equipmentLegacyInfo"></div>';
const baseQuote={enabled:true,fingerprint:'current',catalog:[],pricing:{currency:'EUR',items:[{kind:'rental',name_pl:'Wynajem',name_en:'Rental',customer_cents:12500}],total_cents:12500,online_pln_cents:10750,pickup_payment_cents:10000,loyalty_discount_cents:0}};
function setup(){globalThis.document=new JSDOM(html).window.document;const ctx={car_class_id:'car',additional_driver_id:null};return {ctx,ui:createBookingExtras({db:{auth:{getSession:async()=>({data:{session:{access_token:'test'}}})}},url:'https://example.test',key:'public',context:()=>({...ctx}),isEn:()=>true})};}
function response(value){return {ok:true,json:async()=>value};}
test('latest quote required and context cannot change behind acceptance',async()=>{const {ui,ctx}=setup();globalThis.fetch=async()=>response(baseQuote);await ui.start();assert.equal(ui.payload().pricing_fingerprint,'current');ctx.car_class_id='changed';assert.throws(()=>ui.payload(),/Review/);});
test('changing extras clears consent and waits for server quote',async()=>{const {ui}=setup();globalThis.fetch=async()=>response({...baseQuote,catalog:[{id:'seat',code:'child_seat',name_en:'Child seat',name_pl:'Fotelik',max_quantity:2,billing:'day',unit_customer_cents:300}]});await ui.start();document.getElementById('acceptTerms').checked=true;let resolve;globalThis.fetch=()=>new Promise(r=>resolve=r);const select=document.querySelector('#bookingExtrasPicker select');select.value='1';select.onchange();assert.equal(document.getElementById('acceptTerms').checked,false);assert.equal(document.getElementById('confirmBookingBtn').disabled,true);await Promise.resolve();await Promise.resolve();resolve(response(baseQuote));await new Promise(r=>setTimeout(r,0));assert.deepEqual(ui.payload().extras,[{id:'seat',quantity:1}]);});
test('one-time extras display real, accessible English switches while multiple seats retain quantity',async()=>{
  const {ui}=setup();
  const catalog=[
    {id:'gps',code:'EQ-GPS',name_en:'GPS',name_pl:'Nawigacja GPS',max_quantity:4,billing:'rental',unit_customer_cents:800},
    {id:'ferry',code:'FEE-FERRY',name_en:'Ferry',name_pl:'Prom',max_quantity:1,billing:'rental',unit_customer_cents:5000},
    {id:'seat',code:'EQ-BABYSEAT',name_en:'Baby seat',name_pl:'Fotelik',max_quantity:4,billing:'rental',unit_customer_cents:1250}
  ];
  globalThis.fetch=async()=>response({...baseQuote,catalog});
  await ui.start();
  const switches=[...document.querySelectorAll('#bookingExtrasPicker input[role="switch"]')];
  assert.equal(switches.length,2);
  assert.ok(switches.every(x=>x.type==='checkbox' && x.checked===false));
  assert.equal(switches[0].getAttribute('aria-label'),'GPS: Yes or No');
  assert.deepEqual([...document.querySelector('#bookingExtrasPicker select').options].map(x=>x.value),['0','1','2','3','4']);
  assert.deepEqual([...document.querySelectorAll('.r24-extra-switch-value')].map(x=>x.textContent),['No','No']);
  switches[0].checked=true;
  switches[0].onchange();
  assert.equal(document.querySelector('.r24-extra-switch-value').textContent,'Yes');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(ui.payload().extras,[{id:'gps',quantity:1}]);
});

test('single-unit supplier extras show switches and update text to No when deselected',async()=>{
  const {ui}=setup();
  globalThis.fetch=async()=>response({...baseQuote,catalog:[{id:'diesel',code:'CUSTOM-DIESEL',name_en:'Diesel car',name_pl:'Diesel',max_quantity:1,billing:'rental',unit_customer_cents:4500}]});
  await ui.start();
  let toggle=document.querySelector('#bookingExtrasPicker input[role="switch"]');
  assert.ok(toggle);
  toggle.checked=true;toggle.onchange();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(ui.payload().extras,[{id:'diesel',quantity:1}]);
  toggle=document.querySelector('#bookingExtrasPicker input[role="switch"]');
  toggle.checked=false;toggle.onchange();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(ui.payload().extras,[]);
  assert.equal(document.querySelector('#bookingExtrasPicker .r24-extra-switch-value').textContent,'No');
});

test('one-time extras switches use Polish labels when the customer language is Polish',async()=>{
  setup();
  // The renderer obtains the current language at creation time, not from the supplier.
  globalThis.fetch=async()=>response({...baseQuote,catalog:[{id:'gps',code:'EQ-GPS',name_en:'GPS',name_pl:'Nawigacja GPS',max_quantity:4,billing:'rental',unit_customer_cents:800}]});
  // The default test setup uses English. Build a separate localized instance with the same contract.
  const localized=createBookingExtras({db:{auth:{getSession:async()=>({data:{session:{access_token:'test'}}})}},url:'https://example.test',key:'public',context:()=>({car_class_id:'car',additional_driver_id:null}),isEn:()=>false});
  await localized.start();
  const toggle=document.querySelector('#bookingExtrasPicker input[role="switch"]');
  assert.equal(toggle.getAttribute('aria-label'),'Nawigacja GPS: Tak lub Nie');
  assert.equal(document.querySelector('.r24-extra-switch-value').textContent,'Nie');
  toggle.checked=true;toggle.onchange();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(document.querySelector('.r24-extra-switch-value').textContent,'Tak');
  assert.deepEqual(localized.payload().extras,[{id:'gps',quantity:1}]);
});

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
  assert.match(panel,/function syncCashDepositOption\(source = "load"\)/);
  assert.match(panel,/lowCash\.checked = hasCashDeposit/);
  assert.match(panel,/amountInput\.disabled = false/);
  assert.match(panel,/cashDepositSelected \? parsedCashDeposit : 0/);
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

test('included protection is not counted as customer-selected equipment',async()=>{
 const {ui}=setup();globalThis.fetch=async()=>response({...baseQuote,pricing:{...baseQuote.pricing,items:[...baseQuote.pricing.items,
 {kind:'extra',name_en:'Included protection',name_pl:'Ochrona',included_in_price:true,quantity:1,customer_cents:0}]},unavailable_services:[
 {name_en:'No deposit',status:'mapping_requires_confirmation'},{name_en:'Snow chains',status:'price_requires_confirmation'}]});
 await ui.start();assert.match(document.getElementById('bookingExtrasTotal').textContent,/Your extras: none/);
 const picker=document.getElementById('bookingExtrasPicker').textContent;assert.doesNotMatch(picker,/No deposit/);assert.match(picker,/Snow chains/);
});

test('customer refund tiers match UTC database rules at 60, 59, 30, 29 days',async()=>{
  const html=await readFile(new URL('../../klient.html',import.meta.url),'utf8');
  const match=html.match(/function calculateRefundPercent\(pickupDate\) \{[\s\S]*?\n\}/);
  assert.ok(match,'client refund calculator found');
  const FixedDate=class extends Date {
    constructor(...args){super(...(args.length?args:['2026-11-14T12:00:00.000Z']));}
  };
  const calculate=vm.runInNewContext('('+match[0]+')',{Date:FixedDate});
  assert.equal(calculate('2027-01-13'),90);
  assert.equal(calculate('2027-01-12'),50);
  assert.equal(calculate('2026-12-14'),50);
  assert.equal(calculate('2026-12-13'),0);
  assert.equal(calculate('invalid'),0);
});


test('Arvent booking details show saved references, route, main driver, supplier rental, extra and fee separately',async()=>{
 const source=await readFile(new URL('../../klient.html',import.meta.url),'utf8');
 const start=source.indexOf('window.openDetailsModal = function(');
 const end=source.indexOf('window.closeDetailsModal = function()',start);
 assert.ok(start>=0 && end>start);
 assert.match(source,/api_booking_reference,\s*main_driver_name,/);
 const dom=new JSDOM('<div id="bookingDetailsModal"><div id="bookingDetailsBody"></div></div>');
 const booking={
  id:'b',reservation_code:'R24-2026-42',api_booking_reference:'ARV-765',
  main_driver_name:'Jan Kowalski',start_date:'2027-01-10',end_date:'2027-01-13',
  pickup_time:'10:00',return_time:'10:00',pickup_location:'Antalya Airport',
  return_location:'Istanbul Airport',
  vehicle_snapshot:{group_name:'Economy',sipp:'EDMR'},
  car_classes:{partners:{api_provider:'arvent_kolaycar',currency:'EUR'}},
  pricing_items_snapshot:{version:2,currency:'EUR',items:[
   {kind:'rental',name_en:'Car rental',name_pl:'Wynajem samochodu',
    customer_cents:10339,partner_cents:10000,quantity:1,days:3,billing:'rental'},
   {kind:'extra',name_en:'Additional driver',name_pl:'Dodatkowy kierowca',
    customer_cents:1200,partner_cents:1200,quantity:1,days:3,billing:'day'}],
   commission_cents:339,partner_cents:11200,gross_cents:11539,total_cents:11539,
   online_pln_cents:1450,loyalty_discount_cents:0},
  deposit_snapshot:0
 };
 const win={ride24BookingsById:{b:booking},ride24VehicleLabel:()=> 'Economy (EDMR)'};
 new Function('window','document','localStorage','db',source.slice(start,end))(
  win,dom.window.document,{getItem:()=> 'pl'},null);
 win.openDetailsModal(0,null,false,'','EUR','','','b');
 const details=dom.window.document.getElementById('bookingDetailsBody');
 assert.match(details.textContent,/Economy \(EDMR\)/);
 assert.match(details.textContent,/R24-2026-42/);
 assert.match(details.textContent,/ARV-765/);
 assert.match(details.textContent,/Jan Kowalski/);
 assert.match(details.textContent,/Antalya Airport/);
 assert.match(details.textContent,/Istanbul Airport/);
 const rows=[...details.querySelectorAll('.r24-client-price-row')];
 const find=(label)=>rows.find(x=>x.firstElementChild.textContent.includes(label))?.lastElementChild.textContent;
 assert.equal(find('Wynajem samochodu'),'100.00 EUR');
 assert.equal(find('Dodatkowy kierowca'),'12.00 EUR');
 assert.equal(find('Opłata rezerwacyjna Ride24'),'3.39 EUR');
 assert.equal(find('Cena łączna'),'115.39 EUR');
 assert.equal(find('Opłata Ride24 online'),'14.50 PLN');
 assert.equal(find('Do zapłaty Arvent przy odbiorze'),'112.00 EUR');
 assert.equal(details.querySelectorAll('.r24-arvent-booking-summary').length,1);
});

test('Arvent-only details improvements leave AVIA and local booking pricing unchanged',async()=>{
 const src=await readFile(new URL('../../klient.html',import.meta.url),'utf8');
 const start=src.indexOf('window.openDetailsModal = function(');
 const end=src.indexOf('window.closeDetailsModal = function()',start);
 const dom=new JSDOM('<div id="bookingDetailsModal"><div id="bookingDetailsBody"></div></div>');
 const booking={id:'x',car_classes:{partners:{api_provider:'avia',currency:'EUR'}},
  pricing_items_snapshot:{version:2,currency:'EUR',items:[{kind:'rental',name_en:'Rental',
   name_pl:'Wynajem',customer_cents:10339,partner_cents:10000}],
   online_pln_cents:1450,partner_cents:10000,total_cents:10339,loyalty_discount_cents:0},
  deposit_snapshot:0};
 const win={ride24BookingsById:{x:booking}};
 new Function('window','document','localStorage','db',src.slice(start,end))(
  win,dom.window.document,{getItem:()=> 'pl'},null);
 win.openDetailsModal(0,null,false,'','EUR','','','x');
 const el=dom.window.document.getElementById('bookingDetailsBody');
 assert.equal(el.querySelector('.r24-arvent-booking-summary'),null);
 const rental=[...el.querySelectorAll('.r24-client-price-row')]
  .find(row=>row.firstElementChild.textContent==='Wynajem');
 assert.equal(rental.lastElementChild.textContent,'103.39 EUR');
 assert.doesNotMatch(el.textContent,/Opłata rezerwacyjna Ride24/);
});
test('Arvent: neutral server summary and no online extras; booking may continue',async()=>{
  const {ui}=setup();
  globalThis.fetch=async()=>response({enabled:false,arvent:{api_quote_id:'q',currency:'EUR',billed_days:3,start_date:'2026-12-10',end_date:'2026-12-13',
    pickup_time:'10:00',return_time:'10:00',pickup_location:'Antalya Airport (AYT)',return_location:'Antalya Airport (AYT)',
    category:{group_name:'Economy',example_model:'Citroen C Elysee',sipp:'EDMR'},rental_total:84.75,mandatory_fees:[],extras:[],extra_catalog:[{code:'1',name:'GPS'},{code:'6',name:'Infant seat'}],offer_extras:{status:'present',items:[{code:'2',name:'Ek Sürücü',kind:'additional_driver',price_eur:4.99},{code:'1',name:'GPS',price_eur:3.5}]},
    total:88.14,ride24_fee:3.39,loyalty_discount_percent:0,exchange_rate:4.2345,online_pln:14.35,pay_on_pickup:84.75}});
  await ui.start();
  const box=document.getElementById('bookingPriceBreakdown');
  assert.equal(box.hidden,false);
  const picker=document.getElementById('bookingExtrasPicker');
  assert.equal(picker.hidden,false);
  assert.match(picker.textContent,/Availability was retrieved for your rental dates/);
  assert.match(picker.textContent,/GPS/);
  assert.match(picker.textContent,/Infant seat/);
  assert.match(picker.textContent,/Additional driver/);
  assert.match(picker.textContent,/€4.99/);
  assert.match(picker.textContent,/billing terms still require confirmation/);
  assert.match(picker.textContent,/Not priced for this offer/);
  assert.match(picker.textContent,/Other catalogue extras/);
  assert.equal(picker.querySelectorAll('details').length,1);
  assert.equal(picker.querySelectorAll('details .booking-extra-row').length,1);
  assert.equal(picker.querySelectorAll(':scope > .booking-extra-row').length,2);
  assert.equal(picker.querySelector('details').open,false);
  assert.equal(picker.querySelectorAll('button,input,select').length,0);
  assert.equal(picker.querySelectorAll('input,select').length,0);
  const text=box.textContent;
  for(const part of ['Price summary','Billed rental days','3','Extras','None','€88.14','€84.75','PLN','Pay at pickup','EDMR'])assert.ok(text.includes(part),part);
  assert.ok(/14\.35/.test(text));
  assert.doesNotMatch(text,/Arvent|Stripe/);
  assert.equal(box.querySelectorAll('h4').length,1);
  await ui.refresh();
  assert.equal(box.querySelectorAll('h4').length,1);
  assert.equal(picker.querySelectorAll('p').length,1);
  assert.equal(ui.canSubmit(),true);
  assert.deepEqual(ui.payload(),{});
});


test('Arvent code-2 checkbox requotes server at 4 EUR per day, without second-driver identity',async()=>{
 const {ui}=setup();
 const base={api_quote_id:'vehicle-quote',currency:'EUR',billed_days:3,start_date:'2026-12-10',end_date:'2026-12-13',
  pickup_time:'10:00',return_time:'10:00',pickup_location:'Antalya Airport (AYT)',
  return_location:'Antalya Airport (AYT)',category:{sipp:'EDMR'},
  rental_total:84.75,mandatory_fees:[],extras:[],
  extra_catalog:[{code:'2',name:'Additional driver'}],
  offer_extras:{status:'present',items:[{code:'2',name:'Additional driver',price_eur:4,billing:'day',
    billing_type:'day',max_quantity:1,quantity_increasable:false,bookable:true}]},
  total:88.14,ride24_fee:3.39,loyalty_discount_percent:0,exchange_rate:4.2345,online_pln:14.35,pay_on_pickup:84.75};
 const requests=[];
 globalThis.fetch=async(_url,opts)=>{
  const body=JSON.parse(opts.body);requests.push(body);
  const extras=body.extras||[];
  if(!extras.length)return response({enabled:false,arvent:base});
  return response({enabled:true,api_quote_id:'derived-quote',fingerprint:'proof',
   arvent:{...base,api_quote_id:'derived-quote',
     extras:[{code:'2',name:'Additional driver',quantity:1,days:3,billing:'day',total_cents:1200}],
     total:100.14,pay_on_pickup:96.75}});
 };
 await ui.start();
 const picker=document.getElementById('bookingExtrasPicker');
 const checkbox=picker.querySelector('input[type=checkbox]');
 assert.ok(checkbox,'supplier-quoted extra driver checkbox available');
 checkbox.checked=true;checkbox.onchange();
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(requests.at(-1).extras,[{id:'2',quantity:1}]);
 assert.equal(requests.at(-1).additional_driver_id,null);
 assert.equal(document.getElementById('bookingPriceBreakdown').textContent.includes('€100.14'),true);
 const payload=ui.payload();
 assert.equal(payload.pricing_version,2);
 assert.equal(payload.api_quote_id,'derived-quote');
 assert.equal(payload.pricing_fingerprint,'proof');
 assert.deepEqual(payload.extras,[{id:'2',quantity:1}]);
});
test('Arvent extras catalogue tile is visible; other partners keep their normal selectable extras tile', async () => {
  const source = await readFile(new URL('../../klient.html', import.meta.url), 'utf8');
  const start = source.indexOf('window.ride24ArventFormMode = function(on) {');
  const stop = source.indexOf('window.ride24ArventGoToProfile = function', start);
  assert.ok(start > 0 && stop > start);
  const dom = new JSDOM(`<div id="termsModal">
    <div class="r24-extras-callout"><button type="button" class="docs-extra-item">
      <span class="r24-extras-copy"><strong>Wybierz dodatki do wynajmu</strong>
        <small>Zobacz dostępne usługi i ich aktualną cenę.</small></span>
      <span class="r24-extras-action">Sprawdź</span>
    </button></div>
    <p id="arventExtrasInfo" hidden></p>
    <section id="bookingPriceBreakdown"></section><div class="docs-container"></div>
  </div><div id="equipmentInfoModal"><h3>Wybierz dodatki do wynajmu</h3></div>`);
  const win = dom.window;
  vm.runInNewContext(source.slice(start, stop), {window:win,document:win.document,localStorage:{getItem:()=> 'pl'}});
  const callout=win.document.querySelector('.r24-extras-callout');
  const title=callout.querySelector('strong');
  const note=callout.querySelector('small');
  const docs=win.document.querySelector('.docs-container');
  const price=win.document.querySelector('#bookingPriceBreakdown');
  win.ride24ArventFormMode(true);
  assert.equal(callout.hidden,false);
  assert.equal(callout.style.getPropertyValue('display'),'');
  assert.equal(title.textContent,'Katalog dodatków do wynajmu');
  assert.match(note.textContent,/Sprawdź usługi partnera/);
  assert.equal(docs.nextElementSibling,price);
  win.ride24ArventFormMode(false);
  assert.equal(callout.hidden,false);
  assert.equal(title.textContent,'Wybierz dodatki do wynajmu');
  assert.equal(note.textContent,'Zobacz dostępne usługi i ich aktualną cenę.');
  assert.equal(callout.querySelector('button').disabled,false);
  assert.equal(win.document.querySelectorAll('.r24-extras-callout').length,1);
});
