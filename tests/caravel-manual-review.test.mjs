import test from "node:test";
import assert from "node:assert/strict";
import {queueCaravelSupplierManualReview}
 from "../supabase/functions/_shared/caravel-manual-review.ts";

const B="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const CARAVEL="78721481-7619-44df-a9b7-5faa344b69bb";
const REF="04a1f3e1-1fb4-4d28-af02-979604d5c622";
const base=()=>({
 id:B,partner_id:CARAVEL,provider_type:"api",status:"pending",
 api_status:"caravel_supplier_dispatch_claimed",manual_review:false,
 api_booking_reference:null,cancelled_at:null,
 stripe_session_id:"cs_test_paid",
 caravel_stripe_payment_confirmed_at:"2026-11-18T10:00:00.000Z",
 partners:{api_provider:"caravel"},
});
const bad=()=>({phase:"supplier_outcome_uncertain",
 reasons:["CARAVEL_CREATE_RESULT_UNKNOWN_RECONCILE_BEFORE_RETRY"],
 externalReference:null});
function client(start=base()){
 const state={booking:start,reviews:[],bookingWrites:0,reviewWrites:0,
  insertFails:false};
 return {state,from(table){
   const filters=[];
   let payload=null;
   const query={
    select:()=>query,
    update:(value)=>{payload=value;return query;},
    eq:(col,v)=>{filters.push([col,"eq",v]);return query;},
    is:(col,v)=>{filters.push([col,"is",v]);return query;},
    limit:()=>query,
    maybeSingle:async()=>{
      const rows=table==="bookings"?
        (state.booking?[state.booking]:[]):state.reviews;
      const found=rows.find(row=>filters.every(([col,op,v])=>
        op==="eq"?row[col]===v:row[col]===null));
      if(!found)return {data:null,error:null};
      if(payload){
        assert.equal(table,"bookings");
        state.booking={...found,...payload};state.bookingWrites++;
        return {data:{...state.booking},error:null};
      }
      return {data:{...found},error:null};
    },
    insert:async value=>{
      assert.equal(table,"booking_review_queue");
      if(state.insertFails)return {error:{code:"500"}};
      state.reviews.push({...value,id:"review-1"});state.reviewWrites++;
      return {error:null};
    },
   };return query;
 }};
}
const call=(admin,extra={})=>
 queueCaravelSupplierManualReview({admin,bookingId:B,outcome:bad(),...extra});

test("ambiguous supplier outcome puts paid booking on hold and queues one minimal review",async()=>{
 const db=client(),result=await call(db);
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.action,"queued");
 assert.equal(result.mayGenerateVoucher,false);
 assert.equal(result.mayAutomaticallyRetry,false);
 assert.equal(result.mayAutomaticallyRefund,false);
 assert.equal(db.state.booking.api_status,"caravel_manual_review_required");
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(db.state.bookingWrites,1);
 assert.equal(db.state.reviewWrites,1);
 const row=db.state.reviews[0];
 assert.equal(row.provider_key,"caravel");
 assert.equal(row.provider_status,"supplier_manual_review");
 assert.deepEqual(JSON.parse(row.api_response),{
  phase:"supplier_outcome_uncertain",
  reasons:["CARAVEL_CREATE_RESULT_UNKNOWN_RECONCILE_BEFORE_RETRY"],
  external_reference:null,
 });
 assert.ok(!row.api_response.includes("client_email"));
});
test("duplicate worker cannot reset a held booking or create a second review",async()=>{
 const db=client();
 const a=await call(db),b=await call(db);
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 assert.equal(b.action,"already_queued");
 assert.equal(db.state.bookingWrites,1);
 assert.equal(db.state.reviewWrites,1);
});
test("review write failure leaves the booking safely held and a later retry can fill the queue",async()=>{
 const db=client();db.state.insertFails=true;
 const first=await call(db);
 assert.equal(first.ok,false);
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(db.state.reviewWrites,0);
 db.state.insertFails=false;
 const retry=await call(db);
 assert.equal(retry.ok,true,JSON.stringify(retry));
 assert.equal(db.state.reviewWrites,1);
});
test("invalid, cancelled before supplier, or non-Caravel bookings cannot be altered",async()=>{
 for(const patch of [
  {partner_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {provider_type:"local"},{partners:{api_provider:"avia"}},
  {stripe_session_id:null},{caravel_stripe_payment_confirmed_at:null},
  {status:"paid",api_status:"confirmed",api_booking_reference:REF},
  {status:"cancelled",api_status:"cancelled"},
  {status:"pending",api_status:"caravel_manual_review_required",manual_review:false},
 ]){
  const db=client({...base(),...patch});
  const r=await call(db);
  assert.equal(r.ok,false,JSON.stringify(patch));
  assert.equal(db.state.bookingWrites,0);
  assert.equal(db.state.reviewWrites,0);
 }
});
test("supplier reference returned despite concurrent cancellation is retained ONLY in review",async()=>{
 const db=client({...base(),status:"cancelled",cancelled_at:"2026-11-18T10:00:05.000Z"});
 const result=await call(db,{
   outcome:{phase:"confirmation",reasons:["CARAVEL_CONFIRMATION_CONCURRENT_STATE_CHANGED"],
    externalReference:REF},
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(db.state.booking.status,"cancelled");
 assert.equal(db.state.booking.api_booking_reference,null);
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(JSON.parse(db.state.reviews[0].api_response).external_reference,REF);
});
test("raw errors, personal data and unverified references cannot enter a review",async()=>{
 for(const outcome of [
  {phase:"other",reasons:["CARAVEL_ERROR"],externalReference:null},
  {phase:"supplier_response",reasons:["full email jan@example.com"],externalReference:null},
  {phase:"preflight",reasons:[],externalReference:null},
  {phase:"supplier_response",reasons:["CARAVEL_BAD"],externalReference:"not-a-uuid"},
 ]){
   const db=client(),r=await call(db,{outcome});
   assert.equal(r.ok,false);
   assert.equal(db.state.bookingWrites,0);
   assert.equal(db.state.reviewWrites,0);
 }
});
test("already-resolved review requires explicit administrative reopening",async()=>{
 const db=client({...base(),api_status:"caravel_manual_review_required",manual_review:true});
 db.state.reviews.push({id:"prior",booking_id:B,provider_key:"caravel",
  provider_status:"supplier_manual_review",resolved:true});
 const res=await call(db);
 assert.equal(res.ok,false);
 assert.equal(res.reason,"CARAVEL_REVIEW_ALREADY_RESOLVED");
 assert.equal(db.state.reviewWrites,0);
});
