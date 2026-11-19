import test from "node:test";
import assert from "node:assert/strict";
import {caravelSignatureFor} from "../supabase/functions/_shared/caravel-webhooks.ts";
import {handleCaravelProductionDelivery, CARAVEL_PRODUCTION_WEBHOOK_PATH as PATH} from "../supabase/functions/_shared/caravel-production-webhook-delivery.mjs";

const SECRET = "fictional-test-signing-key-only";
const T = 1795070000;
const event = () => ({event_id:"evt_abc1",type:"booking.cancelled",
  occurred_at:"2026-11-19T09:00:00Z",api_version:"1.67.0",operator_id:"operator_1",
  booking_id:"bk_123",external_ref:"ride24-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  revision:2,sequence:33,supplier_id:"supplier_eur",data:{booking_id:"bk_123",status:"forged"}});
const fetched = (e) => ({booking_id:e.booking_id,supplier_id:e.supplier_id,external_ref:e.external_ref,
  revision:3,status:"cancelled"});
async function invoke(p = {}) {
  const e = p.event ?? event();
  const rawBody = p.rawBody ?? JSON.stringify(e);
  const sig = await caravelSignatureFor(SECRET,T,"POST",PATH,rawBody);
  const writes = [];
  const result = await handleCaravelProductionDelivery({
    method:"POST",path:PATH,rawBody,signature:"t="+T+",v1="+sig,
    secrets:[SECRET],nowSecs:T,
    fetchBooking:async(id,sid) => { assert.equal(id,e.booking_id);assert.equal(sid,e.supplier_id);return fetched(e); },
    record:async(x) => {writes.push(x);return {accepted:true,duplicate:false,sequence_gap:false};},
    ...p,
  });
  return {result,writes};
}

test("production Caravel callback: only verified refetched supplier booking is durably observed",async()=>{
  const {result,writes}=await invoke();
  assert.equal(result.status,202);
  assert.equal(writes.length,1);
  assert.equal(writes[0].provider_status,"cancelled");
  assert.equal(writes[0].fetched_revision,3);
  assert.ok(!("data" in writes[0]),"signed event snapshot is never persisted");
});
test("tamper, invalid path, absent signing secret and stale signature fail closed",async()=>{
  const rawBody=JSON.stringify(event());
  assert.equal((await invoke({rawBody,signature:"t="+T+",v1="+"0".repeat(64)})).result.status,401);
  assert.equal((await invoke({rawBody,path:"/functions/v1/caravel-sandbox-webhook-receiver"})).result.status,405);
  assert.equal((await invoke({rawBody,secrets:[]})).result.status,503);
  assert.equal((await invoke({rawBody,nowSecs:T+301})).result.status,401);
  assert.equal((await invoke({rawBody:rawBody+" " ,signature:"t="+T+",v1="+"0".repeat(64)})).result.status,401);
});
test("cannot store unverified or wrong-supplier provider GET",async()=>{
  const {result,writes}=await invoke({fetchBooking:async()=>({...fetched(event()),supplier_id:"another_supplier"})});
  assert.equal(result.status,503);assert.equal(writes.length,0);
  assert.equal((await invoke({fetchBooking:async()=>({...fetched(event()),revision:1})})).result.status,503);
});
test("invalid signed event version, missing supplier, bad event shape are rejected",async()=>{
  assert.equal((await invoke({event:{...event(),api_version:"1.68.0"}})).result.status,400);
  assert.equal((await invoke({event:{...event(),supplier_id:null}})).result.status,400);
  assert.equal((await invoke({event:{...event(),revision:0}})).result.status,400);
});
test("duplicate reports success; durable store failure returns retriable 503",async()=>{
  assert.equal((await invoke({record:async()=>({accepted:true,duplicate:true})})).result.status,200);
  assert.equal((await invoke({record:async()=>{throw Error("db down")}})).result.status,503);
  assert.equal((await invoke({record:async()=>({accepted:true})})).result.status,503);
});

test("signed supplier self-test acknowledges without booking I/O",async()=>{
  const sample={type:"webhook.test",event_id:"evt_test_123"};
  const fail=()=>{throw Error("unexpected booking operation")};
  const options={event:sample,fetchBooking:fail,record:fail};
  assert.equal((await invoke(options)).result.status,200);
  assert.equal((await invoke({...options,signature:null})).result.status,401);
  assert.equal((await invoke({...options,event:{...sample,event_id:null}})).result.status,400);
});
