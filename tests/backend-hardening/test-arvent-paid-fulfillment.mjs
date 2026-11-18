import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as services from '../../supabase/functions/_shared/provider-services.mjs';
import * as flow from '../../supabase/functions/_shared/api-payment-flow.mjs';

const source=await readFile(new URL('../../supabase/functions/_shared/api-provider-fulfillment.ts',import.meta.url),'utf8');
const result=ts.transpileModule(source,{compilerOptions:{
 target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal(result.diagnostics?.length||0,0,'Paid adapter TypeScript must parse');

function fixture(change=()=>{},flags={}){
 const booking={id:'bk-1',partner_id:'arvent',car_class_id:'cls',api_quote_id:'q-1',
  status:'pending',partner_currency:'EUR',partner_net_price_snapshot:100,online_payment_pln:35,
  partner_terms_snapshot:'terms',partner_rules_snapshot:'rules',
  partners:{api_provider:'arvent_kolaycar',rental_terms_url:'terms',rental_rules_url:'rules'},
  start_date:'2027-02-16',end_date:'2027-02-18',pickup_time:'10:00:00',return_time:'10:00:00',
  main_driver_name:'Example Customer',main_driver_age:30,add_driver_name:null,
  client_email:'example@example.invalid',client_phone:'+48000000000'};
 const provider_quote_data={provider:'arvent_kolaycar',vehicle_id:'10',sipp:'CDAR',
  total_amount:100,pickup_location_id:'12',dropoff_location_id:'12'};
 const quote={id:'q-1',booking_id:'bk-1',partner_id:'arvent',car_class_id:'cls',
  external_group_id:'CDAR',currency:'EUR',partner_net_total:100,partner_discount_percent:0,
  pickup_location_external_id:'12',dropoff_location_external_id:'12',
  raw_response:{provider_quote_data}};
 const fresh={external_id:'CDAR',currency:'EUR',deposit_amount:0,public_price_total:100,
  features:{minimum_driver_age:21},
  provider_quote_data:{provider:'arvent_kolaycar',vehicle_id:'15',sipp:'CDAR',
   total_amount:100,currency:'EUR'}};
 const state={booking,quote,fresh,live:[fresh],status:{status:'pending',
  booking_reference:'A-1',needs_manual_review:false},throws:false};
 change(state);
 const calls=[];
 const arvent={
  arventSearch:async(_c,input)=>{calls.push({stage:'search',input});if(state.throws)throw Error('SUPPLIER_TEMPORARY_ERROR');return state.live;},
  arventCreateBooking:async(_c,input)=>{calls.push({stage:'create',input});
   return {status:'pending',booking_reference:'A-1',needs_manual_review:false};},
  arventBookingStatus:async(_c,ref)=>{calls.push({stage:'status',ref});return state.status}
 };
 const renteon={
  aggregatorAvailability:async()=>{throw Error('Wrong provider routing')},
  aggregatorQuoteOptions:async()=>{throw Error('Wrong provider routing')},
  aggregatorBook:async()=>{throw Error('Wrong provider routing')},
  aggregatorStatus:async()=>{throw Error('Wrong provider routing')}
 };
 const require=n=>n.includes('provider-services')?services:n.includes('api-payment-flow')?flow
  :n.includes('arvent-kolaycar')?arvent:n.includes('renteon-aggregator')?renteon
  :(()=>{throw Error('Unexpected import: '+n)})();
 const sandbox={exports:{},require,console,
  Deno:{env:{get:key=>flags[key]===true?'true':undefined}}};
 vm.runInNewContext(result.outputText,sandbox);
 return {...sandbox.exports,...state,calls};
}
const approved={ARVENT_KOLAYCAR_WRITE_ALLOWED:true,ARVENT_STRIPE_FIRST_APPROVED:true};

test('two explicit production gates are required before Arvent accepts paid fulfillment',async()=>{
 for(const flags of [{},{ARVENT_KOLAYCAR_WRITE_ALLOWED:true},
  {ARVENT_STRIPE_FIRST_APPROVED:true}]){
  const f=fixture(()=>{},flags);
  assert.equal(f.hasPaidFulfillmentAdapter('arvent_kolaycar'),false);
  assert.equal(f.hasPaidFulfillmentAdapter('renteon_aggregator'),true);
  await assert.rejects(f.revalidatePaidProvider({},f.booking,f.quote),
   e=>e instanceof flow.DefiniteApiFailure&&e.message==='ADAPTER_NOT_READY');
  await assert.rejects(f.createPaidProvider({},{provider:'arvent_kolaycar'}),
   e=>e instanceof flow.DefiniteApiFailure&&e.message==='ADAPTER_NOT_READY');
  assert.equal(f.calls.length,0);
 }
});
test('same SIPP group with another cheaper vehicle is safe only at identical EUR price',async()=>{
 const f=fixture(()=>{},approved);
 assert.equal(f.hasPaidFulfillmentAdapter('arvent_kolaycar'),true);
 const prepared=await f.revalidatePaidProvider({},f.booking,f.quote);
 assert.equal(prepared.provider,'arvent_kolaycar');
 assert.equal(prepared.vehicle_group_id,'CDAR');
 assert.equal(prepared.provider_quote_data.vehicle_id,'15');
 assert.equal(prepared.partner_amount,100);
 assert.equal(prepared.pickup_location_id,'12');
 assert.equal(prepared.pickup_time,'10:00');
 assert.deepEqual(f.calls.map(x=>x.stage),['search']);
 const result=await f.createPaidProvider({},prepared);
 assert.equal(result.status,'pending');
 assert.equal(result.needs_manual_review,false);
 assert.equal(f.calls.at(-1).stage,'create');
});
test('new supplier price, category, deposit, driver or documents reject before creating booking',async()=>{
 const cases={
  price:s=>s.fresh.public_price_total=101,
  group:s=>s.fresh.external_id='MDAR',
  deposit:s=>s.fresh.deposit_amount=250,
  currency:s=>s.fresh.currency='TRY',
  age:s=>s.booking.main_driver_age=19,
  docs:s=>s.booking.partners.rental_rules_url='different',
  owner:s=>s.quote.booking_id='other',
  changed_category:s=>s.quote.external_group_id='MDAR',
  optional_extras:s=>s.quote.raw_response.ride24_options={binding:{selections:[{id:'babyseat'}]}},
  extra_driver:s=>s.booking.add_driver_name='Extra Driver',
  paid_amount_changed:s=>s.booking.partner_net_price_snapshot=120
 };
 for(const [name,change] of Object.entries(cases)){
  const f=fixture(change,approved);
  await assert.rejects(f.revalidatePaidProvider({},f.booking,f.quote),
   e=>e instanceof flow.DefiniteApiFailure,name);
  assert.equal(f.calls.some(x=>x.stage==='create'),false,name);
 }
});
test('temporary supplier network errors are retryable and not classified as definitive',async()=>{
 const f=fixture(s=>s.throws=true,approved);
 await assert.rejects(f.revalidatePaidProvider({},f.booking,f.quote),
  e=>!(e instanceof flow.DefiniteApiFailure)&&e.message==='SUPPLIER_TEMPORARY_ERROR');
});
test('Received stays pending, Approved confirms and Cancelled is definitive rejection',async()=>{
 const f=fixture(()=>{},approved);
 const prepared=await f.revalidatePaidProvider({},f.booking,f.quote);
 const pending=await f.readPaidProviderStatus({},'A-1',prepared);
 assert.equal(pending.status,'pending');assert.equal(pending.needs_manual_review,false);
 f.status.status='confirmed';
 const approvedResult=await f.readPaidProviderStatus({},'A-1',prepared);
 assert.equal(approvedResult.status,'confirmed');
 f.status.status='cancelled';
 const cancelled=await f.readPaidProviderStatus({},'A-1',prepared);
 assert.equal(cancelled.status,'rejected');
 assert.equal(cancelled.definitive_rejection,true);
});
test('unknown supplier adapters never silently route to aggregator booking',async()=>{
 const f=fixture(()=>{},approved);
 await assert.rejects(f.createPaidProvider({},{provider:'not-real'}),flow.DefiniteApiFailure);
});
