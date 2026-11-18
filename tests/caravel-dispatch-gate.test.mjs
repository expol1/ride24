import test from "node:test";
import assert from "node:assert/strict";
import {prepareVerifiedCaravelDispatch} from "../supabase/functions/_shared/caravel-dispatch-gate.ts";
import {captureCaravelCoverageConsentBeforeStripe} from "../supabase/functions/_shared/caravel-coverage-consent.ts";
import {submitVerifiedCaravelBooking} from "../supabase/functions/_shared/caravel-provider-bridge.ts";

const NOW=1900000000000;
const BOOKING_ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const QUOTE_ID="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const HASH="a".repeat(64);
const metadata=(patch={})=>({
  document_id:"caravel-en-v4",language:"en",version:4,
  title:"Caravel Rental Terms",format:"clauses/v1",content_hash:HASH,
  published_at:"2026-11-17T10:00:00Z",withdrawn_at:null,...patch,
});
function fixture(){
  const meta=metadata();
  const bookingInput={
    idempotency_key:`ride24:${BOOKING_ID}`,ride24_booking_id:BOOKING_ID,
    vehicle_group_id:"opaque-veh",main_driver:{name:"Jan Testowy",age:30},
    additional_driver:null,client_email:"sandbox@example.test",
    client_phone:"+48 000 000 000",
    currency:"EUR",partner_discount_percent:0,partner_amount:150,
    quote_reference:QUOTE_ID,
    provider_quote_data:{
      provider:"caravel",quote_id:QUOTE_ID,supplier_id:"acct_eur",
      vehicle_id:"opaque-veh",protection_id:"prot-premium",
      plan:"premium",currency:"EUR",amounts:{total:150},
      amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},
      payment_model:"pay_on_arrival",
      drivers:[{age:30,role:"main"}],
      expires_at:new Date(NOW+600000).toISOString(),
      terms_document_id:meta.document_id,
      terms_content_hash:meta.content_hash,
      terms_language:"en",
    },
  };
  const zero=()=>({amount:0,currency:"EUR"});
  const productionGate={
    certificationPassed:true,
    termsVerifiedAndShownBeforePayment:true,
    currentTermsDocumentId:meta.document_id,
    termsDocumentIdShown:meta.document_id,
    currentTermsContentHash:meta.content_hash,
    termsContentHashShown:meta.content_hash,
    currentTermsLanguage:"en",
    termsLanguageShown:"en",
    termsCanonicalHashVerified:true,
    protection:{
      tier:"premium",product_type:"waiver",
      deposit:zero(),excess:zero(),theft_excess:zero(),
      covers:["theft","fire","glass","tyres_and_wheels","undercarriage"],
      excludes:[],
    },
    quoteDeposit:{amount:zero()},
    licencePolicy:{licence_rules:{min_years_held:1,international_permit_required_for:["non_eu_eea"]}},
    licenceEvidence:{firstIssuedOn:"2025-02-01",pickupOn:"2027-01-10",
      issuedInEuEea:true,hasInternationalDrivingPermit:false},
  };
  const reviewedTerms={supplierId:"acct_eur",language:"en",documentId:meta.document_id,
    version:meta.version,contentHash:meta.content_hash,publishedAt:meta.published_at};
  const persistedBookingTerms={
    caravel_terms_document_id:meta.document_id,
    caravel_terms_language:"en",
    caravel_terms_content_hash:meta.content_hash,
  };
  return {bookingInput,nowEpochMs:NOW,productionGate,reviewedTerms,
    currentTermsMetadataList:[meta],persistedBookingTerms};
}
test("verified Caravel dispatch plan contains exact supplier, Ride24 UUID and immutable terms",()=>{
  const result=prepareVerifiedCaravelDispatch(fixture());
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.plan,{
    supplierId:"acct_eur",
    idempotencyKey:BOOKING_ID,
    termsDocumentId:"caravel-en-v4",
    request:{
      quote_id:QUOTE_ID,
      external_ref:`ride24-${BOOKING_ID}`,
      drivers:[{first_name:"Jan",last_name:"Testowy",age:30,role:"main"}],
      customer:{
        first_name:"Jan",last_name:"Testowy",
        email:"sandbox@example.test",phone:"+48 000 000 000",
      },
      payment_model:"pay_on_arrival",
    },
  });
});
test("stale terms after Stripe stop dispatch and produce manual review, without supplier call",()=>{
  const args=fixture();
  args.currentTermsMetadataList=[metadata({
    document_id:"caravel-en-v5",version:5,content_hash:"b".repeat(64),
    published_at:"2026-11-18T10:00:00Z",
  })];
  const result=prepareVerifiedCaravelDispatch(args);
  assert.equal(result.ok,false);
  assert.equal(result.action,"hold_for_manual_review");
  assert.ok(result.reasons.includes("CARAVEL_TERMS_NEW_VERSION_REQUIRES_REACCEPTANCE"));
});
test("missing persisted acceptance or changed quote terms block even when mock certification passes",()=>{
  const f=fixture();
  for(const patch of [
    {persistedBookingTerms:null},
    {persistedBookingTerms:{...f.persistedBookingTerms,caravel_terms_language:"de"}},
    {bookingInput:{...f.bookingInput,provider_quote_data:{
      ...f.bookingInput.provider_quote_data,terms_content_hash:"b".repeat(64),
    }}},
    {bookingInput:{...f.bookingInput,provider_quote_data:{
      ...f.bookingInput.provider_quote_data,supplier_id:"acct_gbp",
    }}},
    {bookingInput:{...f.bookingInput,provider_quote_data:{
      ...f.bookingInput.provider_quote_data,amounts_minor:{total:15000,pay_now:5000,pay_at_pickup:10000},
    }}},
  ]){
    const result=prepareVerifiedCaravelDispatch({...f,...patch});
    assert.equal(result.ok,false,JSON.stringify(patch));
    assert.equal(result.action,"hold_for_manual_review");
  }
});
test("expired quote, failed insurance or licence checks prevent creation of a dispatch plan",()=>{
  const f=fixture();
  const cases=[
    {...f,nowEpochMs:NOW+700000},
    {...f,productionGate:{...f.productionGate,certificationPassed:false}},
    {...f,productionGate:{...f.productionGate,
      protection:{...f.productionGate.protection,
        covers:["bodywork","theft","fire"],
        excludes:["glass","tyres_and_wheels","undercarriage"]}}},
    {...f,productionGate:{...f.productionGate,
      licenceEvidence:{...f.productionGate.licenceEvidence,issuedInEuEea:false}}},
    {...f,productionGate:{...f.productionGate,termsCanonicalHashVerified:false}},
  ];
  for(const args of cases){
    const result=prepareVerifiedCaravelDispatch(args);
    assert.equal(result.ok,false,JSON.stringify(args.productionGate));
    assert.equal(result.action,"hold_for_manual_review");
    assert.ok(result.reasons.length>0);
  }
});

