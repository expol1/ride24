import test from "node:test";
import assert from "node:assert/strict";
import {CaravelClient,CaravelSandboxClient,CaravelError,selectCurrentCaravelTerms} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";
import {compareCaravelTermsVersion,fetchCaravelCurrentTermsForReview,bindReviewedCaravelTermsToQuote} from "../supabase/functions/_shared/caravel-terms-version.ts";
import {validateCaravelTermsBeforeStripe,validateCaravelTermsBeforeDispatch} from "../supabase/functions/_shared/caravel-terms-lifecycle.ts";
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
test("sandbox certification HMAC submission is explicit, scoped and never rotates secrets",async()=>{
 const calls=[];
 mock((url,options)=>{
  calls.push({url,options});
  return url.endsWith("/v1/capabilities")
    ? {data:{environment:"sandbox"}}
    : {recorded:true,check:"hmac-self-test"};
 });
 const client=new CaravelSandboxClient("fixture");
 const payload={signature_hex:"a".repeat(64),tampered_rejected:true};
 const result=await client.submitSandboxHmacSelfTest(payload);
 assert.equal(result.httpStatus,200);
 assert.equal(result.recordedResponse.recorded,true);
 assert.equal(calls.length,2);
 assert.equal(calls[1].url,"https://sandbox-api.caravelway.com/_certification/hmac-self-test");
 assert.equal(calls[1].options.method,"POST");
 assert.equal(calls[1].options.headers["X-API-Key"],"fixture");
 assert.deepEqual(JSON.parse(calls[1].options.body),payload);
 assert.ok(!calls[1].url.includes("secret/rotate"));
 await assert.rejects(()=>client.submitSandboxHmacSelfTest({...payload,tampered_rejected:false}),/CARAVEL_HMAC_SELF_TEST_INVALID/);
 const prod=new CaravelClient({apiKey:"fixture",environment:"production",allowProduction:true});
 await assert.rejects(()=>prod.submitSandboxHmacSelfTest(payload),/SANDBOX_CERTIFICATION_ONLY/);
});
test("immutable Caravel terms per supplier sync require review of any new document_id",()=>{
 const initial=compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta()]});
 assert.equal(initial.action,"initial_review_required");
 assert.equal(initial.snapshot.documentId,"doc-en-v4");
 const same=compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta()],previousReviewed:initial.snapshot});
 assert.equal(same.action,"unchanged");
 const newer=compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta("doc-en-v5",{version:5,content_hash:"b".repeat(64),
      published_at:"2026-11-18T10:00:00Z"})],previousReviewed:initial.snapshot});
 assert.equal(newer.action,"new_version_requires_review");
 assert.equal(newer.replacedDocumentId,"doc-en-v4");
 assert.equal(newer.snapshot.documentId,"doc-en-v5");
 assert.throws(()=>compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta("doc-en-v4",{content_hash:"b".repeat(64)})],
   previousReviewed:initial.snapshot}),/CARAVEL_TERMS_IMMUTABILITY_VIOLATION/);
 assert.throws(()=>compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta("doc-en-v3",{version:3})],previousReviewed:initial.snapshot}),
   /CARAVEL_TERMS_VERSION_ROLLBACK/);
 assert.throws(()=>compareCaravelTermsVersion({supplierId:"acct_gbp",language:"en",
   currentMetadataList:[termsMeta()],previousReviewed:initial.snapshot}),
   /CARAVEL_TERMS_PREVIOUS_SNAPSHOT_INVALID/);
 assert.throws(()=>compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta(),termsMeta("second")] }),/CARAVEL_TERMS_CURRENT_AMBIGUOUS_OR_MISSING/);
});
test("current Caravel clauses document is fetched per supplier and compared with list metadata",async()=>{
  const calls=[];
  const expected=termsMeta("current-en-v4");
  const client={
    async referenceTerms(supplierId){calls.push(["list",supplierId]);return {data:[expected]};},
    async referenceTermsDocument(documentId,supplierId){
      calls.push(["detail",documentId,supplierId]);
      return {data:{...expected,body:{clauses:[{number:"1",text:"English terms"}]}}};
    },
  };
  const r=await fetchCaravelCurrentTermsForReview(client,"acct_eur","en");
  assert.equal(r.comparison.action,"initial_review_required");
  assert.equal(r.comparison.snapshot.documentId,"current-en-v4");
  assert.equal(r.document.body.clauses[0].text,"English terms");
  assert.equal(r.canonicalHashIndependentlyVerified,false);
  assert.deepEqual(calls,[["list","acct_eur"],["detail","current-en-v4","acct_eur"]]);
  const repeat=await fetchCaravelCurrentTermsForReview(client,"acct_eur","en",r.comparison.snapshot);
  assert.equal(repeat.comparison.action,"unchanged");
});
test("provider changed terms between list/detail: fail closed, never show mismatched text",async()=>{
 const meta=termsMeta("en-v4");
 const mismatch=[
  {...meta,document_id:"en-v3",body:{clauses:[{number:"1",text:"OLD"}]}},
  {...meta,version:3,body:{clauses:[{number:"1",text:"STALE"}]}},
  {...meta,content_hash:"b".repeat(64),body:{clauses:[{number:"1",text:"ALTERED"}]}},
  {...meta,withdrawn_at:"2026-11-18T07:00:00Z",body:{clauses:[{number:"1",text:"WITHDRAWN"}]}},
 ];
 for(const bad of mismatch){
   const client={
     async referenceTerms(){return {data:[meta]};},
     async referenceTermsDocument(){return {data:bad};},
   };
   await assert.rejects(()=>fetchCaravelCurrentTermsForReview(client,"acct_eur","en"),
     /CARAVEL_TERMS_LIST_DOCUMENT_MISMATCH/);
 }
 const noCurrent={
   async referenceTerms(){return {data:[termsMeta("en-v4",{withdrawn_at:"2026-11-18T07:00:00Z"})]};},
   async referenceTermsDocument(){throw Error("SHOULD_NOT_FETCH");},
 };
 await assert.rejects(()=>fetchCaravelCurrentTermsForReview(noCurrent,"acct_eur","en"),
   /CARAVEL_TERMS_CURRENT_AMBIGUOUS_OR_MISSING/);
});
test("Caravel quote can only bind human-reviewed current immutable terms after canonical digest approval",()=>{
 const meta=termsMeta("en-caravel-v4");
 const initial=compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",currentMetadataList:[meta]});
 const quote={provider:"caravel",supplier_id:"acct_eur",quote_id:"quote-1",amounts:{total:100}};
 const params={quoteData:quote,comparison:initial,canonicalHashVerified:true};
 assert.throws(()=>bindReviewedCaravelTermsToQuote(params),/CARAVEL_TERMS_REVIEW_REQUIRED/);
 const reviewed=compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",currentMetadataList:[meta],previousReviewed:initial.snapshot});
 assert.throws(()=>bindReviewedCaravelTermsToQuote({...params,comparison:reviewed,canonicalHashVerified:false}),
   /CARAVEL_TERMS_CANONICAL_HASH_NOT_VERIFIED/);
 const attached=bindReviewedCaravelTermsToQuote({...params,comparison:reviewed});
 assert.equal(attached.terms_document_id,"en-caravel-v4");
 assert.equal(attached.terms_content_hash,meta.content_hash);
 assert.equal(attached.terms_language,"en");
 assert.equal(quote.terms_document_id,undefined,"original quote object must stay immutable");
 assert.throws(()=>bindReviewedCaravelTermsToQuote({...params,comparison:reviewed,
   quoteData:{...quote,supplier_id:"acct_gbp"}}),/CARAVEL_QUOTE_TERMS_SCOPE_MISMATCH/);
 assert.throws(()=>bindReviewedCaravelTermsToQuote({...params,comparison:reviewed,
   quoteData:{...quote,terms_document_id:"old"}}),/CARAVEL_QUOTE_TERMS_ALREADY_BOUND/);
 const changed=compareCaravelTermsVersion({supplierId:"acct_eur",language:"en",
   currentMetadataList:[termsMeta("en-caravel-v5",{version:5,content_hash:"b".repeat(64),
     published_at:"2026-11-18T10:00:00Z"})],previousReviewed:initial.snapshot});
 assert.throws(()=>bindReviewedCaravelTermsToQuote({...params,comparison:changed}),
   /CARAVEL_TERMS_REVIEW_REQUIRED/);
});
test("production booking cannot cross suppliers or reuse a different booking idempotency UUID",async()=>{
 const bookingId="9ac84d3e-df5b-4b6d-8613-68b1f119fa2c";
 const quoteId="e5d0c483-a64e-4e82-a852-0a327c67eb79";
 const valid={quote_id:quoteId,external_ref:`ride24-${bookingId}`,
   drivers:[],customer:{},payment_model:"pay_on_arrival"};
 const calls=[];
 mock((url,options)=>{calls.push({url,options});
   return url.endsWith("/v1/capabilities")?{data:{environment:"production"}}:
     {data:{booking_id:"booking-accepted",status:"confirmed"}};
 });
 const disabled=new CaravelClient({apiKey:"fixture",environment:"production",allowProduction:true});
 await assert.rejects(()=>disabled.book(valid,bookingId,"acct_eur"),
   /PRODUCTION_BOOKING_WRITES_DISABLED/);
 const prod=new CaravelClient({apiKey:"fixture",environment:"production",allowProduction:true,
   allowProductionBookingWrites:true});
 await assert.rejects(()=>prod.book(valid,bookingId),/CARAVEL_PRODUCTION_BOOKING_IDENTITY_MISMATCH/);
 await assert.rejects(()=>prod.book(valid,"b72ec07b-cd43-4ec8-a4c7-68783a8e9c4a","acct_eur"),
   /CARAVEL_PRODUCTION_BOOKING_IDENTITY_MISMATCH/);
 await assert.rejects(()=>prod.book({...valid,external_ref:`ride24-sandbox-${bookingId}`},bookingId,"acct_eur"),
   /SANDBOX_BOOKING_GUARD/);
 assert.equal(calls.length,0,"blocked requests must not reach production");
 const result=await prod.book(valid,bookingId,"acct_eur");
 assert.equal(result.data.status,"confirmed");
 assert.equal(calls.length,2);
 assert.equal(calls[1].options.headers["Idempotency-Key"],bookingId);
 assert.equal(calls[1].options.headers["X-Supplier-Id"],"acct_eur");
});
test("Caravel terms accepted before Stripe remain identical at booking dispatch",()=>{
 const meta=termsMeta("doc-en-v4");
 const reviewed={supplierId:"acct_eur",language:"en",documentId:meta.document_id,
   version:4,contentHash:meta.content_hash,publishedAt:meta.published_at};
 const quote={provider:"caravel",supplier_id:"acct_eur",quote_id:"quote-verified",
   terms_document_id:meta.document_id,terms_content_hash:meta.content_hash,terms_language:"en"};
 const base={quote,reviewed,currentMetadataList:[meta],canonicalHashVerified:true};
 const accepted=validateCaravelTermsBeforeStripe({...base,displayedDocumentId:"doc-en-v4",customerAccepted:true});
 assert.deepEqual(accepted,{caravel_terms_document_id:"doc-en-v4",
   caravel_terms_content_hash:meta.content_hash,caravel_terms_language:"en"});
 assert.deepEqual(validateCaravelTermsBeforeDispatch({...base,persistedBookingSnapshot:accepted}),
   {ok:true,documentId:"doc-en-v4"});
 for(const candidate of [
   {...base,displayedDocumentId:"doc-en-v3",customerAccepted:true},
   {...base,displayedDocumentId:"doc-en-v4",customerAccepted:false},
 ]){
   assert.throws(()=>validateCaravelTermsBeforeStripe(candidate),/CARAVEL_TERMS_ACCEPTANCE_REQUIRED/);
 }
 assert.throws(()=>validateCaravelTermsBeforeStripe({...base,displayedDocumentId:"doc-en-v4",
   customerAccepted:true,canonicalHashVerified:false}),/CARAVEL_TERMS_CANONICAL_HASH_NOT_VERIFIED/);
 assert.throws(()=>validateCaravelTermsBeforeStripe({...base,displayedDocumentId:"doc-en-v4",
   customerAccepted:true,quote:{...quote,supplier_id:"acct_gbp"}}),/CARAVEL_TERMS_SUPPLIER_MISMATCH/);
});
test("Caravel changed terms after Stripe -> manual review, never a supplier booking",()=>{
 const meta=termsMeta("doc-en-v4");
 const approved={supplierId:"acct_eur",language:"en",documentId:meta.document_id,
   version:4,contentHash:meta.content_hash,publishedAt:meta.published_at};
 const quote={provider:"caravel",supplier_id:"acct_eur",quote_id:"quote-verified",
   terms_document_id:meta.document_id,terms_content_hash:meta.content_hash,terms_language:"en"};
 const snapshot={caravel_terms_document_id:"doc-en-v4",
   caravel_terms_content_hash:meta.content_hash,caravel_terms_language:"en"};
 const base={quote,reviewed:approved,currentMetadataList:[meta],
   canonicalHashVerified:true,persistedBookingSnapshot:snapshot};
 const missing=validateCaravelTermsBeforeDispatch({...base,persistedBookingSnapshot:null});
 assert.equal(missing.ok,false); assert.equal(missing.action,"hold_for_manual_review");
 assert.equal(missing.reason,"CARAVEL_TERMS_BOOKING_SNAPSHOT_MISSING");
 const changed=validateCaravelTermsBeforeDispatch({...base,
   currentMetadataList:[termsMeta("doc-en-v5",{version:5,content_hash:"b".repeat(64),
     published_at:"2026-11-18T10:00:00Z"})]});
 assert.equal(changed.ok,false); assert.equal(changed.reason,"CARAVEL_TERMS_NEW_VERSION_REQUIRES_REACCEPTANCE");
 const corrupted=validateCaravelTermsBeforeDispatch({...base,
   persistedBookingSnapshot:{...snapshot,caravel_terms_content_hash:"b".repeat(64)}});
 assert.equal(corrupted.ok,false); assert.equal(corrupted.reason,"CARAVEL_TERMS_BOOKING_SNAPSHOT_MISMATCH");
 const falseHash=validateCaravelTermsBeforeDispatch({...base,canonicalHashVerified:false});
 assert.equal(falseHash.ok,false); assert.equal(falseHash.action,"hold_for_manual_review");
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
