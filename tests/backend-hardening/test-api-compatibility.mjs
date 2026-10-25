import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as contract from '../../supabase/functions/_shared/api-quote-contract.mjs';
import * as readiness from '../../supabase/functions/_shared/api-readiness.mjs';
import * as options from '../../supabase/functions/_shared/booking-options.mjs';
import * as durationRules from '../../supabase/functions/_shared/rental-duration.ts';
import {normalizeLocations, assertSafeApiUrl} from '../../supabase/functions/_shared/partner-api.ts';

const uid='10000000-0000-4000-8000-000000000001', partner='20000000-0000-4000-8000-000000000001';
const car='30000000-0000-4000-8000-000000000001', booking='40000000-0000-4000-8000-000000000001';
const pickup='50000000-0000-4000-8000-000000000001', dropoff='50000000-0000-4000-8000-000000000002';
const quoteId='60000000-0000-4000-8000-000000000001';
const body=()=>({car_class_id:car,start_date:'2027-01-10',end_date:'2027-01-13',pickup_time:'10:00',return_time:'11:00',
  pickup_location:'Airport',return_location:'Office',terms_accepted:true,api_quote_id:quoteId});
const context=()=>contract.apiQuoteContext({pickupTime:'10:00',returnTime:'11:00',pickupName:'Airport',returnName:'Office'});

