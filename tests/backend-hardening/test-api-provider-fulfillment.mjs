import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as services from '../../supabase/functions/_shared/provider-services.mjs';
import * as flow from '../../supabase/functions/_shared/api-payment-flow.mjs';
const code=ts.transpileModule(await readFile(new URL('../../supabase/functions/_shared/api-provider-fulfillment.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(change=()=>{}) {
 const offer={Provider:'Avia',Currency:'EUR',Prepaid:false,CarCategory:'MBMV',PickupDate:'2027-03-01T23:00:00',DropOffDate:'2027-03-04T23:00:00',PickupOffice:{LocationCode:'HR-ZAD-ZAD'},DropOffOffice:{LocationCode:'HR-ZAD-ZAD'},ExcessAmount:0,DepositAmount:0,IncludedServices:[],PriceDate:'old'};
 const calculated={...structuredClone(offer),Total:100,Services:[{ServiceId:1,Code:'CAR-RENT',IsSelected:true,Quantity:1,Prepaid:false,ServicePrice:{Currency:'EUR',Amount:25,AmountTotal:25}},{ServiceId:489,Code:'EQ-BABYSEAT',IsSelected:true,Quantity:2,Prepaid:false,ServicePrice:{Currency:'EUR',Amount:37.5,AmountTotal:75}}]};
 const provider_quote_data={offer,calculated};
 const booking={id:'b',partner_id:'p',car_class_id:'c',status:'pending',partner_currency:'EUR',partner_net_price_snapshot:100,online_payment_pln:43,partner_terms_snapshot:'terms',partner_rules_snapshot:'rules',partners:{api_provider:'renteon_aggregator',rental_terms_url:'terms',rental_rules_url:'rules'},start_date:'2027-03-01',end_date:'2027-03-04',pickup_time:'23:00',return_time:'23:00',main_driver_age:35};
 const quote={booking_id:'b',partner_id:'p',car_class_id:'c',external_group_id:'MBMV',pickup_location_external_id:'HR-ZAD-ZAD',dropoff_location_external_id:'HR-ZAD-ZAD',raw_response:{provider_quote_data,ride24_options:{binding:{selections:[{id:'489',quantity:2}],ages:[35]},snapshot:{partner_cents:10000,online_pln_cents:4300,currency:'EUR'}}}};
 const fresh={external_id:'MBMV',provider_quote_data:structuredClone(provider_quote_data)};fresh.provider_quote_data.offer.PriceDate='new';
 const result={calculated:structuredClone(calculated),provider_quote_data:structuredClone(provider_quote_data)};
 const state={booking,quote,fresh,result,available:true,status:'confirmed',statusRow:structuredClone(calculated)};change(state);
 const calls=[];const sandbox={exports:{},require:n=>n.includes('provider-services')?services:n.includes('api-payment-flow')?flow:{
 aggregatorAvailability:async(_c,input)=>{calls.push({stage:'availability',input});return state.available?[fresh]:[]},
 aggregatorQuoteOptions:async(_c,_q,selections,ages)=>{calls.push({stage:'calculate',selections,ages});return result},
 aggregatorBook:async()=>{throw Error('Revalidation must never save a booking')},
 aggregatorStatus:async()=>({status:state.status,reference:'test',provider_payload:state.statusRow})}};
 vm.runInNewContext(code,sandbox);return {...sandbox.exports,...state,calls};
}
test('post-payment revalidation carries exact route, times, extras and customer-approved partner amount',async()=>{
 const f=fixture();const p=await f.revalidatePaidProvider({},f.booking,f.quote);
 assert.equal(p.partner_amount,100);assert.equal(p.pickup_location_id,'HR-ZAD-ZAD');assert.equal(p.pickup_time,'23:00');
 assert.deepEqual(f.calls.map(x=>x.stage),['availability','calculate']);assert.equal(f.calls[1].selections[0].quantity,2);
});
for(const [name,change] of Object.entries({unavailable:s=>s.available=false,price:s=>s.result.calculated.Total=101,extras:s=>s.result.calculated.Services[1].Quantity=1,deposit:s=>s.fresh.provider_quote_data.offer.DepositAmount=1,insurance:s=>s.fresh.provider_quote_data.offer.ExcessAmount=100,documents:s=>s.booking.partners.rental_rules_url='changed',owner:s=>s.quote.booking_id='other'}))
 test('post-payment '+name+' change refuses creation',async()=>{const f=fixture(change);await assert.rejects(f.revalidatePaidProvider({},f.booking,f.quote),flow.DefiniteApiFailure)});
for(const [name,change] of Object.entries({route:s=>s.statusRow.PickupOffice.LocationCode='HR-SPU-SPU',currency:s=>s.statusRow.Currency='USD',time:s=>s.statusRow.PickupDate='2027-03-01T22:00:00',amount:s=>s.statusRow.Total=101,extras:s=>s.statusRow.Services=[]}))
 test('supplier confirmed status with changed '+name+' requires review',async()=>{const f=fixture(change);const p={partner_amount:100,provider_quote_data:f.quote.raw_response.provider_quote_data};assert.equal((await f.readPaidProviderStatus({},'test',p)).needs_manual_review,true)});
test('unimplemented adapters cannot accept paid fulfillment',()=>{const f=fixture();for(const p of ['caravel','kolaycar','custom','unknown'])assert.equal(f.hasPaidFulfillmentAdapter(p),false)});
