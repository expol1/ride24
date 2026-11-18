import test from "node:test";
import assert from "node:assert/strict";
import {commitVerifiedCaravelSupplierConfirmation}
 from "../supabase/functions/_shared/caravel-confirmation-commit.ts";
const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const QID="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const REF="04a1f3e1-1fb4-4d28-af02-979604d5c622";
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const NOW=new Date().toISOString();
const claim=()=>({id:ID,partner_id:PARTNER,provider_type:"api",
 api_provider:"caravel",status:"pending",
 api_status:"caravel_supplier_dispatch_claimed",
 manual_review:false,cancelled_at:null,api_booking_reference:null,
 stripe_session_id:"cs_test_caravel",stripe_currency:"pln",
 stripe_amount_cents:3999,caravel_supplier_quote_id:QID,
 caravel_stripe_payment_confirmed_at:new Date(Date.now()-30000).toISOString(),
 caravel_supplier_dispatch_claimed_at:new Date(Date.now()-8000).toISOString(),
});
const confirmed=()=>({
 booking_reference:REF,reference:REF,id:REF,status:"confirmed",
 provider_payload:{booking_id:REF,quote_id:QID,revision:1,payment_model:"pay_on_arrival"},
});
function db(start=claim()){
 const state={row:start,writes:0,seen:[]};
 return {state,from(name){
   assert.equal(name,"bookings");
   const filters=[],q={
    update:(payload)=>{q.payload=payload;return q;},
    eq:(col,val)=>{filters.push([col,"eq",val]);return q;},
    is:(col,val)=>{filters.push([col,"is",val]);return q;},
    select:()=>q,
    maybeSingle:async()=>{
     state.seen=filters;
     const r=state.row;
     if(!r||filters.some(([col,op,val])=>
       op==="eq"?r[col]!==val:r[col]!==null))
       return {data:null,error:null};
     state.row={...r,...q.payload};state.writes++;
     return {data:{...state.row},error:null};
    },
   };return q;
 }};
}
const run=(admin,other={})=>commitVerifiedCaravelSupplierConfirmation({
 admin,bookingId:ID,paidClaim:claim(),verifiedProviderResult:confirmed(),
 nowIso:NOW,...other,
});
test("confirmed Caravel pay-on-arrival receipt is saved BEFORE voucher permission",async()=>{
 const admin=db(),res=await run(admin);
 assert.equal(res.ok,true,JSON.stringify(res));
 assert.equal(admin.state.writes,1);
 assert.equal(res.releaseVoucher,true);
 assert.equal(res.notifyCustomer,true);
 assert.equal(admin.state.row.status,"paid");
 assert.equal(admin.state.row.api_status,"confirmed");
 assert.equal(admin.state.row.api_booking_reference,REF);
 assert.equal(admin.state.row.api_response.payment_model,"pay_on_arrival");
 assert.ok(admin.state.seen.some(([col,op,val])=>col==="api_status"&&val==="caravel_supplier_dispatch_claimed"));
});
test("bad quote, wrong provider reference and missing payment proof never issue vouchers",async()=>{
 const b=claim(),result=confirmed();
 const variants=[
  {paidClaim:{...b,api_status:"caravel_paid_awaiting_supplier"}},
  {paidClaim:{...b,stripe_session_id:null}},
  {paidClaim:{...b,api_provider:"custom"}},
  {paidClaim:{...b,caravel_supplier_dispatch_claimed_at:null}},
  {paidClaim:{...b,manual_review:true}},
  {paidClaim:{...b,api_booking_reference:REF}},
  {paidClaim:{...b,cancelled_at:NOW}},
  {verifiedProviderResult:{...result,status:"pending"}},
  {verifiedProviderResult:{...result,reference:"other"}},
  {verifiedProviderResult:{...result,provider_payload:{...result.provider_payload,
    quote_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"}}},
  {verifiedProviderResult:{...result,provider_payload:{...result.provider_payload,
    payment_model:"prepaid"}}},
  {verifiedProviderResult:{...result,provider_payload:{...result.provider_payload,
    revision:0}}},
 ];
 for(const patch of variants){
  const admin=db(),res=await run(admin,patch);
  assert.equal(res.ok,false,JSON.stringify(patch));
  assert.equal(res.releaseVoucher,false);
  assert.equal(res.notifyCustomer,false);
  assert.equal(admin.state.writes,0);
 }
});
test("concurrent cancellation after supplier confirmation prevents paid status and voucher",async()=>{
 const admin=db(),base=admin.from.bind(admin);
 admin.from=(name)=>{
  const query=base(name),original=query.update;
  query.update=(payload)=>{
   admin.state.row.status="cancelled";
   admin.state.row.cancelled_at=NOW;
   return original(payload);
  };
  return query;
 };
 const res=await run(admin);
 assert.equal(res.ok,false);
 assert.equal(res.reason,"CARAVEL_CONFIRMATION_CONCURRENT_STATE_CHANGED");
 assert.equal(res.providerReference,REF);
 assert.equal(admin.state.writes,0);
});
test("repeated confirmation cannot run twice",async()=>{
 const admin=db();
 assert.equal((await run(admin)).ok,true);
 const second=await run(admin);
 assert.equal(second.ok,false);
 assert.equal(second.releaseVoucher,false);
 assert.equal(admin.state.writes,1);
});
test("stale supplier write must be manually reconciled, not confirmed",async()=>{
 const admin=db(),b=claim();
 b.caravel_supplier_dispatch_claimed_at=new Date(Date.now()-360000).toISOString();
 const res=await run(admin,{paidClaim:b});
 assert.equal(res.ok,false);
 assert.equal(res.reason,"CARAVEL_CONFIRMATION_CLAIM_TOO_OLD_OR_INVALID");
 assert.equal(admin.state.writes,0);
});