test("Caravel exclusions require actual persisted consent across Stripe, not a transient true flag",()=>{
 const f=fixture();
 const excludes=["glass","tyres_and_wheels","undercarriage","administration_fee"];
 const reviewed={
   termsDocumentId:f.reviewedTerms.documentId,
   termsContentHash:f.reviewedTerms.contentHash,
   documentedExcludedCodes:excludes,
   damageAdministrationFeeMinor:10000,currency:"EUR",
   approvedByRide24:true,canonicalHashVerified:true,
 };
 const gate={...f.productionGate,coverageReview:reviewed,
   coverageDisclosureAcceptedBeforePayment:true,
   coverageExcludedCodesShown:excludes,
   damageAdministrationFeeShownMinor:10000,
   protection:{...f.productionGate.protection,
     covers:["bodywork","theft","fire"],excludes},
 };
 const data={...f.bookingInput.provider_quote_data,
   coverage_review_terms_document_id:reviewed.termsDocumentId,
   coverage_exclusions:excludes,
   damage_administration_fee_minor:10000,
   protection:{product_type:"waiver",covers:gate.protection.covers,excludes},
 };
 const bookingInput={...f.bookingInput,provider_quote_data:data};
 const consent=captureCaravelCoverageConsentBeforeStripe({
   quote:data,reviewed,customerAccepted:true,
   displayedDocumentId:reviewed.termsDocumentId,
   displayedExcludedCodes:excludes,displayedAdminFeeMinor:10000,
   acceptedAtServerIso:"2026-11-18T10:12:34.000Z",
 });
 const args={...f,bookingInput,productionGate:gate};
 const notSaved=prepareVerifiedCaravelDispatch(args);
 assert.equal(notSaved.ok,false);
 assert.ok(notSaved.reasons.includes("CARAVEL_COVERAGE_PERSISTED_CONSENT_MISSING"));
 const good=prepareVerifiedCaravelDispatch({...args,persistedCoverageConsent:consent});
 assert.equal(good.ok,true,JSON.stringify(good));
 const changed=prepareVerifiedCaravelDispatch({...args,
   persistedCoverageConsent:{...consent,caravel_coverage_damage_admin_fee_minor:0}});
 assert.equal(changed.ok,false);
 assert.ok(changed.reasons.includes("CARAVEL_COVERAGE_PERSISTED_CONSENT_MISMATCH"));
 const replayedConsent=prepareVerifiedCaravelDispatch({...args,
   persistedCoverageConsent:{...consent,caravel_coverage_quote_id:
     "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"}});
 assert.equal(replayedConsent.ok,false);
 assert.ok(replayedConsent.reasons.includes("CARAVEL_COVERAGE_PERSISTED_CONSENT_MISMATCH"));
 const staleQuote=prepareVerifiedCaravelDispatch({...args,
   bookingInput:{...bookingInput,provider_quote_data:{...data,
     coverage_exclusions:["glass"]}},
   persistedCoverageConsent:consent});
 assert.equal(staleQuote.ok,false);
 assert.ok(staleQuote.reasons.includes("CARAVEL_COVERAGE_QUOTE_CHANGED"));
});

