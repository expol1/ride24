// No network/secret: HMAC sandbox receiver tests with original test payload only.
import test from "node:test";
import assert from "node:assert/strict";
import {inspectCaravelSandboxWebhook} from "../supabase/functions/_shared/caravel-webhook-probe.ts";
import {caravelSignatureFor} from "../supabase/functions/_shared/caravel-webhooks.ts";

const secret="sandbox_fixture_local_only";
const time=Date.UTC(2026,10,16,17,0,0)/1000;
const path="/functions/v1/caravel-sandbox-webhook-probe";
const body=JSON.stringify({
  event_id:"00000000-0000-4000-8000-000000000001",type:"booking.confirmed",
  occurred_at:"2026-11-16T17:00:00Z",api_version:"1.67.0",
  operator_id:"00000000-0000-4000-8000-000000000002",
  booking_id:"00000000-0000-4000-8000-000000000003",
  external_ref:"ride24-sandbox-probe",revision:1,sequence:1,
  data:{booking_id:"00000000-0000-4000-8000-000000000003",status:"confirmed",revision:1},
});
async function signed(raw=body,opts={}){
  const signature=`t=${time},v1=${await caravelSignatureFor(secret,time,"POST",path,raw)}`;
  return inspectCaravelSandboxWebhook({method:"POST",path,body:raw,signature,secrets:[secret],nowSecs:time,...opts});
}

test("sandbox probe verifies exact signed request and returns no personal payload",async()=>{
  const result=await signed();
  assert.equal(result.status,202);
  assert.equal(result.accepted,true);
  assert.equal(result.revision,1);
  assert.equal(JSON.stringify(result).includes("external_ref"),false);
});
test("tamper, wrong path, old timestamp and wrong secret rejected",async()=>{
  const valid=await signed();
  assert.equal(valid.accepted,true);
  const signature=`t=${time},v1=${await caravelSignatureFor(secret,time,"POST",path,body)}`;
  for(const patch of [
    {body:body+" "},
    {path:"/functions/v1/other"},
    {nowSecs:time+301},
    {secrets:["wrong"]},
  ]){
    const r=await inspectCaravelSandboxWebhook({method:"POST",path,body,signature,secrets:[secret],nowSecs:time,...patch});
    assert.equal(r.status,401);
  }
});
test("no configured HMAC secret, GET, oversized body are rejected",async()=>{
  assert.equal((await signed(body,{secrets:[]})).status,503);
  assert.equal((await signed(body,{method:"GET"})).status,405);
  assert.equal((await signed("x".repeat(33000))).status,413);
});
test("signed malformed event still fails after passing HMAC validation",async()=>{
  const result=await signed('{"not":"a webhook event"}');
  assert.deepEqual([result.status,result.accepted,result.reason],[400,false,"INVALID_EVENT"]);
});
