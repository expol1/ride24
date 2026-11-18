import test from "node:test";
import assert from "node:assert/strict";
import {recordVerifiedCaravelStripePayment}
 from "../supabase/functions/_shared/caravel-payment-commit.ts";
const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const CLIENT="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const QID="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const AID="5dc264ef-743d-4aa9-8579-aa0a8dcb04b7";
const CARAVEL="78721481-7619-44df-a9b7-5faa344b69bb";
const NOW=new Date().toISOString();
const hash="a".repeat(64);
const row=()=>({id:ID,client_id:CLIENT,partner_id:CARAVEL,
 provider_type:"api",status:"awaiting_payment",api_status:null,
 api_booking_reference:null,cancelled_at:null,manual_review:false,
 online_payment_pln:39.99,stripe_session_id:"cs_test_caravel",
 stripe_currency:null,stripe_amount_cents:null,api_quote_id:AID,
 caravel_supplier_quote_id:QID,caravel_supplier_id:"acct_eur",
 caravel_terms_document_id:"caravel-en-v4",
 caravel_terms_content_hash:hash,caravel_terms_language:"en",
 partners:{api_provider:"caravel",api_enabled:true}});
const quote=()=>({provider:"caravel",quote_id:QID,supplier_id:"acct_eur",
 terms_document_id:"caravel-en-v4",
 terms_content_hash:hash,terms_language:"en"});
const event=()=>({type:"checkout.session.completed",data:{object:{
 id:"cs_test_caravel",client_reference_id:ID,
 metadata:{booking_id:ID,client_id:CLIENT},
 status:"complete",payment_status:"paid",currency:"pln",
 amount_total:3999,
}}});
function db(start=row()){
 const state={row:start,reads:0,writes:0};
 return {state,from(name){
  assert.equal(name,"bookings");
  const filters=[],q={
   select:()=>q,update:(p)=>{q.payload=p;return q;},
   eq:(k,v)=>{filters.push([k,"eq",v]);return q;},
   is:(k,v)=>{filters.push([k,"is",v]);return q;},
   maybeSingle:async()=>{
    state.reads++;
    const r=state.row;
    if(!r||filters.some(([k,op,v])=>
      op==="eq"?r[k]!==v:r[k]!==null))
      return {data:null,error:null};
    if(q.payload){state.row={...r,...q.payload};state.writes++;}
    return {data:q.payload?{id:r.id}:{...state.row},error:null};
   },
  };
  return q;
 }};
}
function args(admin,changes={}){
 return {admin,rawBody:"{signed payload}",stripeSignature:"t=123,v1=verified",
  constructVerifiedEvent:async()=>event(),providerQuote:quote(),
  nowIso:NOW,...changes};
}
test("signed paid checkout moves awaiting_payment to pending supplier without voucher",async()=>{
 const admin=db(),res=await recordVerifiedCaravelStripePayment(args(admin));
 assert.equal(res.ok,true,JSON.stringify(res));
 assert.equal(res.action,"queued");
 assert.equal(res.generateVoucher,false);
 assert.equal(res.notifyConfirmed,false);
 assert.equal(admin.state.writes,1);
 assert.equal(admin.state.row.status,"pending");
 assert.equal(admin.state.row.api_status,"caravel_paid_awaiting_supplier");
 assert.equal(admin.state.row.stripe_amount_cents,3999);
 assert.equal(admin.state.row.stripe_currency,"pln");
 assert.equal(admin.state.row.caravel_stripe_payment_confirmed_at,NOW);
});
test("duplicate signed webhook does not write a second time or issue voucher",async()=>{
 const admin=db();
 const a=await recordVerifiedCaravelStripePayment(args(admin));
 const b=await recordVerifiedCaravelStripePayment(args(admin));
 assert.equal(a.ok,true);
 assert.equal(b.ok,true,JSON.stringify(b));
 assert.equal(b.action,"already_queued");
 assert.equal(b.supplierDispatchRequired,false);
 assert.equal(admin.state.writes,1);
});
test("invalid Stripe signature stops BEFORE any booking database read",async()=>{
 const admin=db();
 const res=await recordVerifiedCaravelStripePayment(args(admin,{
   constructVerifiedEvent:async()=>{throw Error("signature invalid");},
 }));
 assert.equal(res.ok,false);
 assert.equal(res.action,"reject_invalid_signature");
 assert.equal(admin.state.reads,0);
});
test("wrong client, amount, currency, session, partner or quote cannot be marked paid",async()=>{
 const cases=[
  [{client_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},{}],
  [{stripe_session_id:"cs_other"},{}],
  [{partner_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},{}],
  [{partners:{api_provider:"custom",api_enabled:true}},{}],
  [{partners:{api_provider:"caravel",api_enabled:false}},{}],
  [{caravel_supplier_quote_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},{}],
  [{caravel_terms_content_hash:"b".repeat(64)},{}],
  [{status:"cancelled",cancelled_at:NOW},{}],
  [{online_payment_pln:39.98},{}],
 ];
 for(const [patch,overrides] of cases){
  const admin=db({...row(),...patch});
  const res=await recordVerifiedCaravelStripePayment(args(admin,overrides));
  assert.equal(res.ok,false,JSON.stringify(patch));
  assert.equal(admin.state.writes,0);
 }
 for(const patch of [
  {payment_status:"unpaid"}, {currency:"eur"}, {amount_total:1},
  {metadata:{booking_id:ID,client_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"}},
 ]){
  const admin=db(),bad={...event(),data:{object:{...event().data.object,...patch}}};
  const res=await recordVerifiedCaravelStripePayment(args(admin,{
    constructVerifiedEvent:async()=>bad,
  }));
  assert.equal(res.ok,false,JSON.stringify(patch));
  assert.equal(admin.state.writes,0);
 }
});
test("concurrent state change cannot resurrect cancelled or already processed booking",async()=>{
 const admin=db(),base=admin.from.bind(admin);
 admin.from=(name)=>{
  const query=base(name);
  const update=query.update;
  query.update=(payload)=>{
    admin.state.row.status="cancelled";
    admin.state.row.cancelled_at=NOW;
    return update(payload);
  };
  return query;
 };
 const res=await recordVerifiedCaravelStripePayment(args(admin));
 assert.equal(res.ok,false);
 assert.equal(res.reason,"CARAVEL_PAYMENT_CONCURRENT_STATE_CHANGE");
 assert.equal(admin.state.writes,0);
});
