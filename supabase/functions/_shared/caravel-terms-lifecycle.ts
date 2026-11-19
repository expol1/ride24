/**
 * Isolated Caravel-only payment-boundary terms checks; NOT wired into
 * production create-booking-request/Stripe/dispatch yet.
 *
 * The quote and reviewed snapshots MUST be loaded by the backend from
 * its service-role store. Only the acceptance boolean and displayed doc ID
 * may originate from the customer; both are checked against server truth.
 * This module never calls Stripe, creates bookings or issues refunds.
 */
import {compareCaravelTermsVersion, type CaravelTermsSnapshot}
  from "./caravel-terms-version.ts";

export type CaravelBookingTermsSnapshot = {
  caravel_terms_document_id:string;
  caravel_terms_language:string;
  caravel_terms_content_hash:string;
};
type CaravelTermsQuote = Record<string,unknown>;
type ValidatedTerms = {
  reviewed:CaravelTermsSnapshot;
  quote:CaravelTermsQuote;
};
function validatedContext(args:{
  quote:unknown;
  reviewed:CaravelTermsSnapshot;
  currentMetadataList:unknown;
  canonicalHashVerified:boolean;
}):ValidatedTerms {
  if(args?.canonicalHashVerified!==true)
    throw new Error("CARAVEL_TERMS_CANONICAL_HASH_NOT_VERIFIED");
  const q=args.quote;
  if(!q || typeof q!=="object" || Array.isArray(q))
    throw new Error("CARAVEL_TERMS_QUOTE_INVALID");
  const quote=q as CaravelTermsQuote;
  const reviewed=args.reviewed;
  if(quote.provider!=="caravel" || typeof quote.supplier_id!=="string" ||
     !reviewed || quote.supplier_id!==reviewed.supplierId)
    throw new Error("CARAVEL_TERMS_SUPPLIER_MISMATCH");
  const check=compareCaravelTermsVersion({
    supplierId:reviewed.supplierId,language:reviewed.language,
    currentMetadataList:args.currentMetadataList,
    previousReviewed:reviewed,
  });
  if(check.action!=="unchanged")
    throw new Error("CARAVEL_TERMS_NEW_VERSION_REQUIRES_REACCEPTANCE");
  if(quote.terms_document_id!==reviewed.documentId ||
     quote.terms_content_hash!==reviewed.contentHash ||
     quote.terms_language!==reviewed.language)
    throw new Error("CARAVEL_TERMS_QUOTE_SNAPSHOT_MISMATCH");
  return {reviewed,quote};
}

/**
 * Call BEFORE Stripe. The caller must render the actual authoritative
 * clauses/v1 document, obtain explicit acceptance, and load the server-side
 * verified quote. Persist returned fields ATOMICALLY with booking insert.
 */
export function validateCaravelTermsBeforeStripe(args:{
  quote:unknown;
  reviewed:CaravelTermsSnapshot;
  currentMetadataList:unknown;
  canonicalHashVerified:boolean;
  displayedDocumentId:unknown;
  customerAccepted:boolean;
}):CaravelBookingTermsSnapshot {
  const {reviewed}=validatedContext(args);
  if(args.customerAccepted!==true ||
     args.displayedDocumentId!==reviewed.documentId)
    throw new Error("CARAVEL_TERMS_ACCEPTANCE_REQUIRED");
  return {
    caravel_terms_document_id:reviewed.documentId,
    caravel_terms_language:reviewed.language,
    caravel_terms_content_hash:reviewed.contentHash,
  };
}

/**
 * Call AFTER Stripe but BEFORE POST /v1/bookings. Never book on a changed
 * document or missing booking snapshot: caller must put this booking into
 * the existing Ride24 manual review/refund path and avoid a supplier booking.
 */
export function validateCaravelTermsBeforeDispatch(args:{
  quote:unknown;
  reviewed:CaravelTermsSnapshot;
  currentMetadataList:unknown;
  canonicalHashVerified:boolean;
  persistedBookingSnapshot:unknown;
}):{ok:true;documentId:string}|{ok:false;action:"hold_for_manual_review";reason:string} {
  try {
    const {reviewed}=validatedContext(args);
    const p=args.persistedBookingSnapshot;
    if(!p || typeof p!=="object" || Array.isArray(p))
      throw new Error("CARAVEL_TERMS_BOOKING_SNAPSHOT_MISSING");
    const b=p as Record<string,unknown>;
    if(b.caravel_terms_document_id!==reviewed.documentId ||
       b.caravel_terms_content_hash!==reviewed.contentHash ||
       b.caravel_terms_language!==reviewed.language)
      throw new Error("CARAVEL_TERMS_BOOKING_SNAPSHOT_MISMATCH");
    return {ok:true,documentId:reviewed.documentId};
  }catch(error){
    const reason=error instanceof Error ? error.message : "CARAVEL_TERMS_UNKNOWN_ERROR";
    return {ok:false,action:"hold_for_manual_review",reason};
  }
}