const SUPPLIER_BOOKING_ID="04a1f3e1-1fb4-4d28-af02-979604d5c622";
const acceptedBooking=()=>({
  booking_id:SUPPLIER_BOOKING_ID,revision:1,quote_id:QUOTE_ID,
  status:"confirmed",
  price:{totals:{grand_total:{amount:15000,currency:"EUR"}}},
  protection:{deposit:{amount:0,currency:"EUR"},excess:{amount:0,currency:"EUR"}},
  payment:{model:"pay_on_arrival",amount_prepaid:{amount:0,currency:"EUR"},amount_on_arrival:{amount:15000,currency:"EUR"}},
});
function deliveryFixture(client){
 return {...fixture(),client,enableSupplierWrite:true,paymentConfirmed:true,
   partnerApiEnabled:true,currentExternalReference:null};
}
test("isolated Caravel bridge requires explicit write, paid booking and active partner",async()=>{
 let calls=0;
 const client={environment:"production",async book(){calls++;return {data:acceptedBooking()};}};
 const base=deliveryFixture(client);
 for(const override of [
   {enableSupplierWrite:false},{enableSupplierWrite:undefined},
   {paymentConfirmed:false},{partnerApiEnabled:false},
   {currentExternalReference:SUPPLIER_BOOKING_ID},
   {client:{...client,environment:"sandbox"}},
   {persistedBookingTerms:null},
   {productionGate:{...base.productionGate,certificationPassed:false}},
 ]){
   const r=await submitVerifiedCaravelBooking({...base,...override});
   assert.equal(r.ok,false);
   assert.equal(r.action,"hold_for_manual_review");
 }
 assert.equal(calls,0,"preflight failures must never contact Caravel");
});
test("after all trusted checks, Caravel confirmed booking maps to Ride24 response",async()=>{
 const calls=[];
 const client={environment:"production",async book(payload,idem,supplier){
   calls.push({payload,idem,supplier});return {data:acceptedBooking()};
 }};
 const r=await submitVerifiedCaravelBooking(deliveryFixture(client));
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(calls.length,1);
 assert.equal(calls[0].idem,BOOKING_ID);
 assert.equal(calls[0].supplier,"acct_eur");
 assert.equal(calls[0].payload.external_ref,`ride24-${BOOKING_ID}`);
 assert.equal(r.result.booking_reference,SUPPLIER_BOOKING_ID);
 assert.equal(r.result.status,"confirmed");
 assert.equal("email" in r.result.provider_payload,false);
});
test("Caravel price change, missing payment model or pending booking trigger review",async()=>{
 const bad=[
  {...acceptedBooking(),price:{totals:{grand_total:{amount:15100,currency:"EUR"}}}},
  {...acceptedBooking(),payment:undefined},
  {...acceptedBooking(),status:"pending"},
  {...acceptedBooking(),quote_id:"different"},
  {...acceptedBooking(),protection:{deposit:{amount:100},excess:{amount:0}}},
  {...acceptedBooking(),protection:{deposit:{amount:0,currency:"GBP"},excess:{amount:0,currency:"EUR"}}},
  {...acceptedBooking(),payment:{model:"pay_on_arrival",amount_prepaid:{amount:0,currency:"GBP"},amount_on_arrival:{amount:15000,currency:"EUR"}}},
  {...acceptedBooking(),payment:{model:"pay_on_arrival",amount_prepaid:{amount:0,currency:"EUR"},amount_on_arrival:{amount:15000,currency:"GBP"}}},
  {...acceptedBooking(),payment:{model:"pay_on_arrival",amount_on_arrival:{amount:15000,currency:"EUR"}}},
 ];
 for(const data of bad){
   let calls=0;
   const client={environment:"production",async book(){calls++;return {data};}};
   const r=await submitVerifiedCaravelBooking(deliveryFixture(client));
   assert.equal(calls,1);
   assert.equal(r.ok,false);
   assert.equal(r.phase,"supplier_response");
   assert.equal(r.externalReference,SUPPLIER_BOOKING_ID);
   assert.ok(r.reasons.length>0);
 }
});
test("remote request failure is ambiguous: manual reconciliation, never blind retry",async()=>{
 let calls=0;
 const client={environment:"production",async book(){calls++;throw new Error("lost network response");}};
 const r=await submitVerifiedCaravelBooking(deliveryFixture(client));
 assert.equal(calls,1);
 assert.equal(r.ok,false);
 assert.equal(r.phase,"supplier_outcome_uncertain");
 assert.deepEqual(r.reasons,["CARAVEL_CREATE_RESULT_UNKNOWN_RECONCILE_BEFORE_RETRY"]);
});
