import test from "node:test";
import assert from "node:assert/strict";
import {advanceApiPayment,apiSupplierApprovalDeadline,DefiniteApiFailure}
  from "../../supabase/functions/_shared/api-payment-flow.mjs";

const now=()=>new Date().toISOString();
const ago=ms=>new Date(Date.now()-ms).toISOString();
const future=ms=>new Date(Date.now()+ms).toISOString();
const prepared=()=>({provider:"kayfleet",body:{pickup_datetime:future(7*86400000)}});
function scenario({state="paid",last_error=null,result={status:"pending",booking_reference:"kayfleet-1"},
  status={status:"pending",booking_reference:"kayfleet-1",needs_manual_review:false},
  cancel={status:"cancelled",booking_reference:"kayfleet-1",needs_manual_review:false},
  supplier_deadline_at=null,revalidateError=null,createError=null}={}) {
  let row={
    booking_id:"R24-KF-1",state,paid_at:ago(60000),payment_intent:"pi_test_kayfleet",
    updated_at:now(),provider_reference:state==="paid"?null:"kayfleet-1",
    prepared_quote:state==="paid"?null:prepared(),supplier_deadline_at,last_error,
  };
  const events=[];
  const clone=()=>structuredClone(row);
  const deps={
    get:async()=>clone(),
    move:async(_id,expected,patch)=>{if(row.state!==expected)return null;Object.assign(row,patch);return clone();},
    claimValidation:async(_id,w)=>{if(row.state!==w.state||w.updated_at!==row.updated_at)return null;
      row.state="revalidating";row.updated_at=now();return clone();},
    claimDispatch:async(_id,q)=>{if(row.state!=="revalidating")return null;
      row.state="dispatching";row.prepared_quote=q;row.updated_at=now();return clone();},
    revalidate:async()=>{events.push("revalidate");if(revalidateError)throw revalidateError;return prepared();},
    create:async()=>{events.push("create");if(createError)throw createError;return result;},
    status:async()=>{events.push("GET-status");return status;},
    recover:async(_id,w)=>{events.push("GET-recover");return w.provider_reference?status:null;},
    cancel:async()=>{events.push("POST-cancel");return cancel;},
    finalize:async()=>{events.push("voucher");},
    refund:async()=>{events.push("stripe-refund");return {id:"re_test_kayfleet",status:"succeeded"};},
    refundNotice:async()=>{events.push("refund-notice");}
  };
  return {deps,events,read:()=>clone()};
}
test("KayFleet payment dispatch occurs once, then pending supplier holds voucher",async()=>{
  const t=scenario();
  const r=await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(r.state,"provider_pending");
  assert.deepEqual(t.events,["revalidate","create"]);
  assert.equal(t.read().prepared_quote.provider,"kayfleet");
  assert.ok(Date.parse(t.read().supplier_deadline_at)>Date.now()+20*3600000);
  assert.ok(!t.events.includes("voucher"));
});
test("KayFleet existing shared payment flow confirms only after later verified supplier status",async()=>{
  const t=scenario({status:{status:"confirmed",booking_reference:"kayfleet-1",needs_manual_review:false}});
  await advanceApiPayment(t.deps,"R24-KF-1");
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"confirmed");
  assert.equal(t.events.filter(x=>x==="create").length,1);
  assert.deepEqual(t.events,["revalidate","create","GET-status","voucher"]);
});
test("KayFleet explicitly denied booking uses shared Stripe full-refund path; no voucher",async()=>{
  const t=scenario({state:"provider_pending",status:{
    status:"rejected",booking_reference:"kayfleet-1",definitive_rejection:true,
    needs_manual_review:false
  }});
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"refund_pending");
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"refunded");
  assert.ok(t.events.includes("stripe-refund"));
  assert.ok(!t.events.includes("voucher"));
  assert.ok(!t.events.includes("create"));
});
test("KayFleet ambiguous status or changed total is manual review, never refund or voucher",async()=>{
  const t=scenario({state:"provider_pending",status:{
    status:"confirmed",booking_reference:"kayfleet-1",needs_manual_review:true,
  }});
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"unknown");
  assert.equal(t.read().last_error,"KAYFLEET_RECONCILIATION_REQUIRED");
  assert.ok(!t.events.includes("stripe-refund"));
  assert.ok(!t.events.includes("voucher"));
});
test("KayFleet 24h supplier deadline allows confirmed, otherwise cancels proven pending once",async()=>{
  const t=scenario({state:"provider_pending",supplier_deadline_at:ago(10000)});
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"refund_pending");
  assert.deepEqual(t.events,["GET-status","POST-cancel"]);
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"refunded");
  assert.ok(!t.events.includes("voucher"));
});
test("KayFleet unknown cancel outcome is GET-only on subsequent retry, never a second POST",async()=>{
  const t=scenario({state:"unknown",last_error:"KAYFLEET_TIMEOUT_CANCEL_UNCONFIRMED",
    supplier_deadline_at:ago(10000)});
  await advanceApiPayment(t.deps,"R24-KF-1");
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.deepEqual(t.events,["GET-status","GET-status"]);
  assert.equal(t.read().state,"unknown");
});
test("KayFleet POST 409 means definite no booking and makes refund eligible",async()=>{
  const t=scenario({createError:new DefiniteApiFailure("KAYFLEET_QUOTE_CONFLICT_NO_BOOKING")});
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.read().state,"refund_pending");
  assert.ok(!t.events.includes("voucher"));
});
test("KayFleet uncertain create transport error never blindly retries POST or refunds",async()=>{
  const t=scenario({createError:new Error("NETWORK")});
  await advanceApiPayment(t.deps,"R24-KF-1");
  await advanceApiPayment(t.deps,"R24-KF-1");
  assert.equal(t.events.filter(x=>x==="create").length,1);
  assert.equal(t.read().state,"unknown");
  assert.ok(!t.events.includes("stripe-refund"));
});
test("KayFleet deadline reuses supplier clock and is bounded before pickup",()=>{
  const q=prepared(), received=Date.now();
  const deadline=apiSupplierApprovalDeadline({prepared_quote:q,supplier_received_at:new Date(received).toISOString()});
  assert.ok(deadline>=received+23*3600000);
  assert.ok(deadline<=received+24*3600000);
  const cutoff=apiSupplierApprovalDeadline({prepared_quote:{provider:"kayfleet",body:{pickup_datetime:future(3600000)}},supplier_received_at:now()});
  assert.ok(cutoff<Date.now());
  assert.equal(apiSupplierApprovalDeadline({prepared_quote:{provider:"renteon_aggregator"}}),null);
});
