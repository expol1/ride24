import test from "node:test";
import assert from "node:assert/strict";
import {prepareCaravelPrepayment} from "../supabase/functions/_shared/caravel-prepayment-gate.ts";

const NOW=1900000000000;
const QID="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const DOC="caravel-en-v4";
const HASH="a".repeat(64);
const zeros=()=>({amount:0,currency:"EUR"});
const metadata=()=>({
 document_id:DOC,language:"en",version:4,title:"Caravel Terms",
 format:"clauses/v1",content_hash:HASH,published_at:"2026-11-17T10:00:00Z",
 withdrawn_at:null,
});
function fixture(limited=false){
 const excludes=limited?["glass","tyres_and_wheels","undercarriage"]:[];
 const protection={
  tier:"premium",product_type:"waiver",deposit:zeros(),excess:zeros(),
  theft_excess:zeros(),
  covers:limited?["bodywork","theft","fire"]:
    ["bodywork","theft","fire","glass","tyres_and_wheels","undercarriage"],
  excludes,
 };
 const review=limited?{
  termsDocumentId:DOC,termsContentHash:HASH,
  documentedExcludedCodes:excludes,damageAdministrationFeeMinor:10000,
  currency:"EUR",approvedByRide24:true,canonicalHashVerified:true,
 }:undefined;
 const quote={
  provider:"caravel",quote_id:QID,supplier_id:"acct_eur",
  plan:"premium",expires_at:new Date(NOW+600000).toISOString(),
  terms_document_id:DOC,terms_content_hash:HASH,terms_language:"en",
  payment_model:"pay_on_arrival",currency:"EUR",
  amounts:{total:150},amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},
  protection,
  ...(limited?{
   coverage_review_terms_document_id:DOC,coverage_exclusions:excludes,
   damage_administration_fee_minor:10000,
  }:{}),
 };
 return {
  serverPartnerApiEnabled:true,serverQuoteUnused:true,
  serverCurrentTermsBodyRendered:true,serverCanonicalHashVerified:true,
  serverExpectedPartnerAmountMinor:15000,
  serverQuote:quote,serverReviewedTerms:{
   supplierId:"acct_eur",language:"en",documentId:DOC,version:4,
   contentHash:HASH,publishedAt:"2026-11-17T10:00:00Z",
  },
  serverCurrentTermsMetadataList:[metadata()],serverProtection:protection,
  serverQuoteDeposit:{amount:zeros()},
  serverLicencePolicy:{licence_rules:{min_years_held:1,
   international_permit_required_for:["non_eu_eea"]}},
  serverLicenceEvidence:{firstIssuedOn:"2025-02-01",pickupOn:"2027-01-10",
   issuedInEuEea:true,hasInternationalDrivingPermit:false},
  serverCoverageReview:review,
  nowEpochMs:NOW,
  customerAcceptedTerms:true,displayedTermsDocumentId:DOC,
  customerAcceptedCoverage:limited?true:undefined,
  displayedExcludedCodes:limited?excludes:undefined,
  displayedDamageFeeMinor:limited?10000:undefined,
 };
}
test("fully covered Premium may pass isolated pre-Stripe gate without separate exclusion consent",()=>{
 const f=fixture();
 const r=prepareCaravelPrepayment(f);
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.quoteId,QID);
 assert.equal(r.amountMinor,15000);
 assert.equal(r.bookingSnapshot.caravel_terms_document_id,DOC);
 assert.equal(r.bookingSnapshot.caravel_coverage_quote_id,undefined);
});
test("limited Premium includes exact quote and supplier in pre-Stripe consent snapshot",()=>{
 const f=fixture(true),r=prepareCaravelPrepayment(f);
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.bookingSnapshot.caravel_coverage_quote_id,QID);
 assert.equal(r.bookingSnapshot.caravel_coverage_supplier_id,"acct_eur");
 assert.equal(r.bookingSnapshot.caravel_coverage_damage_admin_fee_minor,10000);
 assert.deepEqual(r.bookingSnapshot.caravel_coverage_excluded_codes,
  ["glass","tyres_and_wheels","undercarriage"]);
});
test("missing authorization, user consent, current document or protected quote blocks before Stripe",()=>{
 const f=fixture(true);
 for(const changes of [
  {serverPartnerApiEnabled:false},
  {serverQuoteUnused:false},
  {serverCurrentTermsBodyRendered:false},
  {serverCanonicalHashVerified:false},
  {customerAcceptedTerms:false},
  {customerAcceptedCoverage:false},
  {displayedTermsDocumentId:"caravel-en-v3"},
  {displayedExcludedCodes:["glass"]},
  {displayedDamageFeeMinor:0},
  {serverCoverageReview:undefined},
  {serverExpectedPartnerAmountMinor:14000},
  {serverProtection:{...f.serverProtection,excludes:[]}},
  {serverLicenceEvidence:{...f.serverLicenceEvidence,issuedInEuEea:false}},
  {nowEpochMs:NOW+700000},
  {serverQuote:{...f.serverQuote,quote_id:"bad"}},
  {serverQuote:{...f.serverQuote,
    amounts_minor:{total:15000,pay_now:5000,pay_at_pickup:10000}}},
  {serverQuote:{...f.serverQuote,terms_document_id:"caravel-en-v3"}},
  {serverQuote:{...f.serverQuote,protection:{...f.serverProtection,excludes:[]}}},
 ]){
  const r=prepareCaravelPrepayment({...f,...changes});
  assert.equal(r.ok,false,JSON.stringify(changes));
  assert.equal(r.action,"block_before_stripe");
  assert.ok(r.errors.length>0);
 }
});
test("same supplier quote with changed current terms must be re-accepted",()=>{
 const f=fixture();
 const changed={...metadata(),document_id:"caravel-en-v5",version:5,
   content_hash:"b".repeat(64),published_at:"2026-11-18T10:00:00Z"};
 const r=prepareCaravelPrepayment({...f,serverCurrentTermsMetadataList:[changed]});
 assert.equal(r.ok,false);
 assert.ok(r.errors.includes("CARAVEL_TERMS_NEW_VERSION_REQUIRES_REACCEPTANCE"));
});
