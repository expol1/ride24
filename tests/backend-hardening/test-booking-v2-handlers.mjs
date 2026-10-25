import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as options from '../../supabase/functions/_shared/booking-options.mjs';
import * as apiContract from '../../supabase/functions/_shared/api-quote-contract.mjs';
import * as rentalDurationHelper from '../../supabase/functions/_shared/rental-duration.ts';
import ts from 'typescript';
const uid='10000000-0000-4000-8000-000000000001',partner='20000000-0000-4000-8000-000000000001',car='30000000-0000-4000-8000-000000000001',booking='40000000-0000-4000-8000-000000000001';
const pickup='50000000-0000-4000-8000-000000000001',dropoff='50000000-0000-4000-8000-000000000002',extra='60000000-0000-4000-8000-000000000001';
const makeBody=()=>({car_class_id:car,start_date:'2027-01-10',end_date:'2027-01-15',pickup_time:'10:00',return_time:'10:00',pickup_location:'Airport',return_location:'Office',terms_accepted:true,extras:[{id:extra,quantity:2}]});
const code=ts.transpileModule(await readFile(new URL('../../supabase/functions/create-booking-request/index.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function setup({enabled=true,fees=true}={}){
 const saved=[],outgoing=[];
 const tables={profiles:[{id:uid,name:'Test Driver',phone:'123456789',age:35}],car_classes:[{id:car,partner_id:partner,active:true,public_price:50,partner_discount_percent:0,platform_margin_percent:25,features:{},partners:{id:partner,active:true,account_status:'active',currency:'EUR',email:'partner@example.invalid',provider_type:'local',api_enabled:false}}],booking_feature_flags:[{id:true,priced_extras_enabled:enabled}],partner_locations:[{id:pickup,partner_id:partner,active:true,is_api_managed:false,location_name:'Airport',extra_fee:fees,extra_fee_amount:10,return_fee_amount:fees?10:0},{id:dropoff,partner_id:partner,active:true,is_api_managed:false,location_name:'Office',extra_fee:fees,extra_fee_amount:20,return_fee_amount:fees?20:0}],partner_extras:[{id:extra,partner_id:partner,code:'child_seat',name_en:'Child seat',name_pl:'Fotelik',amount:3,billing:'day',max_quantity:2,active:true}],drivers:[]};
 const rental={base_total:200,final_total:250,commission:50,public_price_per_day:50,partner_discount_percent:0,platform_margin_percent:25};
 class Query{
  constructor(table){this.table=table;this.filters=[];this.one=false;}
  select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}in(k,v){this.filters.push(r=>v.includes(r[k]));return this;}order(){return this;}
  single(){this.one=true;return this;}maybeSingle(){this.one=true;return this;}insert(v){this.inserted=v;return this;}upsert(){return this;}
  then(resolve,reject){try{let data;if(this.inserted){assert.equal(this.table,'bookings');saved.push(this.inserted);data={id:booking,reservation_code:'R24-TEST',status:'pending'};}else{const rows=(tables[this.table]||[]).filter(r=>this.filters.every(f=>f(r)));data=this.one?(rows[0]||null):rows;}return Promise.resolve({data,error:null}).then(resolve,reject);}catch(e){return Promise.reject(e).then(resolve,reject);}}
 }
 const admin={from:t=>new Query(t),rpc:async(name)=>({data:name==='calculate_booking_price'?[{...rental}]:10,error:null})};
 const security={authenticatedUser:async()=>({id:uid,email:'client@example.invalid'}),serviceClient:()=>admin,enforceRateLimit:async()=>{},isUuid:x=>typeof x==='string'&&/^[0-9a-f-]{36}$/.test(x),corsHeaders:()=>({}),jsonResponse:(_req,value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}}),publicErrorMessage:()=>({message:'Server error',status:500})};
 let handler;
 const sandbox={exports:{},require:name=>name.includes('api-quote-contract')?apiContract:name.includes('booking-options')?options:name.includes('ride24-security')?security:name.includes('rental-duration')?rentalDurationHelper:name.includes('server.ts')?{serve:f=>handler=f}:(()=>{throw new Error(name)})(),Request,Response,Headers,TextEncoder,TextDecoder,URL,AbortController,setTimeout,clearTimeout,console,Deno:{env:{get:key=>key==='SUPABASE_URL'?'https://example.invalid':'test-only'}},fetch:async url=>{if(String(url).startsWith('https://api.nbp.pl/'))return Response.json({rates:[{mid:4.3}]});assert.ok(String(url).startsWith('https://example.invalid/'));outgoing.push(String(url));return Response.json({});}};
 vm.runInNewContext(code,sandbox);
 const request=body=>handler(new Request('https://example.invalid/create-booking-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 async function quoted(body=makeBody()){
  const opts=await options.loadBookingOptions(admin,partner,body.pickup_location,body.return_location);
  const context=options.pricingContext({userId:uid,carId:car,startDate:body.start_date,endDate:body.end_date,pickupTime:body.pickup_time,returnTime:body.return_time,additionalDriverId:body.additional_driver_id},opts);
  const q=await options.makeBookingQuote({options:opts,selections:body.extras,hasAdditionalDriver:!!body.additional_driver_id,context,rental,days:5,marginPercent:25,loyaltyPercent:10,currency:'EUR',exchangeRate:4.3});
  return {...body,pricing_version:2,pricing_fingerprint:q.publicQuote.fingerprint};
 }
 return {tables,saved,outgoing,request,quoted};
}
test('accepted quote stores exact amounts and preserves mocked email/push dispatch',async()=>{const s=setup();const r=await s.request(await s.quoted());assert.equal(r.status,200,await r.text());assert.equal(s.saved.length,1);const b=s.saved[0];assert.equal(b.pricing_items_snapshot.total_cents,31850);assert.equal(b.pickup_payment_partner_currency,260);assert.equal(b.online_payment_pln,251.55);assert.equal(b.final_price_snapshot,325);assert.equal(s.outgoing.length,2);});
test('stale location price rejects before booking, email or push',async()=>{const s=setup();const b=await s.quoted();s.tables.partner_locations[0].extra_fee_amount=11;const r=await s.request(b);assert.equal(r.status,409);assert.equal((await r.json()).code,'QUOTE_CHANGED');assert.equal(s.saved.length+s.outgoing.length,0);});
test('legacy paid location requires upgrade instead of unseen charge',async()=>{const s=setup();const b=makeBody();delete b.extras;const r=await s.request(b);assert.equal(r.status,409);assert.equal((await r.json()).code,'PRICING_UPDATE_REQUIRED');assert.equal(s.saved.length,0);});
test('legacy free booking retains original price and no snapshot',async()=>{const s=setup({enabled:false,fees:false});const b=makeBody();delete b.extras;const r=await s.request(b);assert.equal(r.status,200,await r.text());assert.equal(s.saved[0].online_payment_pln,193.5);assert.equal('pricing_items_snapshot' in s.saved[0],false);});
test('emergency disable never silently discards selected extras',async()=>{const s=setup();const b=await s.quoted();s.tables.booking_feature_flags[0].priced_extras_enabled=false;const r=await s.request(b);assert.equal(r.status,409);assert.equal(s.saved.length,0);});
test('v16 owner protection remains active with extras disabled',async()=>{const s=setup({enabled:false});const b=makeBody();delete b.extras;b.return_location='Other partner office';const r=await s.request(b);assert.equal(r.status,409);assert.equal(s.saved.length+s.outgoing.length,0);});
test('changed catalog invalidates acceptance before writing a booking',async()=>{const s=setup();const b=await s.quoted();s.tables.partner_extras[0].amount=4;const r=await s.request(b);assert.equal(r.status,409);assert.equal(s.saved.length,0);});
test('legacy free booking remains compatible after charging is enabled',async()=>{const s=setup({enabled:true,fees:false});const b=makeBody();delete b.extras;const r=await s.request(b);assert.equal(r.status,200,await r.text());assert.equal(s.saved[0].online_payment_pln,193.5);assert.equal('pricing_items_snapshot' in s.saved[0],false);});
