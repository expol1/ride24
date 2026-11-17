import test from "node:test";
import assert from "node:assert/strict";
import {CaravelSandboxClient,CaravelError,selectCurrentCaravelTerms} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";
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
 assert.equal(calls[1],"https://sandbox-api.caravelway.com/v1/reference/vehicles?limit=200");
});
const termsMeta=(id="doc-en-v4",patch={})=>({document_id:id,language:"en",version:4,
 title:"Caravel Rental Terms",format:"clauses/v1",content_hash:"a".repeat(64),
 published_at:"2026-11-17T10:00:00Z",withdrawn_at:null,...patch});
test("supplier-scoped terms list is metadata only and detail has immutable clauses body",async()=>{
 const calls=[];
 mock((url,options)=>{
  calls.push({url,method:options.method,supplier:options.headers["X-Supplier-Id"]});
  if(url.endsWith("/v1/capabilities"))return {data:{environment:"sandbox"}};
  if(url.endsWith("/v1/reference/terms"))return {data:[
    termsMeta("old-en-v3",{version:3,withdrawn_at:"2026-11-17T09:00:00Z"}),
    termsMeta()]};
  return {data:{...termsMeta(),body:{clauses:[{number:"6.1",text:"A 100 EUR fee applies after damage"}]}}};
 });
 const client=new CaravelSandboxClient("fixture");
 const list=await client.referenceTerms("acct_eur");
 const active=selectCurrentCaravelTerms(list.data,"en");
 assert.equal(active.document_id,"doc-en-v4");
 assert.equal(active.version,4);
 assert.equal("body" in active,false,"list is metadata only, not terms text");
 const doc=await client.referenceTermsDocument(active.document_id,"acct_eur");
 assert.equal(doc.data.document_id,active.document_id);
 assert.equal(doc.data.body.clauses[0].number,"6.1");
 assert.deepEqual(calls.slice(1),[
  {url:"https://sandbox-api.caravelway.com/v1/reference/terms",method:"GET",supplier:"acct_eur"},
  {url:"https://sandbox-api.caravelway.com/v1/reference/terms/doc-en-v4",method:"GET",supplier:"acct_eur"}
 ]);
});
test("Caravel refuses no active terms, ambiguous active terms and bad document IDs",async()=>{
 assert.throws(()=>selectCurrentCaravelTerms([],"en"),/CURRENT_AMBIGUOUS_OR_MISSING/);
 assert.throws(()=>selectCurrentCaravelTerms([termsMeta(),termsMeta("doc-en-v5",{version:5})],"en"),/CURRENT_AMBIGUOUS_OR_MISSING/);
 for(const invalid of [null,{},[],"  "]){
  mock((url)=>url.endsWith("/v1/capabilities")?{data:{environment:"sandbox"}}:{data:invalid});
  await assert.rejects(()=>new CaravelSandboxClient("fixture").referenceTerms("acct_eur"),/CARAVEL_TERMS_LIST_INVALID/);
 }
 mock((url)=>url.endsWith("/v1/capabilities")?{data:{environment:"sandbox"}}:{data:{...termsMeta(),body:null}});
 await assert.rejects(()=>new CaravelSandboxClient("fixture").referenceTermsDocument("doc-en-v4","acct_eur"),/CARAVEL_TERMS_DOCUMENT_INVALID/);
 for(const id of ["../abc","abc/def","x?y",""]){
  await assert.rejects(()=>new CaravelSandboxClient("fixture").referenceTermsDocument(id),/CARAVEL_TERMS_ID_INVALID/);
 }
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

test("CaravelError exposes HTTP status and request identifiers under Node 22 strip-types",()=>{
 const error=new CaravelError(429,"RATE_LIMITED","req-test-1");
 assert.equal(error.status,429);
 assert.equal(error.code,"RATE_LIMITED");
 assert.equal(error.requestId,"req-test-1");
 assert.match(error.message,/RATE_LIMITED.*429/);
});

test("rejects null capabilities safely",async()=>{
 mock(()=>({data:null}));
 await assert.rejects(()=>new CaravelSandboxClient("fixture").suppliers(),/SANDBOX_ENVIRONMENT_REQUIRED/);
});
test("rejects premium without valid currency",()=>{
 const check=CaravelSandboxClient.isPremiumZeroRisk;
 for(const currency of ["","EU","eur"]){
  assert.equal(check({plan:"Premium",protection:{excess:{amount:0,currency},deposit:{amount:0,currency}}}),false);
 }
});
test("rejects missing sandbox booking reference safely",async()=>{
 await assert.rejects(()=>new CaravelSandboxClient("fixture").bookSandbox({quote_id:"q",drivers:[],customer:{}},"key"),/SANDBOX_BOOKING_GUARD/);
});