async function compile(name) {
  return ts.transpileModule(await readFile(new URL('../../supabase/functions/'+name+'/index.ts',import.meta.url),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
}
const codes=Object.fromEntries(await Promise.all(['create-booking-request','booking-options','search-api','api-partner-admin','api-booking-dispatch']
  .map(async name=>[name,await compile(name)])));
const adapterCode=ts.transpileModule(await readFile(new URL('../../supabase/functions/_shared/provider-adapters.ts',import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function adapters() {
  const requests=[];
  const transport={endpointFor:()=>'/reservations',sanitizePartnerPayload:x=>x,
    partnerApiRequest:async(_credentials,path,request)=>{requests.push({path,...request});return {id:'external-1',status:'pending'};}};
  const sandbox={exports:{},require:name=>name.includes('partner-api')?transport:name.includes('ride24-security')?{}:(()=>{throw Error(name)})(),
    URL,URLSearchParams,TextEncoder,TextDecoder,crypto,console};
  vm.runInNewContext(adapterCode,sandbox);
  return {requests,...sandbox.exports};
}

function setup() {
  const saved=[],outgoing=[],operations=[],failures=new Set();
  const partnerRow={id:partner,active:true,account_status:'active',currency:'EUR',email:'partner@example.invalid',
    provider_type:'api',api_enabled:true,api_provider:'ride24_standard_v1',discount_percent:0};
  const tables={profiles:[{id:uid,name:'Test Driver',phone:'123456789',age:35}],
    car_classes:[{id:car,external_id:'group-1',partner_id:partner,active:true,is_api_managed:true,public_price:33.33,
      partner_discount_percent:0,platform_margin_percent:25,features:{},partners:partnerRow}],
    partners:[partnerRow],
    partner_locations:[{id:pickup,partner_id:partner,external_id:'airport-1',active:true,is_api_managed:true,
      location_name:'Airport',country:'Portugal',region:'Mainland',city:'Lisbon',type:'airport',extra_fee:false,extra_fee_amount:0,return_fee_amount:0,partners:partnerRow},
      {id:dropoff,partner_id:partner,external_id:'office-1',active:true,is_api_managed:true,
      location_name:'Office',country:'Portugal',region:'Mainland',city:'Porto',type:'office',extra_fee:false,extra_fee_amount:0,return_fee_amount:0,partners:partnerRow}],
    api_quotes:[{id:quoteId,partner_id:partner,car_class_id:car,external_group_id:'group-1',
      pickup_location_external_id:'airport-1',dropoff_location_external_id:'office-1',
      start_date:'2027-01-10',end_date:'2027-01-13',public_price_per_day:33.33,
      partner_discount_percent:0,platform_margin_percent:25,partner_net_total:100,commission_total:25,final_total:125,
      currency:'EUR',expires_at:new Date(Date.now()+600000).toISOString(),used_at:null,booking_id:null,
      raw_response:{ride24_context:context()}}],
    partner_api_credentials:[{partner_id:partner,api_url:'https://provider.example.invalid',last_test_ok:true,
      last_sync_at:new Date().toISOString(),updated_at:new Date().toISOString()}],
    partner_extras:[],partner_time_fees:[],partner_time_blocks:[],partner_conditional_fees:[],drivers:[],
    booking_feature_flags:[{id:true,priced_extras_enabled:true}]};
  class Query {
    constructor(table){this.table=table;this.filters=[];this.one=false;this.max=Infinity;}
    select(){return this;}
    eq(k,v){this.filters.push(r=>k.includes('.')?true:r[k]===v);return this;}
    is(k,v){this.filters.push(r=>r[k]===v);return this;}
    gt(k,v){this.filters.push(r=>r[k]>v);return this;}
    in(k,v){this.filters.push(r=>v.includes(r[k]));return this;}
    order(){return this;}limit(n){this.max=n;return this;}
    single(){this.one=true;return this;}maybeSingle(){this.one=true;return this;}
    insert(value){this.inserted=value;return this;}update(value){this.updated=value;return this;}
    upsert(value){this.inserted=value;return this;}
    then(resolve,reject){try {
      if(failures.has(this.table))return Promise.resolve({data:null,error:{message:'simulated failure'}}).then(resolve,reject);
      let rows=(tables[this.table]||[]).filter(r=>this.filters.every(f=>f(r))).slice(0,this.max);
      if(this.updated){rows.forEach(r=>Object.assign(r,this.updated));operations.push({table:this.table,update:this.updated,count:rows.length});}
      if(this.inserted){
        const row={...this.inserted,id:this.table==='bookings'?booking:quoteId};
        if(this.table==='bookings'){saved.push(this.inserted);row.reservation_code='R24-API-TEST';row.status='pending';}
        (tables[this.table]??=[]).push(row);rows=[row];
      }
      return Promise.resolve({data:this.one?(rows[0]||null):rows,error:null}).then(resolve,reject);
    }catch(e){return Promise.reject(e).then(resolve,reject);}}
  }
  const admin={from:t=>new Query(t),rpc:async name=>{
    if(name==='calculate_loyalty_discount')return {data:10,error:null};
    if(name==='get_global_platform_margin')return {data:25,error:null};
    throw new Error('Unexpected price RPC: '+name);
  }};
  const security={authenticatedUser:async()=>({id:uid,email:'client@example.invalid'}),requireAdmin:async()=>({user:{id:uid},admin}),
    serviceClient:()=>admin,enforceRateLimit:async()=>{},requireSecret:()=>{},isUuid:x=>typeof x==='string'&&/^[0-9a-f-]{36}$/.test(x),
    corsHeaders:()=>({}),jsonResponse:(_req,value,status=200)=>Response.json(value,{status}),
    publicErrorMessage:()=>({message:'Server error',status:500})};
  const provider={loadPartnerCredentials:async()=>({api_url:'https://provider.example.invalid'}),sanitizePartnerPayload:x=>x,
    searchProvider:async()=>[{external_id:'group-1',class_code:'A',active:true,currency:'EUR',public_price:33.33,
      price_is_total:true,public_price_total:100,location_external_ids:['airport-1','office-1']}],
    createProviderBooking:async()=>{outgoing.push('provider-create');return {reference:'external-1',status:'pending'};},
    cancelProviderBooking:async()=>({})};
  function handler(name){
    let serve;
    const sandbox={exports:{},require:specifier=>{
      if(specifier.includes('api-readiness'))return readiness;
      if(specifier.includes('api-quote-contract'))return contract;
      if(specifier.includes('booking-options.mjs'))return options;
      if(specifier.includes('rental-duration.ts'))return durationRules;
      if(specifier.includes('ride24-security'))return security;
      if(specifier.includes('booking-request'))return {readJsonObject:req=>req.json()};
      if(specifier.includes('booking-exchange-rate'))return {exchangeRate:async()=>4.3};
      if(specifier.includes('provider-adapters')||specifier.includes('partner-api'))return provider;
      if(specifier.includes('server.ts'))return {serve:f=>serve=f};
      throw new Error('Unexpected module: '+specifier);
    },Request,Response,Headers,URL,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,crypto,
    console:{error(){},warn(){},log(){}},Deno:{env:{get:key=>key==='SUPABASE_URL'?'https://backend.example.invalid':'test-only'}},
    fetch:async url=>{
      if(String(url).startsWith('https://api.nbp.pl/'))return Response.json({rates:[{mid:4.3}]});
      assert.ok(String(url).startsWith('https://backend.example.invalid/'));outgoing.push(String(url));return Response.json({});
    }};
    vm.runInNewContext(codes[name],sandbox);
    return input=>serve(new Request('https://backend.example.invalid/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
  }
  return {tables,saved,outgoing,operations,failures,admin,handler};
}

test('provider period total is preserved for a three-day quote',()=>{
  const result=contract.apiPriceTotals({public_price:33.33,price_is_total:true,public_price_total:100},3,0,25);
  assert.equal(result.partnerNetTotal,100);assert.equal(result.finalTotal,125);assert.equal(result.commissionTotal,25);
});
test('API price retains the existing partner-discount then margin order',()=>{
  const result=contract.apiPriceTotals({public_price:33.33,price_is_total:true,public_price_total:100},3,10,20);
  assert.equal(result.partnerNetTotal,90);assert.equal(result.finalTotal,108);assert.equal(result.commissionTotal,18);
  assert.equal(contract.apiPriceTotals({public_price:34.2},7,0,25).partnerNetTotal,239.4);
});
test('missing, zero, negative and nonfinite period totals never fall back to a daily estimate',()=>{
  for(const public_price_total of [null,undefined,0,-1,NaN,Infinity,'invalid'])
    assert.throws(()=>contract.apiPriceTotals({public_price:33.33,price_is_total:true,public_price_total},3,0,25));
});
test('quote normalizes seconds and rejects changed pickup/return hours or places',()=>{
  assert.doesNotThrow(()=>contract.assertApiQuoteContext({ride24_context:context()},{...body(),pickup_time:'10:00:00',return_time:'11:00:00'}));
  for(const change of [{pickup_time:'23:00'},{return_time:'23:00'},{pickup_location:'Office'},{return_location:'Airport'},{pickup_time:null}])
    assert.throws(()=>contract.assertApiQuoteContext({ride24_context:context()},{...body(),...change}),e=>e.code==='API_QUOTE_CHANGED');
  assert.throws(()=>contract.assertApiQuoteContext({},body()),e=>e.code==='API_QUOTE_CHANGED');
});
test('free API configuration remains bookable; inactive migrated extras do not block',async()=>{
  const s=setup();s.tables.partner_extras.push({partner_id:partner,id:'old',active:false});
  await contract.assertApiPricingCompatible(s.admin,partner);
});
test('each mandatory fee, closed-time rule or optional catalog blocks unsupported API pricing',async()=>{
  for(const table of ['partner_extras','partner_time_fees','partner_time_blocks','partner_conditional_fees']){
    const s=setup();s.tables[table].push({id:'rule',partner_id:partner,active:true});
    await assert.rejects(()=>contract.assertApiPricingCompatible(s.admin,partner),e=>e.code==='API_PRICING_NOT_READY');
  }
  for(const change of [{extra_fee:true,extra_fee_amount:50},{return_fee_amount:50}]){
    const s=setup();Object.assign(s.tables.partner_locations[0],change);
    await assert.rejects(()=>contract.assertApiPricingCompatible(s.admin,partner),e=>e.code==='API_PRICING_NOT_READY');
  }
});
test('temporary catalog lookup failure never grants permission to skip charges',async()=>{
  const s=setup();s.failures.add('partner_time_blocks');
  await assert.rejects(()=>contract.assertApiPricingCompatible(s.admin,partner),e=>e.code==='API_PRICING_UNAVAILABLE'&&e.status===503);
});
test('API creation retains server loyalty, exact partner amount and one-time quote consumption',async()=>{
  const s=setup(),request=s.handler('create-booking-request');
  const r=await request(body());assert.equal(r.status,200,await r.text());
  assert.equal(s.saved.length,1);assert.equal(s.saved[0].partner_net_price_snapshot,100);
  assert.equal(s.saved[0].online_payment_pln,96.75);assert.equal(s.saved[0].loyalty_discount_percent,10);
  assert.equal(s.tables.api_quotes[0].booking_id,booking);assert.equal(s.outgoing.length,1);
  const again=await request(body());assert.equal(again.status,409);assert.equal(s.saved.length,1);
});
test('an API time or route change rejects before claiming a quote, booking or contacting a partner',async()=>{
  for(const change of [{pickup_time:'23:00'},{return_time:'22:00'},{return_location:'Airport'}]){
    const s=setup(),r=await s.handler('create-booking-request')({...body(),...change});
    assert.equal(r.status,409);assert.equal((await r.json()).code,'API_QUOTE_CHANGED');
    assert.equal(s.tables.api_quotes[0].used_at,null);assert.equal(s.saved.length+s.outgoing.length,0);
  }
});
test('expired API quote and a quote for different dates cannot create a booking',async()=>{
  for(const change of [{expires_at:'2020-01-01T00:00:00Z'},{end_date:'2027-01-14'}]){
    const s=setup();Object.assign(s.tables.api_quotes[0],change);
    const r=await s.handler('create-booking-request')(body());assert.equal(r.status,409);assert.equal(s.saved.length+s.outgoing.length,0);
  }
});
test('new mandatory fee and selected extras block API bookings before side effects',async()=>{
  const s=setup();s.tables.partner_time_fees.push({id:'night',partner_id:partner,active:true});
  const r=await s.handler('create-booking-request')(body());assert.equal(r.status,409);
  assert.equal((await r.json()).code,'API_PRICING_NOT_READY');assert.equal(s.saved.length+s.outgoing.length,0);
  for(const change of [{extras:[{id:'seat',quantity:1}]},{additional_driver_id:uid},{pricing_version:2}]){
    const t=setup();t.tables.drivers.push({id:uid,user_id:uid,name:'Additional Driver',age:35});
    const response=await t.handler('create-booking-request')({...body(),...change});
    assert.equal(response.status,409);assert.equal(t.saved.length+t.outgoing.length,0);
  }
});
test('booking-options exposes API pricing failures in Polish and English instead of silently disabling fees',async()=>{
  const s=setup(),request=s.handler('booking-options');
  const ok=await request(body());assert.equal(ok.status,200);assert.equal((await ok.json()).enabled,false);
  s.tables.partner_locations[0].return_fee_amount=50;
  const r=await request(body()),value=await r.json();assert.equal(r.status,409);assert.equal(value.code,'API_PRICING_NOT_READY');
  assert.ok(value.error&&value.error_en);
});
test('search persists quote hours/route and exact total rather than rounded daily multiplication',async()=>{
  const s=setup();s.tables.api_quotes=[];
  const r=await s.handler('search-api')({pickupLocationName:'Airport',pickupLocation:'Airport',
    dropoffLocationName:'Office',dropoffLocation:'Office',pickupDate:'2027-01-10',returnDate:'2027-01-13',pickupTime:'10:00',returnTime:'11:00'});
  assert.equal(r.status,200,await r.text());assert.equal(s.tables.api_quotes.length,1);
  const q=s.tables.api_quotes[0];assert.equal(q.partner_net_total,100);assert.equal(q.final_total,125);
  assert.equal(q.raw_response.ride24_context.return_time,'11:00:00');assert.equal(q.raw_response.ride24_context.return_location,'Office');
});
test('API activation fails when current local surcharges are unsupported',async()=>{
  const s=setup();s.tables.partner_time_blocks.push({id:'closed',partner_id:partner,active:true});
  const r=await s.handler('api-partner-admin')({action:'activate',partner_id:partner});
  assert.equal(r.status,409,await r.text());
  assert.equal(s.operations.filter(x=>x.table==='partners').length,0);
});
test('admin GET reports readiness without exposing credentials or modifying the partner',async()=>{
  const s=setup();s.tables.partner_api_credentials[0].api_key='secret-test-value';
  const r=await s.handler('api-partner-admin')({action:'get',partner_id:partner});
  assert.equal(r.status,200);const data=await r.json();
  assert.equal(data.readiness.connection_tested,true);
  assert.equal(data.readiness.full_ride24_ready,false);
  assert(!JSON.stringify(data).includes('secret-test-value'));
  assert.equal(s.operations.length+s.outgoing.length+s.saved.length,0);
});
test('admin can inspect missing fee support while activation remains blocked',async()=>{
  const s=setup();s.tables.partner_conditional_fees.push({id:'airport',partner_id:partner,active:true});
  const r=await s.handler('api-partner-admin')({action:'get',partner_id:partner});
  assert.equal(r.status,200);assert.equal((await r.json()).readiness.local_pricing_status,'unmapped_supplements');
  assert.equal((await s.handler('api-partner-admin')({action:'activate',partner_id:partner})).status,409);
  assert.equal(s.operations.length+s.outgoing.length+s.saved.length,0);
});
test('normalizing imported locations preserves a separate return fee',()=>{
  const locations=normalizeLocations([{external_id:'pdl',country:'Portugal',region:'Azores',location_name:'Airport',
    extra_fee:true,extra_fee_amount:7.5,return_fee_amount:25}]);
  assert.equal(locations[0].extra_fee_amount,7.5);assert.equal(locations[0].return_fee_amount,25);
});
async function booked(s) {
  const r=await s.handler('create-booking-request')(body());assert.equal(r.status,200,await r.text());
  Object.assign(s.tables.bookings[0],{created_at:new Date().toISOString(),api_booking_reference:null,
    car_classes:{external_id:'group-1',class_code:'A'},partners:s.tables.partners[0]});
}
test('dispatch sends exactly the quoted route and partner amount, and repeat dispatch is skipped',async()=>{
  const s=setup();await booked(s);const request=s.handler('api-booking-dispatch');
  const first=await request({booking_id:booking});assert.equal(first.status,200,await first.text());
  assert.equal(s.outgoing.filter(x=>x==='provider-create').length,1);
  assert.equal(s.tables.bookings[0].api_booking_reference,'external-1');
  const again=await request({booking_id:booking});assert.equal(again.status,200);
  assert.equal((await again.json()).reason,'ALREADY_DISPATCHED');
  assert.equal(s.outgoing.filter(x=>x==='provider-create').length,1);
});
test('dispatch detects a changed route or new fees before sending anything to the provider',async()=>{
  for(const change of ['time','fees']){
    const s=setup();await booked(s);
    if(change==='time')s.tables.bookings[0].pickup_time='23:00';
    else s.tables.partner_time_fees.push({id:'night',partner_id:partner,active:true});
    const r=await s.handler('api-booking-dispatch')({booking_id:booking});assert.equal(r.status,409,await r.text());
    assert.equal(s.outgoing.filter(x=>x==='provider-create').length,0);
    assert.equal(s.tables.bookings[0].manual_review,true);
  }
});
test('custom/standard API sends only partner-payable accounting, never Ride24 totals or margin',async()=>{
  for(const name of ['ride24_standard_v1','custom']){
    const s=adapters();
    await s.createProviderBooking(name,{api_url:'https://provider.example.invalid'},
      {idempotency_key:'ride24:test',ride24_booking_id:booking,partner_amount:100,currency:'EUR',
       customer_total:125,platform_margin:25,online_payment_pln:96.75,loyalty_discount_percent:10});
    assert.equal(s.requests.length,1);const payload=s.requests[0].body;
    assert.equal(payload.partner_amount,100);assert.equal(payload.currency,'EUR');
    for(const key of ['customer_total','platform_margin','online_payment_pln','loyalty_discount_percent'])assert.equal(key in payload,false);
    assert.equal(s.requests[0].headers['Idempotency-Key'],'ride24:test');
  }
});
test('an unimplemented provider is rejected instead of routed to a generic API',async()=>{
  const s=adapters();
  for(const provider of ['wheelsys','kolaycar','unknown']){
    await assert.rejects(()=>s.createProviderBooking(provider,{api_url:'https://provider.example.invalid'},{}),/UNSUPPORTED_PROVIDER/);
  }
  assert.equal(s.requests.length,0);
});
test('partner API URL rejects private, metadata, credential and non-HTTPS destinations',()=>{
  for(const url of ['http://provider.example.com','https://localhost','https://127.0.0.1','https://10.0.0.1',
    'https://169.254.169.254','https://[::1]','https://[::ffff:127.0.0.1]','https://user:password@provider.example.com'])
    assert.throws(()=>assertSafeApiUrl(url));
  assert.equal(assertSafeApiUrl('https://provider.example.com/api/'),'https://provider.example.com/api');
});
