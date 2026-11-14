import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyApiPayment} from '../../supabase/functions/_shared/api-payment-flow.mjs';
const source=readFileSync(new URL('../../supabase/functions/stripe-webhook/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
async function run({eventType='checkout.session.completed',changes={},badSignature=false,recordError=false}={}) {
 const booking={id:'b1',client_id:'u1',provider_type:'api',online_payment_pln:12.34,stripe_session_id:'cs_test'};
 const session={id:'cs_test',mode:'payment',status:'complete',payment_status:'paid',livemode:false,currency:'pln',amount_total:1234,
 metadata:{booking_id:'b1',client_id:'u1'},client_reference_id:'b1',payment_intent:'pi_test',...changes};
 const calls=[];let handler;
 const db={from(){return {select(){return this},eq(){return this},maybeSingle:async()=>({data:booking})}},rpc:async(name,args)=>{calls.push({name,args});return {error:recordError?{}:null}}};
 const ctx={Response,console:{log(){},warn(){},error(){}},verifyApiPayment,
 runApiPayment:async()=>{calls.push({name:'fulfill'})},
 Stripe:class{webhooks={constructEventAsync:async()=>{if(badSignature)throw Error('bad');return {id:'evt_test',type:eventType,data:{object:{id:'cs_test',metadata:{booking_id:'b1'}}}}}};checkout={sessions:{retrieve:async()=>{calls.push({name:'retrieve'});return session}}}},
 createClient:()=>db,Deno:{env:{get:()=> 'sk_test_fixture'},serve:h=>handler=h},fetch:async()=>{throw Error('API webhook must not use legacy voucher/email path')}};
 vm.runInNewContext(source,ctx);
 const response=await handler(new Request('https://example.invalid',{method:'POST',headers:{'stripe-signature':'fixture'},body:'{}'}));
 return {response,calls};
}
test('real API webhook retrieves payment, durably records it, then fulfills; never directly vouchers',async()=>{
 const r=await run();assert.equal(r.response.status,200);assert.deepEqual(r.calls.map(x=>x.name),['retrieve','api_record_verified_payment','fulfill']);
 assert.equal(r.calls[1].args.p_amount,1234);
});
for(const changes of [{amount_total:1235},{currency:'eur'},{livemode:true},{payment_intent:null},{metadata:{booking_id:'other',client_id:'u1'}}])
 test('API webhook rejects payment mismatch '+JSON.stringify(changes),async()=>{const r=await run({changes});assert.equal(r.response.status,500);assert.equal(r.calls.some(x=>x.name==='fulfill'),false)});
for(const eventType of ['checkout.session.completed','checkout.session.async_payment_failed','checkout.session.expired'])
 test('unpaid '+eventType+' cannot dispatch',async()=>{const r=await run({eventType,changes:{payment_status:'unpaid',status:eventType.endsWith('expired')?'expired':'open'}});assert.equal(r.response.status,200);assert.deepEqual(r.calls.map(x=>x.name),['retrieve','api_record_unpaid_session'])});
test('invalid signature never reads or writes a booking',async()=>{const r=await run({badSignature:true});assert.equal(r.response.status,400);assert.equal(r.calls.length,0)});
test('failed durable write never dispatches and requests webhook retry',async()=>{const r=await run({recordError:true});assert.equal(r.response.status,500);assert.equal(r.calls.some(x=>x.name==='fulfill'),false)});
test('async successful payment uses the same gated fulfillment path',async()=>{const r=await run({eventType:'checkout.session.async_payment_succeeded'});assert.equal(r.response.status,200);assert.equal(r.calls.at(-1).name,'fulfill')});
