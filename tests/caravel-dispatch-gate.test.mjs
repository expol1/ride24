import test from "node:test";
import assert from "node:assert/strict";
import {prepareVerifiedCaravelDispatch} from "../supabase/functions/_shared/caravel-dispatch-gate.ts";

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
      excludes:["mirrors"],
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
