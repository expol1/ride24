/**
 * Caravel-only preparation at the POST-Stripe/BEFORE supplier POST boundary.
 *
 * IMPORTANT: pure function. Does NOT call Stripe, Caravel, Supabase or create
 * any booking. NOT wired to the shared Ride24 provider adapter yet.
 *
 * In the eventual backend adapter, fetch the stored quote and booking
 * snapshot with service_role; fetch the current authoritative terms list,
 * verify the canonical hash according to Caravel contract §3.9, and pass
 * the approved Premium/licence evidence from trusted backend records.
 * Never source certificationPassed or canonicalHashVerified from a browser.
 */
import {buildCaravelBookingDraft,caravelQuotedBookingRequest,
  type CaravelDraftOptions,type Ride24BookingInput}
  from "./caravel-booking.ts";
import {validateCaravelTermsBeforeDispatch,
  type CaravelBookingTermsSnapshot} from "./caravel-terms-lifecycle.ts";
import type {CaravelTermsSnapshot} from "./caravel-terms-version.ts";
import type {CaravelQuotedBookingRequest} from "./caravel-sandbox-adapter.ts";

type ProductionGate = NonNullable<CaravelDraftOptions["production"]>;
export type VerifiedCaravelDispatchPlan = {
  supplierId:string;
  idempotencyKey:string;
  termsDocumentId:string;
  request:CaravelQuotedBookingRequest;
};
export type CaravelDispatchPreparation =
  |{ok:true;plan:VerifiedCaravelDispatchPlan}
  |{ok:false;action:"hold_for_manual_review";reasons:string[]};

/**
 * Always fail closed. Never interpret "hold_for_manual_review" as a refund
 * instruction; reuse Ride24's existing review/refund flow only when wired.
 */
export function prepareVerifiedCaravelDispatch(args:{
  bookingInput:Ride24BookingInput;
  nowEpochMs:number;
  productionGate:ProductionGate;
  reviewedTerms:CaravelTermsSnapshot;
  currentTermsMetadataList:unknown;
  persistedBookingTerms:CaravelBookingTermsSnapshot | null;
}):CaravelDispatchPreparation {
  if(!args || !args.bookingInput || !args.productionGate ||
     !args.reviewedTerms) return {
    ok:false,action:"hold_for_manual_review",reasons:["CARAVEL_DISPATCH_EVIDENCE_MISSING"],
  };
  const terms=validateCaravelTermsBeforeDispatch({
    quote:args.bookingInput.provider_quote_data,
    reviewed:args.reviewedTerms,
    currentMetadataList:args.currentTermsMetadataList,
    canonicalHashVerified:args.productionGate.termsCanonicalHashVerified,
    persistedBookingSnapshot:args.persistedBookingTerms,
  });
  if("reason" in terms) return {
    ok:false,action:"hold_for_manual_review",reasons:[terms.reason],
  };
  const booking=buildCaravelBookingDraft(
    args.bookingInput,args.nowEpochMs,
    {environment:"production",production:args.productionGate},
  );
  if("errors" in booking) return {
    ok:false,action:"hold_for_manual_review",reasons:booking.errors,
  };
  const draft=booking.draft;
  const saved=args.persistedBookingTerms!;
  if(draft.supplierId!==args.reviewedTerms.supplierId ||
     draft.termsDocumentId!==terms.documentId ||
     draft.termsDocumentId!==saved.caravel_terms_document_id ||
     draft.termsContentHash!==saved.caravel_terms_content_hash ||
     draft.termsLanguage!==saved.caravel_terms_language) return {
    ok:false,action:"hold_for_manual_review",reasons:["CARAVEL_DISPATCH_TERMS_OR_SUPPLIER_MISMATCH"],
  };
  return {ok:true,plan:{
    supplierId:draft.supplierId,
    idempotencyKey:draft.idempotencyKey,
    termsDocumentId:terms.documentId,
    request:caravelQuotedBookingRequest(draft),
  }};
}
