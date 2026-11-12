import test from "node:test";
import assert from "node:assert/strict";
import {CaravelSandboxClient,CaravelError} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";
const original=globalThis.fetch;
const mock=(handler)=>{globalThis.fetch=async (url,options)=>new Response(JSON.stringify(handler(String(url),options)),{status:200,headers:{"content-type":"application/json"}});};
test.afterEach(()=>{globalThis.fetch=original;});
test("production URL cannot be used",()=>assert.throws(()=>new CaravelSandboxClient("test","https://api.caravelway.com"),/SANDBOX_ONLY/));
test("requires API key",()=>assert.throws(()=>new CaravelSandboxClient(""),/SANDBOX_ONLY/));
test("fetches suppliers and preserves both suppliers",async()=>{
  const calls=[];
  mock((url,options)=>{
    calls.push({url,options});
    if(url.endsWith("/v1/capabilities"))return {data:{environment:"sandbox",api_version:"1.67.0"}};
    return {data:[{supplier_id:"one",currency:"EUR"},{supplier_id:"two",currency:"GBP"}]};
  });
  const data=await new CaravelSandboxClient("fixture").suppliers();
  assert.equal(data.data.length,2);
  assert.deepEqual(data.data.map(x=>x.currency),["EUR","GBP"]);
  assert.equal(calls[0].options.headers["X-API-Key"],"fixture");
});
test("rejects unexpected production environment",async()=>{
  mock(()=>({data:{environment:"production"}}));
  await assert.rejects(()=>new CaravelSandboxClient("fixture").suppliers(),/SANDBOX_ENVIRONMENT_REQUIRED/);
});
test("URL encodes timezone offsets",async()=>{
  const calls=[];
  mock((url)=>{calls.push(url);return url.endsWith("/v1/capabilities")?{data:{environment:"sandbox"}}:{data:[]};});
  await new CaravelSandboxClient("fixture").availability({pickup_location_id:"loc1",dropoff_location_id:"loc1",pickup:"2026-12-01T10:00:00+02:00",dropoff:"2026-12-05T10:00:00+02:00"});
  assert.ok(calls[1].includes("%2B02%3A00"));
});
test("fails closed without premium and explicit zero amounts",()=>{
  const check=CaravelSandboxClient.isPremiumZeroRisk;
  assert.equal(check({plan:"basic",protection:{excess:{amount:0,currency:"EUR"},deposit:{amount:0,currency:"EUR"}}}),false);
  assert.equal(check({plan:"premium",protection:{excess:{amount:0,currency:"EUR"}}}),false);
  assert.equal(check({plan:"premium",protection:{excess:{amount:0,currency:"EUR"},deposit:{amount:0,currency:"EUR"}}}),true);
  assert.equal(check({plan:"premium",protection:{excess:{amount:0,currency:"EUR"},deposit:{amount:200,currency:"EUR"}}}),false);
});
test("booking requires sandbox-prefixed external reference",async()=>{
  await assert.rejects(()=>new CaravelSandboxClient("fixture").bookSandbox({quote_id:"q",external_ref:"live-1",drivers:[],customer:{}},"key"),/SANDBOX_BOOKING_GUARD/);
});
test("cancel requires immutable booking id and revision",async()=>{
  await assert.rejects(()=>new CaravelSandboxClient("fixture").cancelSandbox("",0,"key"),/INVALID_CANCEL/);
});

test("vehicle classes use documented reference endpoint",async()=>{
 const calls=[];
 mock((url)=>{calls.push(url);return url.endsWith("/v1/capabilities")?{data:{environment:"sandbox"}}:{data:[]};});
 await new CaravelSandboxClient("fixture").vehicleClasses(500);
 assert.equal(calls[1],"https://sandbox-api.caravelway.com/v1/reference/vehicle-classes?limit=200");
});
test("supplier-scoped availability sends X-Supplier-Id",async()=>{
 const calls=[];
 mock((url,options)=>{calls.push({url,options});return url.endsWith("/v1/capabilities")?{data:{environment:"sandbox"}}:{data:[]};});
 await new CaravelSandboxClient("fixture").availability({pickup_location_id:"p",dropoff_location_id:"p",pickup:"2027-01-10T10:00:00+02:00",dropoff:"2027-01-12T10:00:00+02:00"},"supplier-1");
 assert.equal(calls[1].options.headers["X-Supplier-Id"],"supplier-1");
});
test("rejects malformed successful API envelopes",async()=>{
 mock((url)=>url.endsWith("/v1/capabilities")?{data:{environment:"sandbox"}}:{unexpected:true});
 await assert.rejects(()=>new CaravelSandboxClient("fixture").locations(),/INVALID_RESPONSE_ENVELOPE/);
});
