/**
 * Caravel-specific decision after Ride24 operator approval (18 Nov 2026).
 * Allow documented Premium exclusions, but NEVER silently assume that a
 * supplier changed them or advertise protection for excluded components.
 *
 * An exclusion review must be produced by a TRUSTED backend/admin from the
 * authoritative Caravel clauses/v1 terms, not supplied by the browser.
 * This code does not parse or independently verify Caravel canonical SHA-256.
 */
import {evaluateCaravelPremium, type CaravelPremiumEvaluation}
  from "./caravel-premium.ts";

type Rec=Record<string,unknown>;
const rec=(v:unknown):Rec|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Rec:null;
const uniqueSorted=(values:string[])=>[...new Set(values)].sort();
const matching=(a:string[],b:string[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const docId=(v:unknown):v is string=>
  typeof v==="string" && v.length>0 && v.length<=200 &&
  /^[A-Za-z0-9._~-]+$/.test(v) && v!=="."&&v!=="..";
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const allowedMissing=new Set(["glass","tyres_and_wheels","undercarriage"]);

/** All values below are operator-reviewed server evidence, not user input. */
export type CaravelApprovedExclusionReview={
  termsDocumentId:string;
  termsContentHash:string;
  /** Every code in supplier protection.excludes, not just the 3 main ones. */
  documentedExcludedCodes:string[];
  /** Current disclosed charge for damage/theft in EUR cents; 0 if none. */
  damageAdministrationFeeMinor:number;
  currency:"EUR";
  approvedByRide24:true;
  canonicalHashVerified:true;
};
export type CaravelProtectionDecision=
  |{ok:true;covers:string[];excludes:string[];productType:"waiver";
     noCreditCard:true;noCardHold:true;fullInsuranceClaimAllowed:boolean;
     disclosureRequired:boolean;damageAdministrationFeeMinor:number|null;
     reviewedTermsDocumentId:string|null}
  |{ok:false;errors:string[]};

export function evaluateCaravelPremiumForRide24(
  plan:unknown,protection:unknown,quoteDeposit:unknown,
  reviewedExclusions?:CaravelApprovedExclusionReview,
):CaravelProtectionDecision {
  const base=evaluateCaravelPremium(plan,protection,quoteDeposit);
  if(!reviewedExclusions){
    if("errors" in base)return base;
    return {...base,fullInsuranceClaimAllowed:base.excludes?.length===0,
      disclosureRequired:base.excludes!==null && base.excludes.length>0,
      damageAdministrationFeeMinor:null,reviewedTermsDocumentId:null};
  }
  const review=reviewedExclusions;
  const errors:string[]=[];
  const p=rec(protection);
  const excludes=p?.excludes;
  const covers=p?.covers;
  if(!docId(review.termsDocumentId)||!hash(review.termsContentHash)||
     review.approvedByRide24!==true||review.canonicalHashVerified!==true)
    errors.push("CARAVEL_TERMS_REVIEW_UNVERIFIED");
  if(review.currency!=="EUR"||
    !Number.isSafeInteger(review.damageAdministrationFeeMinor)||
    review.damageAdministrationFeeMinor<0||review.damageAdministrationFeeMinor>500000)
    errors.push("CARAVEL_DAMAGE_ADMIN_FEE_UNVERIFIED");
  if(!Array.isArray(excludes)||!Array.isArray(review.documentedExcludedCodes)||
     !excludes.every((v:unknown)=>typeof v==="string"&&/^[a-z0-9_]{1,80}$/.test(v))||
     !review.documentedExcludedCodes.every(v=>typeof v==="string"&&/^[a-z0-9_]{1,80}$/.test(v)))
    errors.push("CARAVEL_EXCLUSIONS_UNVERIFIED");
  else {
    const fromSupplier=uniqueSorted(excludes as string[]);
    const approved=uniqueSorted(review.documentedExcludedCodes);
    if(fromSupplier.length!==excludes.length||approved.length!==review.documentedExcludedCodes.length||
       !matching(fromSupplier,approved))errors.push("CARAVEL_EXCLUSIONS_CHANGED_OR_NOT_DISCLOSED");
  }
  // An actual Premium damage waiver still needs theft, fire and collision
  // bodywork coverage; zero excess, theft excess and deposit remain mandatory.
  if(!Array.isArray(covers)||!covers.includes("bodywork"))
    errors.push("CARAVEL_BODYWORK_COVER_NOT_CONFIRMED");
  if("errors" in base){
    for(const code of base.errors){
      const m=/^COVER_MISSING_(GLASS|TYRES_AND_WHEELS|UNDERCARRIAGE)$/.exec(code);
      if(m && Array.isArray(excludes) && excludes.includes(m[1].toLowerCase()) &&
         allowedMissing.has(m[1].toLowerCase()))continue;
      errors.push(code);
    }
  }
  if(errors.length)return {ok:false,errors:[...new Set(errors)]};
  return {ok:true,covers:covers as string[],excludes:excludes as string[],
    productType:"waiver",noCreditCard:true,noCardHold:true,
    // This is explicitly limited Premium, NOT "full insurance".
    fullInsuranceClaimAllowed:false,disclosureRequired:true,
    damageAdministrationFeeMinor:review.damageAdministrationFeeMinor,
    reviewedTermsDocumentId:review.termsDocumentId};
}
