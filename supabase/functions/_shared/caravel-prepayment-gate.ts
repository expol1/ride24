/**
 * Caravel-only server-side pre-Stripe checkout gate. ISOLATED, NOT DEPLOYED.
 * The eventual call site MUST fetch every quote, reviewed terms, current terms,
 * supplier protection, supplier policy and enablement from trusted backends.
 * Only explicit customer acceptance and the displayed document/coverage
 * acknowledgements may originate from the authenticated browser.
 *
 * This pure function DOES NOT mark a quote used, save the booking, start Stripe
 * or contact Caravel. Persist the returned snapshots ATOMICALLY with the
 * booking insert BEFORE creating a Stripe session.
 */
import {verifyCaravelRide24PaymentContract}
  from "./caravel-payment-contract.ts";
import {validateCaravelTermsBeforeStripe,
  type CaravelBookingTermsSnapshot} from "./caravel-terms-lifecycle.ts";
import {captureCaravelCoverageConsentBeforeStripe,
  type CaravelCoverageConsentSnapshot} from "./caravel-coverage-consent.ts";
import {evaluateCaravelPremiumForRide24,
  type CaravelApprovedExclusionReview} from "./caravel-exclusion-policy.ts";
import {checkCaravelLicenceEligibility} from "./caravel-premium.ts";
import type {CaravelTermsSnapshot} from "./caravel-terms-version.ts";

type Rec=Record<string,unknown>;
const rec=(v:unknown):Rec|null =>
  v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Rec:null;
const isUuid=(v:unknown):v is string=>
  typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function canonicalJson(value:unknown):string{
  if(value===null||typeof value==="string"||typeof value==="number"||typeof value==="boolean")
    return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(canonicalJson).join(",")+"]";
  if(rec(value)){
    const v=value as Rec;
    return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonicalJson(v[k])).join(",")+"}";
  }
  throw new Error("CARAVEL_PREPAYMENT_PROTECTION_NOT_SERIALIZABLE");
}
export type CaravelPrepaymentSnapshots={
  caravel_terms_document_id:string;
  caravel_terms_language:string;
  caravel_terms_content_hash:string;
  caravel_coverage_supplier_id?:string;
  caravel_coverage_quote_id?:string;
  caravel_coverage_terms_document_id?:string;
  caravel_coverage_terms_content_hash?:string;
  caravel_coverage_excluded_codes?:string[];
  caravel_coverage_damage_admin_fee_minor?:number;
  caravel_coverage_accepted_at?:string;
};
export type CaravelPrepaymentDecision=
  |{ok:true;quoteId:string;supplierId:string;amountMinor:number;
     currency:"EUR"|"GBP";bookingSnapshot:CaravelPrepaymentSnapshots}
  |{ok:false;action:"block_before_stripe";errors:string[]};
