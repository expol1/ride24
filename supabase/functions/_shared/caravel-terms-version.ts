/**
 * Caravel authoritative terms version state. Isolated; no DB writes.
 * The supplier requires id comparison each sync and immutable historical docs.
 * NEVER replace accepted Ride24 documents or accept changed terms silently.
 */
import {isCaravelTermsMetadata, selectCurrentCaravelTerms, type CaravelTermsMetadata,
  type CaravelTermsDocument, type CaravelClient}
  from "./caravel-sandbox-adapter.ts";
import {verifyCaravelTermsDocumentHash} from "./caravel-terms-canonical.ts";

export type CaravelTermsSnapshot = {
  supplierId: string;
  language: string;
  documentId: string;
  version: number;
  contentHash: string;
  publishedAt: string;
};
export type CaravelTermsComparison = {
  action: "initial_review_required" | "unchanged" | "new_version_requires_review";
  snapshot: CaravelTermsSnapshot;
  replacedDocumentId: string | null;
};
const supplierCode=(s:unknown):s is string=>
  typeof s==="string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const langCode=(s:unknown):s is string=>
  typeof s==="string" && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(s);
const asVersion=(v:CaravelTermsMetadata["version"]):number=>Number(v);
const currentSnapshot=(meta:CaravelTermsMetadata,supplierId:string):CaravelTermsSnapshot=>({
  supplierId,language:meta.language,documentId:meta.document_id,
  version:asVersion(meta.version),contentHash:meta.content_hash.toLowerCase(),
  publishedAt:meta.published_at,
});
const validPrevious=(p:CaravelTermsSnapshot,supplier:string,lang:string):boolean=>
  p && p.supplierId===supplier && p.language===lang &&
  typeof p.documentId==="string" && /^[A-Za-z0-9._~-]{1,200}$/.test(p.documentId) &&
  Number.isSafeInteger(p.version) && p.version>0 &&
  typeof p.contentHash==="string" && /^[a-f0-9]{64}$/.test(p.contentHash) &&
  typeof p.publishedAt==="string" && Number.isFinite(Date.parse(p.publishedAt));

/**
 * Evaluate the supplier's CURRENT terms list against the LAST REVIEWED record.
 * This makes no assumption about SHA-256 canonicalization (contract §3.9).
 * Even a valid higher version must be reviewed, re-shown and re-accepted.
 */
export function compareCaravelTermsVersion(args:{
  supplierId:string; language:string; currentMetadataList:unknown;
  previousReviewed?:CaravelTermsSnapshot | null;
}):CaravelTermsComparison {
  const {supplierId,language,currentMetadataList,previousReviewed=null}=args??{} as typeof args;
  if(!supplierCode(supplierId) || !langCode(language))
    throw new Error("CARAVEL_TERMS_SYNC_SCOPE_INVALID");
  if(!Array.isArray(currentMetadataList) || !currentMetadataList.every(isCaravelTermsMetadata))
    throw new Error("CARAVEL_TERMS_SYNC_LIST_INVALID");
  const meta=selectCurrentCaravelTerms(currentMetadataList,language);
  const snapshot=currentSnapshot(meta,supplierId);
  if(!previousReviewed)
    return {action:"initial_review_required",snapshot,replacedDocumentId:null};
  if(!validPrevious(previousReviewed,supplierId,language))
    throw new Error("CARAVEL_TERMS_PREVIOUS_SNAPSHOT_INVALID");
  if(snapshot.documentId===previousReviewed.documentId){
    if(snapshot.version!==previousReviewed.version ||
       snapshot.contentHash!==previousReviewed.contentHash ||
       snapshot.publishedAt!==previousReviewed.publishedAt)
      throw new Error("CARAVEL_TERMS_IMMUTABILITY_VIOLATION");
    return {action:"unchanged",snapshot,replacedDocumentId:null};
  }
  if(snapshot.version<=previousReviewed.version)
    throw new Error("CARAVEL_TERMS_VERSION_ROLLBACK");
  if(Date.parse(snapshot.publishedAt)<Date.parse(previousReviewed.publishedAt))
    throw new Error("CARAVEL_TERMS_PUBLICATION_DATE_ROLLBACK");
  return {action:"new_version_requires_review",snapshot,
    replacedDocumentId:previousReviewed.documentId};
}


