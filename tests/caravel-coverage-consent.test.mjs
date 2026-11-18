import test from "node:test";
import assert from "node:assert/strict";
import {
 captureCaravelCoverageConsentBeforeStripe,
 validateCaravelCoverageConsentBeforeDispatch,
} from "../supabase/functions/_shared/caravel-coverage-consent.ts";

const review={
 termsDocumentId:"caravel-en-v4",
 termsContentHash:"a".repeat(64),
 documentedExcludedCodes:["glass","tyres_and_wheels","undercarriage"],
 damageAdministrationFeeMinor:10000,currency:"EUR",
 approvedByRide24:true,canonicalHashVerified:true,
};
const quote={
 provider:"caravel",terms_document_id:review.termsDocumentId,
 terms_content_hash:review.termsContentHash,
 coverage_review_terms_document_id:review.termsDocumentId,
 coverage_exclusions:[...review.documentedExcludedCodes],
 damage_administration_fee_minor:10000,
 protection:{excludes:[...review.documentedExcludedCodes]},
};
const acceptedAt="2026-11-18T10:12:34.000Z";
const input=()=>({
 quote,reviewed:review,customerAccepted:true,
 displayedDocumentId:review.termsDocumentId,
 displayedExcludedCodes:[...review.documentedExcludedCodes],
 displayedAdminFeeMinor:10000,acceptedAtServerIso:acceptedAt,
});

test("Caravel signed-off exclusion/fee consent persists exactly before Stripe",()=>{
 const snapshot=captureCaravelCoverageConsentBeforeStripe(input());
 assert.deepEqual(snapshot,{
  caravel_coverage_terms_document_id:review.termsDocumentId,
  caravel_coverage_terms_content_hash:review.termsContentHash,
  caravel_coverage_excluded_codes:review.documentedExcludedCodes,
  caravel_coverage_damage_admin_fee_minor:10000,
  caravel_coverage_accepted_at:acceptedAt,
 });
 assert.notEqual(snapshot.caravel_coverage_excluded_codes,review.documentedExcludedCodes);
 assert.deepEqual(validateCaravelCoverageConsentBeforeDispatch({
  quote,reviewed:review,persistedConsent:snapshot,
 }),{ok:true});
});
test("no approval or inaccurate disclosure is not consent",()=>{
 const changes=[
  {customerAccepted:false},
  {displayedDocumentId:"caravel-en-v3"},
  {displayedExcludedCodes:["glass"]},
  {displayedAdminFeeMinor:0},
 ];
 for(const patch of changes)assert.throws(
  ()=>captureCaravelCoverageConsentBeforeStripe({...input(),...patch}),
  /CARAVEL_COVERAGE_DISCLOSURE_NOT_ACCEPTED/);
});
test("canonical hash, revised policy, missing fee and false server timestamp fail closed",()=>{
 const cases=[
  {reviewed:{...review,canonicalHashVerified:false}},
  {reviewed:{...review,approvedByRide24:false}},
 ];
 for(const patch of cases)assert.throws(
  ()=>captureCaravelCoverageConsentBeforeStripe({...input(),...patch}),
  /CARAVEL_COVERAGE_REVIEW_UNVERIFIED/);
 assert.throws(()=>captureCaravelCoverageConsentBeforeStripe({
  ...input(),quote:{...quote,coverage_exclusions:["glass","battery"]},
 }),/CARAVEL_COVERAGE_QUOTE_CHANGED/);
 assert.throws(()=>captureCaravelCoverageConsentBeforeStripe({
  ...input(),quote:{...quote,damage_administration_fee_minor:undefined},
 }),/CARAVEL_COVERAGE_QUOTE_CHANGED/);
 assert.throws(()=>captureCaravelCoverageConsentBeforeStripe({
  ...input(),acceptedAtServerIso:"yesterday",
 }),/CARAVEL_COVERAGE_SERVER_ACCEPTED_AT_REQUIRED/);
});
test("post-payment booking cannot silently replace accepted exclusions, fee or terms",()=>{
 const s=captureCaravelCoverageConsentBeforeStripe(input());
 const changes=[
   {caravel_coverage_terms_document_id:"caravel-en-v5"},
   {caravel_coverage_terms_content_hash:"b".repeat(64)},
   {caravel_coverage_excluded_codes:["glass","undercarriage"]},
   {caravel_coverage_damage_admin_fee_minor:0},
 ];
 for(const patch of changes){
  const result=validateCaravelCoverageConsentBeforeDispatch({
   quote,reviewed:review,persistedConsent:{...s,...patch},
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"CARAVEL_COVERAGE_PERSISTED_CONSENT_MISMATCH");
 }
 for(const bad of [null,undefined,{...s,caravel_coverage_accepted_at:null}]){
  const result=validateCaravelCoverageConsentBeforeDispatch({
   quote,reviewed:review,persistedConsent:bad,
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"CARAVEL_COVERAGE_PERSISTED_CONSENT_MISSING");
 }
 const revisedQuote=validateCaravelCoverageConsentBeforeDispatch({
   quote:{...quote,damage_administration_fee_minor:20000},
   reviewed:review,persistedConsent:s,
 });
 assert.equal(revisedQuote.ok,false);
 assert.equal(revisedQuote.reason,"CARAVEL_COVERAGE_QUOTE_CHANGED");
});
