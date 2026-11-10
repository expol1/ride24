import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = readFileSync(new URL('../../supabase/functions/stripe-webhook/index.ts', import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
async function run({status='awaiting_payment',cancelled_at=null,race=false,reviewError=false,lookupError=false,duplicate=false,voucher=true,noSignature=false,badSignature=false}={}) {
 const row={id:'b1',status,cancelled_at}; const writes=[];const calls=[];let handler;let updates=0;const reviews=[];
 const db={from(table){let op='select',payload,filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},neq(k,v){filters.push([k,v,'neq']);return q},is(k,v){filters.push([k,v]);return q},limit(){return q},update(v){op='update';payload=v;return q},insert(v){op='insert';payload=v;return q},maybeSingle(){return execute()},then(a,b){return execute().then(a,b)}};
 async function execute(){
 if(table==='bookings'&&op==='select')return {data:{...row},error:lookupError?{}:null};
 if(table==='vouchers'&&op==='select')return {data:voucher?{pdf_path:'existing.pdf'}:null,error:null};
 if(table==='booking_review_queue'&&op==='select')return {data:reviews[0]||null,error:null};
 if(table==='booking_review_queue'&&op==='insert'&&reviewError)return {error:{message:'unavailable'}};
 if(table==='bookings'&&op==='update'){
  if(payload.status==='paid'&&race&&updates++===0){row.status='cancelled';row.cancelled_at='2026-11-10';}
  const match=filters.every(([k,v,kind])=>kind==='neq'?row[k]!==v:row[k]===v);
  if(!match)return {data:[],error:null};Object.assign(row,payload);
 }
 writes.push({table,op,payload});if(table==='booking_review_queue')reviews.push({id:'r1'});
 return {data:table==='bookings'?[{id:'b1'}]:null,error:null};
 }return q;}};
 const session={id:'cs_test',metadata:{booking_id:'b1'},amount_total:10000,currency:'pln',payment_status:'paid'};
 const ctx={Response,console:{log(){},warn(){},error(){}},Stripe:class{webhooks={constructEventAsync:async()=>{if(badSignature)throw Error('invalid');return {id:'evt_test',type:'checkout.session.completed',data:{object:session}}}}},createClient:()=>db,Deno:{env:{get:()=> 'test'},serve:h=>handler=h},fetch:async(url)=>{calls.push(url);return new Response('OK')}};
 vm.runInNewContext(source,ctx);
 const req=()=>new Request('https://example.test',{method:'POST',headers:noSignature?{}:{'stripe-signature':'test'},body:'{}'});
 const response=await handler(req());if(duplicate)await handler(req());return {row,writes,calls,response};
}
for(const opts of [{status:'cancelled'},{status:'paid',cancelled_at:'2026-11-10'},{race:true}])test('cancel guard '+JSON.stringify(opts),async()=>{
 const r=await run(opts);assert.equal(r.response.status,200);assert.equal(r.writes.filter(x=>['payments','vouchers','email_logs'].includes(x.table)).length,0);assert.equal(r.calls.length,0);assert.equal(r.row.manual_review,true);assert.equal(r.writes.filter(x=>x.table==='booking_review_queue').length,1);if(opts.race||opts.status==='cancelled')assert.equal(r.row.status,'cancelled');
});
test('normal payment retains voucher, payment and email flow',async()=>{const r=await run();assert.equal(r.row.status,'paid');assert.equal(r.response.status,200);for(const t of ['payments','vouchers','email_logs'])assert.ok(r.writes.some(x=>x.table===t));assert.equal(r.calls.length,2)});
test('duplicate paid event does not insert a second payment',async()=>{const r=await run({duplicate:true});assert.equal(r.writes.filter(x=>x.table==='payments').length,1)});
test('paid voucher recovery remains available',async()=>{const r=await run({status:'paid',voucher:false});assert.equal(r.calls.length,1);assert.equal(r.writes.length,0)});
test('cancelled duplicate retains one review',async()=>{const r=await run({status:'cancelled',duplicate:true});assert.equal(r.writes.filter(x=>x.table==='booking_review_queue').length,1)});
test('review persistence failure requests Stripe retry',async()=>{const r=await run({status:'cancelled',reviewError:true});assert.equal(r.response.status,500);assert.equal(r.calls.length,0);assert.equal(r.row.status,'cancelled')});
test('lookup failure fails closed',async()=>{const r=await run({lookupError:true});assert.equal(r.response.status,500);assert.equal(r.writes.length,0)});

for(const opts of [{noSignature:true},{badSignature:true}])test('signature guard '+JSON.stringify(opts),async()=>{const r=await run(opts);assert.equal(r.response.status,400);assert.equal(r.writes.length,0);assert.equal(r.calls.length,0)});
