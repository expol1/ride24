// Caravel certification negative-case rehearsal. MOCK API ONLY.
// These tests do not satisfy any live traffic gates.
import test from "node:test";
import assert from "node:assert/strict";
import {CaravelClient,CaravelError} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";
import {buildCaravelBookingDraft} from "../supabase/functions/_shared/caravel-booking.ts";
const previousFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=previousFetch;});
const cid="d1310d3d-2eb1-4b83-90bc-1905140a10ba";
const idem="e5cf457f-8075-4421-93fa-88af6995f3cf";
const client=()=>new CaravelClient({environment:"sandbox",apiKey:"fixture",retryMaxAttempts:2,retryMaxWaitMs:0});
const resp=(data,status=200,meta={})=>new Response(JSON.stringify(status>=400?{error:{code:data,request_id:"cert-fixture"}}:{data,meta}),{status});

test("401,403,404,409,422 error families retain status and code, never retry",async()=>{
  for(const [status,code] of [[401,"unauthenticated"],[403,"forbidden"],[404,"not_found"],[409,"revision_conflict"],[422,"validation_error"]]){
    let n=0;
    globalThis.fetch=async(url)=>{
      if(new URL(url).pathname==="/v1/capabilities")return resp({environment:"sandbox",api_version:"1.67.0"});
      n++;return resp(code,status);
    };
    await assert.rejects(()=>client().bookingStatusSandbox(cid,"acct_eur"),e=>
      e instanceof CaravelError&&e.status===status&&e.code===code&&e.requestId==="cert-fixture");
    assert.equal(n,1,`no retries for ${status}`);
  }
});

test("unrecognized error code is preserved without retry",async()=>{
  let n=0;
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname==="/v1/capabilities")return resp({environment:"sandbox"});
    n++;return resp("future_error_unknown_to_ride24",422);
  };
  await assert.rejects(()=>client().locations(200,"acct_eur"),e=>e instanceof CaravelError&&e.code==="future_error_unknown_to_ride24");
  assert.equal(n,1);
});

test("cross-endpoint opaque token yields 422 and is not retried",async()=>{
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url);
    if(u.pathname==="/v1/capabilities")return resp({environment:"sandbox"});
    calls.push({path:u.pathname,token:u.searchParams.get("page_token"),scope:opts.headers["X-Supplier-Id"]});
    return resp(u.searchParams.has("page_token")?"malformed_page_token":"validation_error",422);
  };
  const c=client();
  await assert.rejects(()=>c.listBookings({page_token:"from-other-endpoint+opaque=="},"acct_eur"),
    e=>e instanceof CaravelError&&e.status===422&&e.code==="malformed_page_token");
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,"/v1/bookings");
  assert.equal(calls[0].token,"from-other-endpoint+opaque==");
  assert.equal(calls[0].scope,"acct_eur");
});

test("expired quote blocks draft before any provider write, including exact expiry",async()=>{
  const NOW=Date.parse("2027-02-01T12:00:00Z");
  let writes=0;globalThis.fetch=async()=>{writes++;throw Error("unexpected network");};
  for(const expiresAt of [NOW-1,NOW]){
    const booking={
      idempotency_key:idem,ride24_booking_id:"R24-test",vehicle_group_id:"opaque_group",
      main_driver:{name:"Sandbox Tester",age:30},client_email:"fictional@example.test",
      currency:"EUR",partner_discount_percent:0,partner_amount:132,quote_reference:cid,
      provider_quote_data:{provider:"caravel",quote_id:cid,supplier_id:"acct_eur",
        vehicle_id:"opaque_group",protection_id:"includedPremium",plan:"premium",
        currency:"EUR",amounts:{total:132},drivers:[{age:30,role:"main"}],
        expires_at:new Date(expiresAt).toISOString()},
    };
    const result=buildCaravelBookingDraft(booking,NOW);
    assert.equal(result.ok,false);
    assert.ok(result.errors.includes("QUOTE_EXPIRED"));
  }
  assert.equal(writes,0);
});
