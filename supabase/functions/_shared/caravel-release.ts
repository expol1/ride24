/**
 * Caravel customer release gate (single source of truth for search, the
 * consent screen, the Caravel booking request and checkout).
 *
 * OPEN only when ALL of the following hold, read server-side with service role:
 *  - caravel_release_control: certified, allow_customer_checkout,
 *    official_certified_at, terms_document_id + terms_content_hash;
 *  - partner 78721481…: api_provider=caravel, api_enabled, api_status=synced,
 *    provider_type=api, active, account_status=active;
 *  - caravel_reviewed_terms row for exactly that (document_id, content_hash),
 *    whose stored clauses/v1 body re-hashes to content_hash (§3.9).
 * Anything else -> closed, with a reason code (never a partial open).
 */
import {computeCaravelTermsContentHash} from "./caravel-terms-canonical.ts";
import type {CaravelApprovedExclusionReview} from "./caravel-exclusion-policy.ts";
import type {CaravelTermsSnapshot} from "./caravel-terms-version.ts";

export const CARAVEL_PARTNER_ID = "78721481-7619-44df-a9b7-5faa344b69bb";
type Rec = Record<string, unknown>;
type Db = {from(table: string): any};
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;

export type CaravelReviewedTerms = {
  documentId: string; supplierId: string; language: string; version: number; title: string;
  contentHash: string; publishedAt: string; body: Rec;
  documentedExcludedCodes: string[]; damageAdminFeeMinor: number; damageAdminFeeCurrency: "EUR";
  exclusionClauseRefs: string[]; adminFeeClauseRef: string | null;
  keyClauseRefs: Record<string, string>; noCardRequired: boolean; freeCancellationUntilPickup: boolean;
};
export type CaravelRelease =
  | {open: true; terms: CaravelReviewedTerms; snapshot: CaravelTermsSnapshot; review: CaravelApprovedExclusionReview}
  | {open: false; reason: string};

export function reviewedTermsFromRow(row: unknown): CaravelReviewedTerms | null {
  const r = rec(row);
  const codes = r?.documented_excluded_codes, refs = r?.exclusion_clause_refs;
  if (!r || typeof r.document_id !== "string" || typeof r.supplier_id !== "string" || typeof r.language !== "string" ||
      !Number.isSafeInteger(r.version) || (r.version as number) < 5 || r.language !== "en" || typeof r.title !== "string" || r.format !== "clauses/v1" ||
      typeof r.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(r.content_hash) ||
      typeof r.published_at !== "string" || !rec(r.body) ||
      !Array.isArray(codes) || !codes.every((c) => typeof c === "string" && /^[a-z0-9_]{1,80}$/.test(c)) ||
      !Number.isSafeInteger(r.damage_admin_fee_minor) || (r.damage_admin_fee_minor as number) < 0 ||
      r.damage_admin_fee_currency !== "EUR" || r.damage_admin_fee_minor !== 10000 ||
      r.free_cancellation_until_pickup !== true || !Array.isArray(refs) || !refs.every((c) => typeof c === "string") ||
      (r.admin_fee_clause_ref != null && typeof r.admin_fee_clause_ref !== "string"))
    return null;
  return {documentId: r.document_id, supplierId: r.supplier_id, language: r.language, version: r.version as number,
    title: r.title, contentHash: r.content_hash, publishedAt: r.published_at, body: r.body as Rec,
    documentedExcludedCodes: [...new Set(codes as string[])].sort(), damageAdminFeeMinor: r.damage_admin_fee_minor as number,
    damageAdminFeeCurrency: "EUR", exclusionClauseRefs: refs as string[], adminFeeClauseRef: (r.admin_fee_clause_ref as string) ?? null,
    keyClauseRefs: Object.fromEntries(Object.entries(rec(r.key_clause_refs) ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    noCardRequired: r.no_card_required === true, freeCancellationUntilPickup: r.free_cancellation_until_pickup === true};
}

export async function loadCaravelRelease(admin: Db): Promise<CaravelRelease> {
  try {
    const gate = await admin.from("caravel_release_control")
      .select("certified,allow_customer_checkout,official_certified_at,terms_document_id,terms_content_hash")
      .eq("singleton", true).maybeSingle();
    const g = rec(gate?.data);
    if (gate?.error || !g) return {open: false, reason: "CARAVEL_RELEASE_STATE_UNAVAILABLE"};
    if (g.certified !== true || typeof g.official_certified_at !== "string")
      return {open: false, reason: "CARAVEL_NOT_CERTIFIED"};
    if (g.allow_customer_checkout !== true) return {open: false, reason: "CARAVEL_CHECKOUT_NOT_RELEASED"};
    if (typeof g.terms_document_id !== "string" || typeof g.terms_content_hash !== "string")
      return {open: false, reason: "CARAVEL_TERMS_NOT_APPROVED"};
    const partner = await admin.from("partners")
      .select("api_provider,api_enabled,api_status,provider_type,active,account_status")
      .eq("id", CARAVEL_PARTNER_ID).maybeSingle();
    const p = rec(partner?.data);
    if (partner?.error || !p || p.api_provider !== "caravel" || p.api_enabled !== true || p.api_status !== "synced" ||
        p.provider_type !== "api" || p.active !== true || p.account_status !== "active")
      return {open: false, reason: "CARAVEL_PARTNER_NOT_ACTIVE"};
    const doc = await admin.from("caravel_reviewed_terms").select("*")
      .eq("document_id", g.terms_document_id).maybeSingle();
    const terms = reviewedTermsFromRow(doc?.data);
    if (doc?.error || !terms || terms.contentHash !== g.terms_content_hash)
      return {open: false, reason: "CARAVEL_REVIEWED_TERMS_MISSING"};
    if (await computeCaravelTermsContentHash(terms.body).catch(() => null) !== terms.contentHash)
      return {open: false, reason: "CARAVEL_REVIEWED_TERMS_HASH_MISMATCH"};
    return {open: true, terms,
      snapshot: {supplierId: terms.supplierId, language: terms.language, documentId: terms.documentId,
        version: terms.version, contentHash: terms.contentHash, publishedAt: terms.publishedAt},
      review: {termsDocumentId: terms.documentId, termsContentHash: terms.contentHash,
        documentedExcludedCodes: terms.documentedExcludedCodes, damageAdministrationFeeMinor: terms.damageAdminFeeMinor,
        currency: "EUR", approvedByRide24: true, canonicalHashVerified: true}};
  } catch {
    return {open: false, reason: "CARAVEL_RELEASE_STATE_UNAVAILABLE"};
  }
}
