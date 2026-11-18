import test from "node:test";
import assert from "node:assert/strict";
import {claimCaravelPaidDispatch}
 from "../supabase/functions/_shared/caravel-dispatch-claim.ts";
const NOW="2030-03-17T17:46:40.000Z";
const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const QUOTE="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const HASH="a".repeat(64);
const quote=()=>({provider:"caravel",quote_id:QUOTE,supplier_id:"acct_eur",
 terms_document_id:"caravel-en-v4",terms_content_hash:HASH,terms_language:"en"});
const booking=()=>({
 id:ID,partner_id:PARTNER,provider_type:"api",status:"pending",
 api_status:"caravel_paid_awaiting_supplier",
 manual_review:false,cancelled_at:null,api_booking_reference:null,
 stripe_session_id:"cs_live_paid_fixture",stripe_currency:"pln",stripe_amount_cents:3999,
 caravel_stripe_payment_confirmed_at:"2030-03-17T17:46:10.000Z",
 caravel_supplier_dispatch_claimed_at:null,
 caravel_supplier_quote_id:QUOTE,caravel_supplier_id:"acct_eur",
 caravel_terms_document_id:"caravel-en-v4",
 caravel_terms_content_hash:HASH,caravel_terms_language:"en",
 partners:{api_provider:"caravel",api_enabled:true},
});
function client(start=booking()){
 const state={row:start,mutations:0};
 return {state,from(table){
  assert.equal(table,"bookings");
  return {update(payload){
   const filters=[];
   const query={
    eq:(col,v)=>{filters.push([col,"eq",v]);return query;},
    is:(col,v)=>{filters.push([col,"is",v]);return query;},
    not:(col,op,v)=>{filters.push([col,"not_is",v]);return query;},
    select:()=>({maybeSingle:async()=>{
     const r=state.row;
     if(!r||filters.some(([c,op,v])=>
       op==="eq"?r[c]!==v:op==="is"?r[c]!==null:r[c]===null))
       return {data:null,error:null};
     state.row={...r,...payload};state.mutations++;
     return {data:{...state.row},error:null};
    }}),
   };
   return query;
  }};
 }};
}
const call=(admin,overrides={})=>claimCaravelPaidDispatch({
 admin,bookingId:ID,nowIso:NOW,partnerApiEnabled:true,
 providerQuote:quote(),...overrides,
});
test("conditional UPDATE permits exactly one post-Stripe claim and returns proof",async()=>{
 const db=client();
 const [first,second]=await Promise.all([call(db),call(db)]);
 assert.equal(first.ok,true,JSON.stringify(first));
 assert.equal(first.persistedBooking.api_provider,"caravel");
 assert.equal(second.ok,false);
 assert.equal(second.reason,"CARAVEL_CLAIM_ALREADY_TAKEN_OR_INELIGIBLE");
 assert.equal(db.state.mutations,1);
 assert.equal(db.state.row.api_status,"caravel_supplier_dispatch_claimed");
});
test("ineligible or ambiguous booking can never acquire the supplier claim",async()=>{
 for(const patch of [
  {manual_review:true},{status:"cancelled"},{cancelled_at:NOW},
  {api_booking_reference:"caravel-uuid"},{api_status:"confirmed"},
  {caravel_stripe_payment_confirmed_at:null},{partner_id:"bad"},
  {provider_type:"local"},
 ]){
  const db=client({...booking(),...patch});
  const res=await call(db);
  assert.equal(res.ok,false,JSON.stringify(patch));
  assert.equal(db.state.mutations,0);
 }
});
test("must not claim if partner disabled or malformed server request",async()=>{
 const db=client();
 for(const changes of [
  {partnerApiEnabled:false},{bookingId:"bad"},{nowIso:"yesterday"},
 ]){
  const res=await call(db,changes);assert.equal(res.ok,false);
 }
 assert.equal(db.state.mutations,0);
});
test("quote mismatch and partner scope mutation hold claim for manual review",async()=>{
 for(const [patch,query] of [
   [{}, {...quote(),quote_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"}],
   [{partners:{api_provider:"custom",api_enabled:true}},quote()],
   [{partners:{api_provider:"caravel",api_enabled:false}},quote()],
 ]){
  const db=client({...booking(),...patch});
  const res=await call(db,{providerQuote:query});
  assert.equal(res.ok,false);
  assert.equal(db.state.mutations,1,"claim stays durable even if post-claim validation fails");
 }
});
test("DB failure does not authorize an external call",async()=>{
 const broken={from(){throw Error("db unavailable");}};
 const res=await call(broken);
 assert.equal(res.ok,false);
 assert.equal(res.reason,"CARAVEL_CLAIM_DB_REQUEST_FAILED");
});