export function prepareCaravelPrepayment(args:{
  /** Every field marked server-only must be derived by trusted backend code. */
  serverPartnerApiEnabled:boolean;
  serverQuoteUnused:boolean;
  serverCurrentTermsBodyRendered:boolean;
  serverCanonicalHashVerified:boolean;
  serverExpectedPartnerAmountMinor:number;
  serverQuote:unknown;
  serverReviewedTerms:CaravelTermsSnapshot;
  serverCurrentTermsMetadataList:unknown;
  serverProtection:unknown;
  serverQuoteDeposit:unknown;
  serverLicencePolicy:unknown;
  serverLicenceEvidence:unknown;
  /** Required when Premium has ANY exclusions. */
  serverCoverageReview?:CaravelApprovedExclusionReview;
  nowEpochMs:number;
  customerAcceptedTerms:boolean;
  displayedTermsDocumentId:unknown;
  customerAcceptedCoverage?:boolean;
  displayedExcludedCodes?:unknown;
  displayedDamageFeeMinor?:unknown;
}):CaravelPrepaymentDecision{
  const errors:string[]=[];
  const quote=rec(args?.serverQuote);
  if(args?.serverPartnerApiEnabled!==true)errors.push("CARAVEL_PARTNER_NOT_ENABLED");
  if(args?.serverQuoteUnused!==true)errors.push("CARAVEL_QUOTE_ALREADY_USED");
  if(args?.serverCurrentTermsBodyRendered!==true)errors.push("CARAVEL_TERMS_BODY_NOT_SHOWN");
  if(!Number.isSafeInteger(args?.nowEpochMs))errors.push("CARAVEL_SERVER_TIME_INVALID");
  if(!isUuid(quote?.quote_id)||typeof quote?.supplier_id!=="string"||!quote.supplier_id)
    errors.push("CARAVEL_QUOTE_SCOPE_INVALID");
  const expiry=typeof quote?.expires_at==="string"?Date.parse(quote.expires_at):NaN;
  if(!Number.isFinite(expiry)||!Number.isSafeInteger(args?.nowEpochMs)||
     expiry<=args.nowEpochMs)errors.push("CARAVEL_QUOTE_EXPIRED");

  const pay=verifyCaravelRide24PaymentContract(args?.serverQuote);
  if("errors" in pay)errors.push(...pay.errors);
  else if(args.serverExpectedPartnerAmountMinor!==pay.totalMinor)
    errors.push("CARAVEL_RIDE24_PARTNER_AMOUNT_CHANGED");
  if(!Number.isSafeInteger(args?.serverExpectedPartnerAmountMinor)||
     args.serverExpectedPartnerAmountMinor<=0)
    errors.push("CARAVEL_RIDE24_PARTNER_AMOUNT_INVALID");

  // Compare supplier-issued quoted protection against independently loaded
  // scoped protection. Unstated quote protection must not be guessed.
  try{
    if(!quote || !rec(quote.protection) || !rec(args.serverProtection) ||
       canonicalJson(quote.protection)!==canonicalJson(args.serverProtection))
      errors.push("CARAVEL_QUOTE_PROTECTION_CHANGED");
  }catch{errors.push("CARAVEL_QUOTE_PROTECTION_UNVERIFIED");}

  const premium=evaluateCaravelPremiumForRide24(
    quote?.plan,args?.serverProtection,args?.serverQuoteDeposit,
    args?.serverCoverageReview,
  );
  if("errors" in premium)errors.push(...premium.errors);
  const exclusions=rec(args?.serverProtection)?.excludes;
  if(!Array.isArray(exclusions)||!exclusions.every(x=>typeof x==="string"))
    errors.push("CARAVEL_EXCLUSIONS_NOT_VERIFIED");
  else if(exclusions.length>0 && !args?.serverCoverageReview)
    errors.push("CARAVEL_EXCLUSION_REVIEW_REQUIRED");
  else if(exclusions.length===0 && args?.serverCoverageReview)
    errors.push("CARAVEL_UNEXPECTED_EXCLUSION_REVIEW");

  const licence=checkCaravelLicenceEligibility(
    args?.serverLicencePolicy,args?.serverLicenceEvidence);
  if("errors" in licence)errors.push(...licence.errors);

  let terms:CaravelBookingTermsSnapshot|null=null;
  try{
    terms=validateCaravelTermsBeforeStripe({
      quote:args.serverQuote,
      reviewed:args.serverReviewedTerms,
      currentMetadataList:args.serverCurrentTermsMetadataList,
      canonicalHashVerified:args.serverCanonicalHashVerified,
      displayedDocumentId:args.displayedTermsDocumentId,
      customerAccepted:args.customerAcceptedTerms,
    });
  }catch(e){errors.push(e instanceof Error?e.message:"CARAVEL_TERMS_NOT_ACCEPTED");}

  let coverage:CaravelCoverageConsentSnapshot|null=null;
  if(args?.serverCoverageReview){
    try{
      coverage=captureCaravelCoverageConsentBeforeStripe({
        quote:args.serverQuote,
        reviewed:args.serverCoverageReview,
        customerAccepted:args.customerAcceptedCoverage===true,
        displayedDocumentId:args.displayedTermsDocumentId,
        displayedExcludedCodes:args.displayedExcludedCodes,
        displayedAdminFeeMinor:args.displayedDamageFeeMinor,
        acceptedAtServerIso:Number.isSafeInteger(args.nowEpochMs)
          ?new Date(args.nowEpochMs).toISOString():null,
      });
    }catch(e){errors.push(e instanceof Error?e.message:"CARAVEL_COVERAGE_NOT_ACCEPTED");}
  }
  if(terms && coverage && (
    coverage.caravel_coverage_terms_document_id!==terms.caravel_terms_document_id||
    coverage.caravel_coverage_terms_content_hash!==terms.caravel_terms_content_hash
  ))errors.push("CARAVEL_TERMS_COVERAGE_DISAGREE");
  if(errors.length||!terms||"errors" in pay||!isUuid(quote?.quote_id))
    return {ok:false,action:"block_before_stripe",
      errors:[...new Set(errors.length?errors:["CARAVEL_PREPAYMENT_INCOMPLETE"])]};
  return {ok:true,quoteId:quote.quote_id,
    supplierId:quote.supplier_id as string,
    amountMinor:pay.totalMinor,currency:pay.currency,
    bookingSnapshot:{...terms,...(coverage??{})},
  };
}