/**
 * Read and cross-check the active authoritative Caravel document for one
 * supplier/language. The list is metadata ONLY; never show that list as terms.
 * Comparing a detail document against list metadata prevents a stale or
 * mismatched document from being displayed or snapshotted.
 *
 * The body is independently re-hashed with Caravel's published canonical
 * serialisation (§3.9 / TermsDocument.content_hash, see
 * caravel-terms-canonical.ts). A mismatch throws; the flag below is only
 * true after the recomputed digest equals the declared content_hash.
 *
 * No secrets, bookings, storage documents or DB rows are modified here.
 */
export async function fetchCaravelCurrentTermsForReview(
  client: Pick<CaravelClient, "referenceTerms" | "referenceTermsDocument">,
  supplierId: string,
  language: string,
  previousReviewed?: CaravelTermsSnapshot | null,
): Promise<{
  comparison: CaravelTermsComparison;
  document: CaravelTermsDocument;
  canonicalHashIndependentlyVerified: true;
}> {
  if (!supplierCode(supplierId) || !langCode(language))
    throw new Error("CARAVEL_TERMS_SYNC_SCOPE_INVALID");
  const list = await client.referenceTerms(supplierId);
  const comparison = compareCaravelTermsVersion({
    supplierId,language,currentMetadataList:list.data,previousReviewed,
  });
  const document = (await client.referenceTermsDocument(comparison.snapshot.documentId,supplierId)).data;
  const current = selectCurrentCaravelTerms(list.data,language);
  for (const key of [
    "document_id","language","version","title","format",
    "content_hash","published_at","withdrawn_at",
  ] as const) {
    if (document[key] !== current[key])
      throw new Error("CARAVEL_TERMS_LIST_DOCUMENT_MISMATCH");
  }
  // Caravel's body is clauses/v1, not HTML or a PDF URL.
  // Reject a retrieved document that is not currently active.
  if (document.withdrawn_at !== null || !document.body)
    throw new Error("CARAVEL_TERMS_DOCUMENT_NOT_CURRENT");
  const hash = await verifyCaravelTermsDocumentHash(document);
  if (hash.contentHash !== comparison.snapshot.contentHash)
    throw new Error("CARAVEL_TERMS_CONTENT_HASH_MISMATCH");
  return {comparison,document,canonicalHashIndependentlyVerified:true};
}


/**
 * Backend-only enrichment of a saved Caravel quote with the exact terms
 * approved for sale. Caller must obtain proof from the authoritative
 * document fetch, canonical digest implementation and human review.
 *
 * Fail-closed: "initial_review_required" or "new_version_requires_review"
 * may never silently put new terms on a customer quote. This function
 * performs no DB writes; save via existing service-role API-quote flow.
 */
export function bindReviewedCaravelTermsToQuote(input:{
  quoteData: unknown;
  comparison: CaravelTermsComparison;
  canonicalHashVerified: boolean;
}): Record<string,unknown> {
  const {quoteData,comparison,canonicalHashVerified}=input ?? {} as typeof input;
  if(canonicalHashVerified!==true) throw new Error("CARAVEL_TERMS_CANONICAL_HASH_NOT_VERIFIED");
  if(comparison?.action!=="unchanged")throw new Error("CARAVEL_TERMS_REVIEW_REQUIRED");
  const scope=comparison.snapshot;
  if(!scope || !validPrevious(scope,scope.supplierId,scope.language))
    throw new Error("CARAVEL_TERMS_SNAPSHOT_INVALID");
  if(!quoteData || typeof quoteData!=="object" || Array.isArray(quoteData))
    throw new Error("CARAVEL_QUOTE_METADATA_INVALID");
  const row=quoteData as Record<string,unknown>;
  if(row.provider!=="caravel" || row.supplier_id!==scope.supplierId ||
     typeof row.quote_id!=="string" || !row.quote_id)
    throw new Error("CARAVEL_QUOTE_TERMS_SCOPE_MISMATCH");
  if(row.terms_document_id!==undefined || row.terms_content_hash!==undefined ||
     row.terms_language!==undefined)
    throw new Error("CARAVEL_QUOTE_TERMS_ALREADY_BOUND");
  return {
    ...row,
    terms_document_id:scope.documentId,
    terms_content_hash:scope.contentHash,
    terms_language:scope.language,
  };
}
