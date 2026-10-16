import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import ts from 'typescript';
import {makeBookingQuote} from '../../supabase/functions/_shared/booking-options.mjs';
import {partnerBookingProjection} from '../../supabase/functions/_shared/partner-booking-projection.mjs';

const partner='20000000-0000-4000-8000-000000000001', user='10000000-0000-4000-8000-000000000001';
const child='60000000-0000-4000-8000-000000000001', gps='60000000-0000-4000-8000-000000000002';
const options={pickup:{id:'pickup',name:'Airport (TIA)',amount:50},dropoff:{id:'return',name:'City Office',amount:50},catalog:[
 {id:child,code:'child_seat',name_pl:'Fotelik',name_en:'Child seat',amount:3,billing:'day',max_quantity:3,active:true},
 {id:gps,code:'gps',name_pl:'GPS',name_en:'GPS',amount:10,billing:'rental',max_quantity:1,active:true},
]};
async function quote(days=5,selections=[{id:child,quantity:2},{id:gps,quantity:1}]) {
 return makeBookingQuote({options,selections,hasAdditionalDriver:false,context:{userId:user,carId:'car',days},
  rental:{base_total:40*days,final_total:50*days},days,marginPercent:25,loyaltyPercent:10,currency:'EUR',exchangeRate:4.3});
}
const full=await quote(), shorter=await quote(2), more=await quote(5,[{id:child,quantity:3},{id:gps,quantity:1}]);
test('five-day quote: two extras, two fee legs, loyalty, online PLN and cash deposit stay separate',()=>{
 const p=full.publicQuote.pricing;
 assert.equal(p.total_cents,41650);assert.equal(p.pickup_payment_cents,34000);assert.equal(p.online_pln_cents,32895);
 assert.equal(p.items.filter(x=>x.kind==='pickup'||x.kind==='return').length,2);
 assert.equal(p.items.find(x=>x.id===child).customer_cents,3750);
 const projection=partnerBookingProjection({id:'booking',pricing_items_snapshot:full.snapshot,deposit_snapshot:'100.00'});
 assert.equal(projection.deposit_cents,10000);assert.equal(projection.items.reduce((s,i)=>s+i.amount_cents,0),34000);
 assert.ok(!JSON.stringify(projection).match(/commission|gross_cents|customer_cents|loyalty|online_pln/));
});
test('quantity and dates change the server fingerprint and exact amounts',()=>{
 assert.notEqual(shorter.publicQuote.fingerprint,full.publicQuote.fingerprint);assert.notEqual(more.publicQuote.fingerprint,full.publicQuote.fingerprint);
 assert.equal(shorter.publicQuote.pricing.items.find(x=>x.id===child).customer_cents,1500);
 assert.equal(shorter.publicQuote.pricing.items.find(x=>x.id===gps).customer_cents,1250);
 assert.equal(more.publicQuote.pricing.items.find(x=>x.id===child).customer_cents,5625);
});
test('historical bookings have no invented items; unknown and zero deposit are distinct',()=>{
 assert.deepEqual(partnerBookingProjection({id:'old',deposit_snapshot:null}),{id:'old',items:[],deposit_cents:null});
 assert.equal(partnerBookingProjection({id:'old',deposit_snapshot:0}).deposit_cents,0);
});
const code=ts.transpileModule(await readFile(new URL('../../supabase/functions/partner-booking-items/index.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function handler({auth=true,fail=false}={}) {
 const records=[{id:'own',partner_id:partner,pricing_items_snapshot:full.snapshot,deposit_snapshot:100},{id:'foreign',partner_id:'other',deposit_snapshot:200}];
 class Query {
  constructor(table){this.table=table;this.filters=[];this.one=false;}
  select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}in(k,v){this.filters.push(r=>v.includes(r[k]));return this;}maybeSingle(){this.one=true;return this;}
  then(resolve,reject){const data=(this.table==='partners'?[{id:partner,user_id:user}]:records).filter(r=>this.filters.every(f=>f(r)));return Promise.resolve({data:this.one?data[0]:data,error:fail?new Error('failed'):null}).then(resolve,reject);}
 }
 let handle;
 const security={authenticatedUser:async()=>{if(!auth)throw new Error('auth');return{id:user};},serviceClient:()=>({from:t=>new Query(t)}),enforceRateLimit:async()=>{},isUuid:x=>typeof x==='string',corsHeaders:()=>({}),jsonResponse:(_r,v,status=200)=>Response.json(v,{status}),publicErrorMessage:e=>({status:e.message==='auth'?401:500,message:'Unavailable'})};
 vm.runInNewContext(code,{exports:{},require:n=>n.includes('server.ts')?{serve:f=>handle=f}:n.includes('ride24-security')?security:n.includes('booking-request')?{readJsonObject:r=>r.json()}:n.includes('partner-booking-projection')?{partnerBookingProjection}:(()=>{throw Error(n)})(),Response});
 return body=>handle(new Request('https://example.invalid',{method:'POST',body:JSON.stringify(body)}));
}
test('partner endpoint filters mixed own and foreign IDs before projection',async()=>{
 const r=await handler()({booking_ids:['own','foreign']});assert.equal(r.status,200);const data=await r.json();assert.deepEqual(data.bookings.map(b=>b.id),['own']);assert.equal(data.bookings[0].deposit_cents,10000);
});
test('partner endpoint rejects unauthenticated requests and database failures',async()=>{
 assert.equal((await handler({auth:false})({booking_ids:['own']})).status,401);
 assert.equal((await handler({fail:true})({booking_ids:['own']})).status,500);
});

// Reproducible fixtures produced by the deployed shared engine, also consumed by JVM tests.
if(process.env.RIDE24_NATIVE_FIXTURE_ROOT){
 const base=process.env.RIDE24_NATIVE_FIXTURE_ROOT;
 for(const app of ['client','partner']) {
  const folder=`${base}/${app}/app/src/test/resources`;await mkdir(folder,{recursive:true});
  await writeFile(`${folder}/ride24-quote.json`,JSON.stringify(full.publicQuote)+"\n");
  await writeFile(`${folder}/ride24-quote-shorter.json`,JSON.stringify(shorter.publicQuote)+"\n");
  await writeFile(`${folder}/ride24-partner-items.json`,JSON.stringify({id:'booking',...partnerBookingProjection({id:'booking',pricing_items_snapshot:full.snapshot,deposit_snapshot:100})})+"\n");
 }
}
