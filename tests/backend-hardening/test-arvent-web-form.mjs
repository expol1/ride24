import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as contract from '../../supabase/functions/_shared/api-quote-contract.mjs';
import * as driverAge from '../../supabase/functions/_shared/driver-age.mjs';
import * as options from '../../supabase/functions/_shared/booking-options.mjs';
import * as arventPricing from '../../supabase/functions/_shared/arvent-extras-pricing.mjs';

const ARVENT='bf29a373-c464-4cec-87a7-c3218ea1ea51';
const QUOTE='22222222-2222-4222-8222-222222222222';
const source=await readFile(new URL('../../supabase/functions/booking-options/index.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const durationModule=await readFile(new URL('../../supabase/functions/_shared/rental-duration.ts',import.meta.url),'utf8');
const durationJs=ts.transpileModule(durationModule,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const durationSandbox={exports:{}};vm.runInNewContext(durationJs,durationSandbox);
const duration=durationSandbox.exports;

function setup({quote={},rate=4.2345,loyalty=0,rateFails=false,offerError=null,extraSettings={},offerItems=null}={}){
 let handler;const calls=[];let savedExtrasQuote=null;
 const q={id:QUOTE,partner_id:ARVENT,car_class_id:'car',booking_id:null,start_date:'2026-12-10',end_date:'2026-12-13',
  external_group_id:'EDMR',partner_net_total:84.75,commission_total:3.39,final_total:88.14,currency:'EUR',expires_at:new Date(Date.now()+600000).toISOString(),
  raw_response:{ride24_display:{class_code:'A',group_name:'Economy',example_model:'Citroen C Elysee',sipp:'EDMR'},ride24_context:{version:1,pickup_time:'10:00:00',return_time:'10:00:00',pickup_location:'Antalya Airport (AYT)',return_location:'Antalya Airport (AYT)'},provider_quote_data:{provider:'arvent_kolaycar',vehicle_id:'123',sipp:'EDMR',total_amount:84.75}},pickup_location_external_id:'12',dropoff_location_external_id:'12',...quote};
 const admin={
  from(table){let selectedColumns=null;const b={select(columns){selectedColumns=columns;return b;},eq(){return b;},
   insert(payload){savedExtrasQuote=payload;return b;},
   async single(){if(table==='api_quotes')return {data:{id:'44444444-4444-4444-8444-444444444444'},error:null};return {data:{id:'car',partner_id:ARVENT,active:true,allowed_location_ids:null,min_driver_age:null,driver_included:false,
     partners:{id:ARVENT,active:true,account_status:'active',currency:'EUR',provider_type:'api',api_provider:'arvent_kolaycar',min_rental_days:3,min_driver_age:21,max_driver_age:null}},error:null};},
   async maybeSingle(){
    if(table==='api_quotes'){
      // Simulate Supabase/PostgREST column projection: an omitted field
      // MUST be absent from the returned row, not silently supplied by the fixture.
      const columns=selectedColumns==='*'?Object.keys(q):String(selectedColumns||'').split(',').map(x=>x.trim());
      const data=Object.fromEntries(columns.filter(k=>Object.hasOwn(q,k)).map(k=>[k,q[k]]));
      return {data,error:null};
    }
    if(table==='partners')return {data:{api_settings:extraSettings},error:null};
    return {data:{age:40},error:null};
   }};return b;},
  async rpc(name){calls.push(name);return {data:loyalty,error:null};},
 };
 const require=n=>{
  if(n.includes('api-booking-options'))return {makeApiBookingOptions:async()=>{throw Error('Renteon path must not run for Arvent');},readArventExtrasCatalog:async()=>[{code:'1',name:'GPS'},{code:'2',name:'Ek Sürücü'},{code:'6',name:'Infant seat'}],readArventOfferExtras:async(_admin,_partnerId,selectedQuote)=>{
   if(offerError)throw Error(offerError);
   if(!selectedQuote.external_group_id || selectedQuote.external_group_id!==selectedQuote.raw_response?.provider_quote_data?.sipp)
     throw Error('PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED');
   return {status:'present',billed_days:3,items:offerItems||[{code:'2',name:'Ek Sürücü',price_eur:4.99,billing_type:'UNKNOWN',quantity_increasable:false,required:false,kind:'additional_driver',booking_confirmed:false}]};}};
  if(n.includes('arvent-extras-pricing.mjs'))return arventPricing;
  if(n.includes('driver-age'))return driverAge;
  if(n.includes('http/server'))return {serve:f=>handler=f};
  if(n.includes('ride24-security'))return {authenticatedUser:async()=>({id:'user-1'}),corsHeaders:()=>({}),enforceRateLimit:async()=>{},
   isUuid:v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v),jsonResponse:(_r,b,s=200)=>Response.json(b,{status:s}),
   publicErrorMessage:e=>({status:e?.status||500,message:e?.message||'x'}),serviceClient:()=>admin};
  if(n.includes('booking-request'))return {readJsonObject:r=>r.json()};
  if(n.includes('booking-exchange-rate'))return {exchangeRate:async(c,live)=>{calls.push('rate:'+c+':'+live);if(rateFails)throw Error('NBP');return rate;}};
  if(n.includes('booking-options.mjs'))return options;
  if(n.includes('api-quote-contract'))return {...contract,assertApiPricingCompatible:async()=>{}};
  if(n.includes('rental-duration'))return duration;
  throw Error('Unexpected import '+n);
 };
 vm.runInNewContext(js,{exports:{},require,Response,Request,console,Date,Math,Number,JSON,Array,String,Object,Error,crypto:globalThis.crypto});
 const call=body=>handler(new Request('https://x.invalid',{method:'POST',body:JSON.stringify({car_class_id:'11111111-1111-4111-8111-111111111111',
  api_quote_id:QUOTE,start_date:'2026-12-10',end_date:'2026-12-13',pickup_time:'10:00',return_time:'10:00',
  pickup_location:'Antalya Airport (AYT)',return_location:'Antalya Airport (AYT)',driver_id:null,additional_driver_id:null,extras:[],...body})}))
  .then(async r=>({status:r.status,body:await r.json()}));
 return {call,calls,getSavedQuote:()=>savedExtrasQuote};
}

test('Arvent without extras gets the server price summary: 88.14 = 84.75 rental + 3.39 Ride24 fee',async()=>{
 const s=setup();
 const r=await s.call({});
 assert.equal(r.status,200);
 const a=r.body.arvent;
 assert.equal(r.body.enabled,false);
 assert.equal(a.total,88.14);assert.equal(a.rental_total,84.75);assert.equal(a.ride24_fee,3.39);
 assert.equal(Math.round((a.rental_total+a.ride24_fee)*100),Math.round(a.total*100));
 assert.equal(a.pay_on_pickup,84.75);
 assert.equal(a.billed_days,3);
 assert.deepEqual(a.extras,[]);assert.deepEqual(a.mandatory_fees,[]);
 assert.deepEqual(a.extra_catalog,[{code:'1',name:'GPS'},{code:'2',name:'Ek Sürücü'},{code:'6',name:'Infant seat'}]);
 assert.equal(a.offer_extras.status,'present');
 assert.equal(a.offer_extras.items[0].kind,'additional_driver');
 assert.equal(a.offer_extras.items[0].price_eur,4.99);
 assert.equal(a.category.sipp,'EDMR');
 // Same single formula as the booking request: commission x NBP rate x (1 - loyalty%).
 assert.equal(a.online_pln,contract.apiOnlinePaymentPln(3.39,4.2345,0));
 assert.equal(a.online_pln,14.35);
 assert.ok(s.calls.includes('rate:EUR:true'),'Arvent requires a live NBP rate');
});
test('loyalty discount is applied exactly as in the booking request',async()=>{
 const r=await setup({loyalty:10}).call({});
 assert.equal(r.body.arvent.online_pln,contract.apiOnlinePaymentPln(3.39,4.2345,10));
 assert.equal(r.body.arvent.loyalty_discount_percent,10);
});
test('additional driver is refused with a clear Arvent message (never silently dropped)',async()=>{
 const r=await setup().call({additional_driver_id:'33333333-3333-4333-8333-333333333333'});
 assert.equal(r.status,400);assert.equal(r.body.code,'ARVENT_ADDITIONAL_DRIVER_IDENTITY_NOT_REQUIRED');
 assert.match(r.body.error,/płatny dodatek|Dodatkowy kierowca/);
});
test('selected extras are refused for Arvent',async()=>{
 const r=await setup().call({extras:[{id:'x',quantity:1}]});
 assert.equal(r.body.code,'ARVENT_EXTRAS_UNAVAILABLE');
});
test('expired, used or foreign quote blocks the summary and asks for a new search',async()=>{
 for(const quote of [{expires_at:new Date(Date.now()-1000).toISOString()},{booking_id:'b'},{used_at:new Date().toISOString()},{currency:'USD'},{car_class_id:'other'},{start_date:'2026-12-11'},{external_group_id:'XFAD'}]){
  const r=await setup({quote}).call({});
  assert.equal(r.status,409);assert.equal(r.body.code,'QUOTE_EXPIRED');
 }
});
test('Arvent offer change during extras lookup blocks checkout before payment',async()=>{
 for(const code of ['ARVENT_OFFER_CHANGED','ARVENT_EXTRAS_QUOTE_CHANGED','ARVENT_QUOTE_REQUIRED']){
  const r=await setup({offerError:'PARTNER_API_ERROR:'+code}).call({});
  assert.equal(r.status,409);
  assert.equal(r.body.code,'QUOTE_EXPIRED');
  assert.match(r.body.error,/Oferta lub jej cena zmieniła się/);
 }
});
test('Arvent blocks payment when mandatory supplier extras cannot be priced safely',async()=>{
 for(const reason of [
  'ARVENT_REQUIRED_EXTRAS_UNVERIFIED',
  'ARVENT_REQUIRED_EXTRAS_UNPRICED',
  'ARVENT_EXTRAS_SHAPE',
  'ARVENT_EXTRAS_DUPLICATE_OR_CODE'
 ]){
  const r=await setup({offerError:'PARTNER_API_ERROR:'+reason}).call({});
  assert.equal(r.status,409,reason);
  assert.equal(r.body.code,'ARVENT_EXTRAS_PRICE_UNVERIFIED',reason);
  assert.match(r.body.error,/pełnej ceny oferty/,reason);
 }
});
test('Arvent extras endpoint downtime never fabricates extras nor breaks vehicle-only price',async()=>{
 const r=await setup({offerError:'PARTNER_API_ERROR:HTTP:503'}).call({});
 assert.equal(r.status,200);
 assert.equal(r.body.arvent.offer_extras.status,'unavailable');
 assert.deepEqual(r.body.arvent.offer_extras.items,[]);
 assert.equal(r.body.arvent.pay_on_pickup,84.75);
 assert.equal(r.body.arvent.total,88.14);
});
test('Arvent certified code 2 adds EUR4 per day without collecting second driver identity',async()=>{
 const s=setup({extraSettings:{arvent_extras_pricing_certified:true,
   arvent_additional_driver_certified:true},
   offerItems:[{code:'2',name:'Ek Sürücü',price_eur:4,billing_type:'day',
     quantity_increasable:false,required:false,kind:'additional_driver'}]});
 const r=await s.call({extras:[{id:'2',quantity:1}]});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.enabled,true);
 assert.equal(r.body.arvent.pay_on_pickup,96.75);
 assert.equal(r.body.arvent.total,100.14);
 assert.equal(r.body.arvent.ride24_fee,3.39);
 assert.equal(r.body.arvent.online_pln,14.35);
 assert.equal(r.body.arvent.extras.length,1);
 assert.equal(r.body.api_quote_id,'44444444-4444-4444-8444-444444444444');
 assert.ok(r.body.fingerprint);
 const saved=s.getSavedQuote();
 assert.equal(saved.partner_net_total,96.75);
 assert.equal(saved.final_total,100.14);
 assert.equal(saved.raw_response.ride24_options.binding.additional_driver_id,null);
 assert.equal(saved.raw_response.ride24_options.arvent_extra.extras_cents,1200);
});
test('free mandatory supplier equipment preserves the existing vehicle-only price and checkout',async()=>{
 const s=setup({offerItems:[{code:'27',name:'Mandatory no-charge equipment',price_eur:0,
   billing_type:null,quantity_increasable:false,required:true,kind:'other'}]});
 const r=await s.call({});
 assert.equal(r.status,200);
 assert.equal(r.body.enabled,false);
 assert.equal(r.body.arvent.total,88.14);
 assert.equal(r.body.arvent.pay_on_pickup,84.75);
 assert.equal(s.getSavedQuote(),null);
});
test('Arvent uses verified supplier days for additional driver rate',async()=>{
 const r=await setup({extraSettings:{arvent_extras_pricing_certified:true,
   arvent_additional_driver_certified:true},
   offerItems:[{code:'2',name:'Extra driver',price_eur:4,billing_type:'day',
     required:false,quantity_increasable:false,kind:'additional_driver'}]})
 .call({extras:[{id:'2',quantity:1}]});
 assert.equal(r.status,200);
 assert.equal(r.body.arvent.billed_days,3);
 assert.equal(r.body.arvent.pay_on_pickup,96.75);
});
test('uncertified Arvent numeric supplier price cannot be selected or guessed',async()=>{
 const r=await setup({offerItems:[{code:'6',name:'Infant seat',price_eur:5,billing_type:'1',quantity_increasable:true,required:false,kind:'other'}]})
  .call({extras:[{id:'6',quantity:1}]});
 assert.equal(r.status,409);
 assert.equal(r.body.code,'ARVENT_EXTRAS_UNAVAILABLE');
});
test('missing NBP rate blocks the summary (no fallback rate for Arvent)',async()=>{
 const r=await setup({rateFails:true}).call({});
 assert.equal(r.status,503);assert.equal(r.body.code,'EXCHANGE_RATE_UNAVAILABLE');
});
test('booking request uses the same fee formula, saved licence date of the selected driver and refuses a second driver',async()=>{
 const src=await readFile(new URL('../../supabase/functions/create-booking-request/index.ts',import.meta.url),'utf8');
 assert.match(src,/let onlinePaymentPln = apiOnlinePaymentPln\(commission, rate, discountPercent\);/);
 assert.match(src,/\? \(savedMainDriverLicenseSince\s*\n\s*\|\| \(typeof body\.main_driver_license_since/);
 assert.match(src,/isArventBooking && additionalDriverId\)[\s\S]{0,150}ARVENT_ADDITIONAL_DRIVER_IDENTITY_NOT_REQUIRED/);
 const checkout=await readFile(new URL('../../supabase/functions/create_checkout_session/index.ts',import.meta.url),'utf8');
 // Stripe charges exactly the stored online_payment_pln of the created booking.
 assert.match(checkout,/const amount = Number\(booking\.online_payment_pln \|\| 0\);/);
 assert.match(checkout,/unit_amount: Math\.round\(amount \* 100\)/);
});


test('Arvent supplier global catalog never becomes selectable as an offer-priced extra',async()=>{
 const r=await setup().call({extras:[{id:'1',quantity:1}]});
 assert.equal(r.status,409);
 assert.equal(r.body.code,'ARVENT_EXTRAS_UNAVAILABLE');
});
