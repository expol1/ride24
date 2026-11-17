/**
 * Caravel authoritative terms version state. Isolated; no DB writes.
 * The supplier requires id comparison each sync and immutable historical docs.
 * NEVER replace accepted Ride24 documents or accept changed terms silently.
 */
import {isCaravelTermsMetadata, selectCurrentCaravelTerms, type CaravelTermsMetadata}
  from "./caravel-sandbox-adapter.ts";

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
