// Isolated Caravel retry/pagination checks (mock network only).
import test from "node:test";
import assert from "node:assert/strict";
import {CaravelClient,CaravelError,parseCaravelRetryAfter} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";
const saved=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=saved;});
const client=(retryMaxWaitMs=1000)=>new CaravelClient({apiKey:"fixture",environment:"sandbox",retryMaxAttempts:3,retryMaxWaitMs});
const caps={data:{environment:"sandbox",api_version:"1.67.0"}};
const success=(data,meta={})=>new Response(JSON.stringify({data,meta}),{status:200});
const failure=(status,code,delay="0")=>new Response(JSON.stringify({error:{code,request_id:"req"}}),{status,headers:{"Retry-After":delay}});
const id="00000000-0000-4000-8000-000000000010";
const q={pickup:{location_id:"A",at:"2027-01-01T10:00:00Z"},dropoff:{location_id:"A",at:"2027-01-04T10:00:00Z"},vehicle_id:"V",protection_id:"P",plan:"premium",drivers:[{age:30,role:"main"}]};

test("Retry-After seconds/date parser",()=>{
  assert.equal(parseCaravelRetryAfter("2"),2000);
  assert.equal(parseCaravelRetryAfter("Tue, 17 Nov 2026 10:00:00 GMT",Date.UTC(2026,10,17,9,59,59)),1000);
  assert.equal(parseCaravelRetryAfter("wrong"),null);
});
test("429 GET retry follows server delay and keeps same supplier",async()=>{
  const calls=[]; let n=0;
  globalThis.fetch=async(url,opts)=>{
    const path=new URL(url).pathname;
    if(path==="/v1/capabilities")return success(caps.data);
    calls.push([url,opts.headers["X-Supplier-Id"]]);
    return ++n===1 ? failure(429,"rate_limited"):success([{location_id:"A"}]);
  };
  assert.equal((await client().locations(200,"sup-1")).data.length,1);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0],calls[1]);
});
test("503 POST retry reuses EXACT body and idempotency UUID",async()=>{
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    if(new URL(url).pathname==="/v1/capabilities")return success(caps.data);
    calls.push({key:opts.headers["Idempotency-Key"],body:opts.body});
    return calls.length===1 ? failure(503,"unavailable"):success({quote_id:id,status:"active"});
  };
  assert.equal((await client().quote(q,id)).data.quote_id,id);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0],calls[1]);
  assert.equal(calls[0].key,id);
});
test("422 never retries, long Retry-After never hammers provider",async()=>{
  let n=0;
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname==="/v1/capabilities")return success(caps.data);
    n++;return failure(422,"invalid", "0");
  };
  await assert.rejects(()=>client().quote(q,id),e=>e instanceof CaravelError && e.status===422);
  assert.equal(n,1);
  n=0;
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname==="/v1/capabilities")return success(caps.data);
    n++;return failure(429,"rate_limited","90");
  };
  await assert.rejects(()=>client().quote(q,id),e=>e instanceof CaravelError && e.status===429);
  assert.equal(n,1);
});
test("location pagination preserves opaque tokens and isolates supplier/endpoint",async()=>{
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url);if(u.pathname==="/v1/capabilities")return success(caps.data);
    const token=u.searchParams.get("page_token");
    calls.push([u.pathname,token,opts.headers["X-Supplier-Id"]]);
    if(u.pathname==="/v1/reference/vehicles")return success([{vehicle_id:"V1"}]);
    if(!token)return success([{location_id:"A"}],{next_page:"abc_1"});
    if(token==="abc_1")return success([{location_id:"B"}],{next_page:"x+y/z=="});
    if(token==="x+y/z==")return success([{location_id:"C"}],{next_page:null});
    throw Error("Unexpected page");
  };
  const c=client();
  const a=await c.locations(200,"sup-1");
  assert.deepEqual(a.data.map(x=>x.location_id),["A","B","C"]);
  assert.equal(a.meta.page_count,3);
  await c.vehicleClasses(200,"sup-1");
  assert.deepEqual(calls.map(c=>c[1]),[null,"abc_1","x+y/z==",null]);
  assert.ok(calls.every(c=>c[2]==="sup-1"));
});
test("repeated tokens and malformed page data fail closed",async()=>{
  let n=0;
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname==="/v1/capabilities")return success(caps.data);
    n++;return success([{location_id:"A"}],{next_page:"repeat"});
  };
  await assert.rejects(()=>client().locations(),/CARAVEL_PAGINATION_BAD_OR_REPEATED_TOKEN/);
  assert.equal(n,2);
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname==="/v1/capabilities")return success(caps.data);
    return success({not:"an array"});
  };
  await assert.rejects(()=>client().locations(),/CARAVEL_PAGINATION_INVALID_ROWS/);
});

test("booking recovery follows all pages with same updated_since and supplier",async()=>{
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url);
    if(u.pathname==="/v1/capabilities")return success(caps.data);
    assert.equal(u.pathname,"/v1/bookings");
    calls.push({token:u.searchParams.get("page_token"),since:u.searchParams.get("updated_since"),supplier:opts.headers["X-Supplier-Id"]});
    if(!u.searchParams.has("page_token"))return success([{booking_id:"b1"}],{next_page:"book+2=="});
    return success([{booking_id:"b2"}],{next_page:null});
  };
  const result=await client().listAllBookings({updated_since:"2026-11-16T00:00:00Z"},"sup-1");
  assert.deepEqual(result.data.map(x=>x.booking_id),["b1","b2"]);
  assert.equal(result.meta.page_count,2);
  assert.deepEqual(calls.map(x=>x.token),[null,"book+2=="]);
  assert.ok(calls.every(x=>x.supplier==="sup-1" && x.since==="2026-11-16T00:00:00Z"));
});

test("booking recovery refuses looping cursor and fails closed",async()=>{
  let attempts=0;
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname==="/v1/capabilities")return success(caps.data);
    attempts++;
    return success([{booking_id:"b1"}],{next_page:"repeated"});
  };
  await assert.rejects(()=>client().listAllBookings({},"sup-1"),/CARAVEL_PAGINATION_BAD_OR_REPEATED_TOKEN/);
  assert.equal(attempts,2);
});
