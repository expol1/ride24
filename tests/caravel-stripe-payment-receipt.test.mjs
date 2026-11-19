import test from "node:test";
import assert from "node:assert/strict";
import {persistCaravelPaidStripeReceipt}
 from "../supabase/functions/_shared/caravel-stripe-payment-receipt.ts";
const B="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const CLIENT="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const session=()=>({
 id:"cs_test_caravel",client_reference_id:B,status:"complete",
 payment_status:"paid",currency:"pln",amount_total:3999,
 metadata:{booking_id:B,client_id:CLIENT},
});
function db(){
 const state={payment:null,writes:0,writeError:false};
 return {state,from(name){
  assert.equal(name,"payments");const filters=[];
  const query={
   select:()=>query,
   eq:(k,v)=>{filters.push([k,v]);return query;},
   maybeSingle:async()=>({
     data:state.payment&&filters.every(([k,v])=>state.payment[k]===v)?
       {...state.payment}:null,error:null,
   }),
   insert:async payload=>{
    if(state.writeError)return {error:{code:"500"}};
    if(state.payment)return {error:{code:"23505"}};
    state.payment={...payload};state.writes++;return {error:null};
   },
  };return query;
 }};
}
const args=(admin,change={})=>({
 admin,bookingId:B,clientId:CLIENT,verifiedStripeSession:session(),
 expectedFeeMinor:3999,...change,
});
test("persisted paid receipt exactly matches a verified signed Stripe checkout",async()=>{
 const admin=db(),out=await persistCaravelPaidStripeReceipt(args(admin));
 assert.equal(out.ok,true,JSON.stringify(out));
 assert.equal(admin.state.writes,1);
 assert.equal(admin.state.payment.amount,39.99);
 assert.equal(admin.state.payment.status,"paid");
 const duplicate=await persistCaravelPaidStripeReceipt(args(admin));
 assert.equal(duplicate.ok,true);
 assert.equal(admin.state.writes,1);
});
test("forged unpaid, wrong amount, currency, booking or client cannot create paid receipt",async()=>{
 for(const patch of [
  {status:"open"},{payment_status:"unpaid"},{currency:"eur"},
  {amount_total:3998},{client_reference_id:"another"},
  {metadata:{booking_id:"another",client_id:CLIENT}},
  {metadata:{booking_id:B,client_id:"another"}},
 ]){
  const admin=db(),result=await persistCaravelPaidStripeReceipt(args(admin,{
    verifiedStripeSession:{...session(),...patch},
  }));
  assert.equal(result.ok,false,JSON.stringify(patch));
  assert.equal(admin.state.writes,0);
 }
});
test("existing paid row for different booking, currency or money never authorizes dispatch",async()=>{
 for(const patch of [
  {booking_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {status:"pending"},{currency:"eur"},{amount:39.98},
 ]){
  const admin=db();
  admin.state.payment={booking_id:B,stripe_session_id:"cs_test_caravel",
   amount:39.99,currency:"pln",status:"paid",...patch};
  const result=await persistCaravelPaidStripeReceipt(args(admin));
  assert.equal(result.ok,false,JSON.stringify(patch));
  assert.equal(result.reason,"CARAVEL_STRIPE_RECEIPT_CONFLICT");
  assert.equal(admin.state.writes,0);
 }
});
test("receipt persistence outage blocks queued supplier work, no false payment proof",async()=>{
 const admin=db();admin.state.writeError=true;
 const result=await persistCaravelPaidStripeReceipt(args(admin));
 assert.equal(result.ok,false);
 assert.equal(result.reason,"CARAVEL_STRIPE_RECEIPT_WRITE_FAILED");
 assert.equal(admin.state.payment,null);
});
