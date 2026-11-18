/**
 * Ride24 Caravel Premium exclusion consent snapshot.
 * PURE, ISOLATED. Not yet connected to WWW/Android/create-booking-request.
 *
 * Buyer-supplied acknowledgement NEVER proves supplier protection.
 * Backend MUST construct the reviewed terms, canonical digest, priced quote
 * and accepted_at itself, and persist this snapshot atomically before Stripe.
 */
import type {CaravelApprovedExclusionReview} from "./caravel-exclusion-policy.ts";

type Rec=Record<string,unknown>;
const rec=(v:unknown):Rec|null =>
  v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Rec:null;
const validCodes=(v:unknown):v is string[] =>
  Array.isArray(v)&&v.every(x=>typeof x==="string"&&/^[a-z0-9_]{1,80}$/.test(x))&&
  new Set(v).size===v.length;
const sorted=(v:string[])=>[...v].sort();
const same=(a:unknown,b:unknown):boolean=>
  validCodes(a)&&validCodes(b)&&a.length===b.length&&
  sorted(a).every((x,i)=>x===sorted(b)[i]);
const validId=(v:unknown):v is string=>
  typeof v==="string"&&/^[A-Za-z0-9._~-]{1,200}$/.test(v)&&v!=="."&&v!=="..";
const validHash=(v:unknown):v is string=>
  typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const validSupplier=(v:unknown):v is string=>
  typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const validQuoteId=(v:unknown):v is string=>
  typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const validTime=(v:unknown):v is string=>
  typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)&&
  Number.isFinite(Date.parse(v))&&new Date(v).toISOString().startsWith(v.slice(0,19));

export type CaravelCoverageConsentSnapshot={
  caravel_coverage_supplier_id:string;
  caravel_coverage_quote_id:string;
  caravel_coverage_terms_document_id:string;
  caravel_coverage_terms_content_hash:string;
  caravel_coverage_excluded_codes:string[];
  caravel_coverage_damage_admin_fee_minor:number;
  caravel_coverage_accepted_at:string;
};
function verifyQuoteAndReview(quote:unknown,review:CaravelApprovedExclusionReview):void{
  const q=rec(quote);
  if(!q||q.provider!=="caravel"||!validId(review?.termsDocumentId)||
     !validHash(review?.termsContentHash)||
     review.approvedByRide24!==true||review.canonicalHashVerified!==true)
    throw new Error("CARAVEL_COVERAGE_REVIEW_UNVERIFIED");
  if(!validCodes(review.documentedExcludedCodes)||review.documentedExcludedCodes.length===0||
     !Number.isSafeInteger(review.damageAdministrationFeeMinor)||
     review.damageAdministrationFeeMinor<0||review.currency!=="EUR")
    throw new Error("CARAVEL_COVERAGE_REVIEW_INVALID");
  // Bind the acknowledgement to the exact scoped supplier quote.
  // Matching terms and exclusions alone are insufficient across bookings.
  if(!validSupplier(q.supplier_id)||!validQuoteId(q.quote_id))
    throw new Error("CARAVEL_COVERAGE_QUOTE_SCOPE_UNVERIFIED");
  const protection=rec(q.protection);
  if(q.terms_document_id!==review.termsDocumentId||
     q.terms_content_hash!==review.termsContentHash||
     q.coverage_review_terms_document_id!==review.termsDocumentId||
     !same(q.coverage_exclusions,review.documentedExcludedCodes)||
     !same(protection?.excludes,review.documentedExcludedCodes)||
     q.damage_administration_fee_minor!==review.damageAdministrationFeeMinor)
    throw new Error("CARAVEL_COVERAGE_QUOTE_CHANGED");
}
/** Use only AFTER rendering the authoritative terms body and charge list. */
export function captureCaravelCoverageConsentBeforeStripe(args:{
  quote:unknown;
  reviewed:CaravelApprovedExclusionReview;
  customerAccepted:boolean;
  displayedDocumentId:unknown;
  displayedExcludedCodes:unknown;
  displayedAdminFeeMinor:unknown;
  /** ISO timestamp generated on the SERVER upon confirmed acceptance. */
  acceptedAtServerIso:unknown;
}):CaravelCoverageConsentSnapshot {
  verifyQuoteAndReview(args?.quote,args?.reviewed);
  const r=args.reviewed;
  if(args.customerAccepted!==true ||
     args.displayedDocumentId!==r.termsDocumentId ||
     !same(args.displayedExcludedCodes,r.documentedExcludedCodes) ||
     args.displayedAdminFeeMinor!==r.damageAdministrationFeeMinor)
    throw new Error("CARAVEL_COVERAGE_DISCLOSURE_NOT_ACCEPTED");
  if(!validTime(args.acceptedAtServerIso))
    throw new Error("CARAVEL_COVERAGE_SERVER_ACCEPTED_AT_REQUIRED");
  const quote=args.quote as Rec;
  return {
    caravel_coverage_supplier_id:quote.supplier_id as string,
    caravel_coverage_quote_id:quote.quote_id as string,
    caravel_coverage_terms_document_id:r.termsDocumentId,
    caravel_coverage_terms_content_hash:r.termsContentHash,
    caravel_coverage_excluded_codes:[...r.documentedExcludedCodes],
    caravel_coverage_damage_admin_fee_minor:r.damageAdministrationFeeMinor,
    caravel_coverage_accepted_at:args.acceptedAtServerIso,
  };
}
/** A post-payment check never silently replaces a previously accepted policy. */
export function validateCaravelCoverageConsentBeforeDispatch(args:{
  quote:unknown;
  reviewed:CaravelApprovedExclusionReview;
  persistedConsent:unknown;
}):{ok:true}|{ok:false;action:"hold_for_manual_review";reason:string}{
  try{
    verifyQuoteAndReview(args?.quote,args?.reviewed);
    const saved=rec(args?.persistedConsent);
    if(!saved||!validTime(saved.caravel_coverage_accepted_at))
      throw new Error("CARAVEL_COVERAGE_PERSISTED_CONSENT_MISSING");
    const quote=args.quote as Rec;
    if(saved.caravel_coverage_supplier_id!==quote.supplier_id||
       saved.caravel_coverage_quote_id!==quote.quote_id||
       saved.caravel_coverage_terms_document_id!==args.reviewed.termsDocumentId||
       saved.caravel_coverage_terms_content_hash!==args.reviewed.termsContentHash||
       !same(saved.caravel_coverage_excluded_codes,args.reviewed.documentedExcludedCodes)||
       saved.caravel_coverage_damage_admin_fee_minor!==args.reviewed.damageAdministrationFeeMinor)
      throw new Error("CARAVEL_COVERAGE_PERSISTED_CONSENT_MISMATCH");
    return {ok:true};
  }catch(e){
    return {ok:false,action:"hold_for_manual_review",
      reason:e instanceof Error?e.message:"CARAVEL_COVERAGE_CHECK_UNKNOWN"};
  }
}
