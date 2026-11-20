import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source=await readFile(new URL('../../supabase/functions/arvent-admin-confirm/index.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const ARVENT='bf29a373-c464-4cec-87a7-c3218ea1ea51';
const BID='11111111-1111-4111-8111-111111111111';

function setup({role='admin',state='provider_pending',live={},rpcResult=true,provider='arvent_kolaycar'}={}){
 const calls=[];let handler;
 const workflow={booking_id:BID,state,provider_reference:'A-1',prepared_quote:{provider}};
 const booking={id:BID,partner_id:ARVENT,status:'pending',api_booking_reference:'A-1'};
 const admin={
  from(table){const q={table,filters:{},select(){return q;},eq(k,v){q.filters[k]=v;return q;},in(){return q;},order(){return q;},limit(){return q;},
   async maybeSingle(){return {data:table==='api_booking_workflows'?workflow:table==='bookings'?{...booking,status:calls.includes('finalize')?'paid':'pending',api_status:'confirmed'}:null};}};return q;},
  async rpc(name,args){calls.push('rpc:'+name);assert.equal(args.p_provider_reference,'A-1');assert.ok(args.p_evidence.length>=15);return {data:rpcResult,error:null};},
 };
 const require=n=>{
  if(n.includes('ride24-security'))return {corsHeaders:()=>({}),jsonResponse:(_r,b,s=200)=>Response.json(b,{status:s}),
   requireAdmin:async()=>{if(role!=='admin')throw Error('ADMIN_REQUIRED');return {user:{id:'admin-1',email:'ops@example.invalid'},admin};}};
  if(n.includes('partner-api'))return {loadPartnerCredentials:async()=>({partner_id:ARVENT})};
  if(n.includes('arvent-kolaycar'))return {arventBookingStatus:async()=>{calls.push('supplier-get');
   return {booking_reference:'A-1',supplier_status_type:0,supplier_status_label:'received',terms_verified:true,status:'pending',provider_payload:{}, ...live};}};
  if(n.includes('api-payment-runtime'))return {runApiPayment:async()=>{calls.push('finalize');return {state:'confirmed'};}};
  if(n.includes('stripe'))return {default:class{}};
  throw Error('Unexpected import '+n);
 };
 const sandbox={exports:{},require,Response,console,Deno:{serve:f=>handler=f,env:{get:()=> 'sk_test'}}};
 vm.runInNewContext(js,sandbox);
 const call=body=>handler(new Request('https://x.invalid',{method:'POST',body:JSON.stringify(body)})).then(async r=>({status:r.status,body:await r.json()}));
 return {call,calls};
}
const evidence='WhatsApp Mustafa 20.11 14:05: approved, car assigned';

test('only admins can use manual Arvent confirmation',async()=>{
 const s=setup({role:'client'});
 const r=await s.call({action:'confirm',booking_id:BID,evidence});
 assert.equal(r.status,403);assert.deepEqual(s.calls,[]);
});
test('manual confirmation requires written evidence',async()=>{
 const s=setup();
 const r=await s.call({action:'confirm',booking_id:BID,evidence:'ok'});
 assert.equal(r.body.error,'EVIDENCE_REQUIRED');assert.deepEqual(s.calls,[]);
});
test('supplier status is read live first; cancelled or changed reservations are never confirmed',async()=>{
 for(const live of [{supplier_status_type:3},{supplier_status_type:6},{terms_verified:false},{booking_reference:'OTHER'}]){
  const s=setup({live});
  const r=await s.call({action:'confirm',booking_id:BID,evidence});
  assert.equal(r.body.error,'SUPPLIER_STATUS_NOT_CONFIRMABLE');
  assert.deepEqual(s.calls,['supplier-get']);
 }
});
test('only a workflow still awaiting approval can be confirmed (not one claimed by the 24h timeout)',async()=>{
 for(const state of ['unknown','confirmed','refund_pending','refunded']){
  const s=setup({state});
  const r=await s.call({action:'confirm',booking_id:BID,evidence});
  assert.equal(r.body.error,'NOT_AWAITING_APPROVAL');assert.deepEqual(s.calls,[]);
 }
});
test('non-Arvent bookings are refused',async()=>{
 const s=setup({provider:'renteon_aggregator'});
 const r=await s.call({action:'confirm',booking_id:BID,evidence});
 assert.equal(r.body.error,'NOT_ARVENT_BOOKING');assert.deepEqual(s.calls,[]);
});
test('lost compare-and-set (parallel timeout/confirmation) issues no voucher',async()=>{
 const s=setup({rpcResult:false});
 const r=await s.call({action:'confirm',booking_id:BID,evidence});
 assert.equal(r.body.error,'STATE_CHANGED');assert.ok(!s.calls.includes('finalize'));
});
test('status 0 with explicit Arvent evidence: atomic confirm + audit, then one shared finalisation',async()=>{
 const s=setup();
 const r=await s.call({action:'confirm',booking_id:BID,evidence});
 assert.equal(r.body.success,true);
 assert.deepEqual(s.calls,['supplier-get','rpc:arvent_admin_confirm','finalize']);
});
