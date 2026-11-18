/**
 * Caravel ADMIN tools (operator-only; built and tested, not run on production yet).
 *
 *  1. ingestCaravelProductionTerms — fetch the CURRENT production clauses/v1 document,
 *     re-hash it (§3.9), check that the operator's clause references exist and that the
 *     admin-fee clause states the amount, then store it immutably in caravel_reviewed_terms.
 *     It does NOT approve the release; caravel_release_control is untouched.
 *  2. syncCaravelCatalog — read production locations / vehicle groups / policies,
 *     normalise with the existing Caravel normalisers, MERGE into partner_locations and
 *     car_classes: new rows are inserted INACTIVE, existing rows keep their active flag,
 *     nothing is deleted (a smaller refresh is never a deletion — certification rule).
 *  3. setCaravelRelease — one call to the atomic SQL function caravel_set_release
 *     (open = certification + reviewed terms + credentials + catalogue checks in one
 *     transaction; close = immediate kill switch). Every call is logged.
 */
import {fetchCaravelCurrentTermsForReview} from "./caravel-terms-version.ts";
import {
  caravelLocationFromApi, normalizeCaravelLocation, caravelVehicleFromApi, normalizeCaravelVehicleClass, caravelSyncRows,
} from "./caravel-normalize.ts";
import type {CaravelClient} from "./caravel-sandbox-adapter.ts";

type Rec = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;
export const CARAVEL_PARTNER_ID = "78721481-7619-44df-a9b7-5faa344b69bb";
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const CODE = /^[a-z0-9_]{1,80}$/;

function clauseIndex(body: Rec): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (c: Rec) => {
    const text = (c.paragraphs as Rec[][]).map((p) => p.map((r) => String(r.text)).join("")).join("\n");
    out.set(String(c.number), `${typeof c.heading === "string" ? c.heading + "\n" : ""}${text}`);
    for (const s of (Array.isArray(c.clauses) ? c.clauses : []) as Rec[]) walk(s);
  };
  for (const c of body.clauses as Rec[]) walk(c);
  return out;
}

export type TermsIngestInput = {
  supplierId: string; language: string; documentId: string;
  /** Every code the supplier's Premium protection excludes, as reviewed in the terms. */
  excludedCodes: string[];
  damageAdminFeeMinor: number;
  /** Clause number(s) of the binding text for the exclusions, e.g. ["6", "6.2"]. */
  exclusionClauseRefs: string[];
  adminFeeClauseRef: string | null;
  approvedBy: string;
};

export async function ingestCaravelProductionTerms(args: {
  admin: Db; client: Pick<CaravelClient, "environment" | "referenceTerms" | "referenceTermsDocument">;
  input: TermsIngestInput; nowIso?: string;
}): Promise<{ok: true; documentId: string; contentHash: string; version: number; alreadyStored: boolean} | {ok: false; code: string}> {
  const i = args.input;
  if (args.client.environment !== "production") return {ok: false, code: "CARAVEL_PRODUCTION_ONLY"};
  if (!i || !/^[A-Za-z0-9_-]{1,128}$/.test(i.supplierId) || !/^[a-z]{2,3}$/.test(i.language) ||
      typeof i.documentId !== "string" || !Array.isArray(i.excludedCodes) || !i.excludedCodes.every((c) => CODE.test(c)) ||
      new Set(i.excludedCodes).size !== i.excludedCodes.length ||
      !Number.isSafeInteger(i.damageAdminFeeMinor) || i.damageAdminFeeMinor < 0 || i.damageAdminFeeMinor > 500000 ||
      !Array.isArray(i.exclusionClauseRefs) || typeof i.approvedBy !== "string" || !i.approvedBy.trim())
    return {ok: false, code: "CARAVEL_TERMS_INGEST_INPUT_INVALID"};
  if (i.excludedCodes.length && !i.exclusionClauseRefs.length) return {ok: false, code: "CARAVEL_EXCLUSION_CLAUSE_REQUIRED"};
  if (i.damageAdminFeeMinor > 0 && !i.adminFeeClauseRef) return {ok: false, code: "CARAVEL_ADMIN_FEE_CLAUSE_REQUIRED"};
  let fetched;
  try { fetched = await fetchCaravelCurrentTermsForReview(args.client, i.supplierId, i.language); }
  catch (e) { return {ok: false, code: String((e as Error)?.message || "CARAVEL_TERMS_FETCH_FAILED").slice(0, 80)}; }
  const doc = fetched.document as unknown as Rec;
  if (doc.document_id !== i.documentId) return {ok: false, code: "CARAVEL_TERMS_NOT_CURRENT_DOCUMENT"};
  const clauses = clauseIndex(rec(doc.body)!);
  if (!i.exclusionClauseRefs.every((r) => clauses.has(r)) || (i.adminFeeClauseRef && !clauses.has(i.adminFeeClauseRef)))
    return {ok: false, code: "CARAVEL_CLAUSE_REFERENCE_NOT_IN_DOCUMENT"};
  if (i.damageAdminFeeMinor > 0) {
    const major = (i.damageAdminFeeMinor / 100).toString().replace(/\.0+$/, "");
    if (!new RegExp(`(^|[^0-9])${major.replace(".", "[.,]")}([^0-9]|$)`).test(clauses.get(i.adminFeeClauseRef!)!))
      return {ok: false, code: "CARAVEL_ADMIN_FEE_NOT_STATED_IN_CLAUSE"};
  }
  const hash = String(doc.content_hash);
  const existing = await args.admin.from("caravel_reviewed_terms").select("document_id,content_hash")
    .eq("document_id", i.documentId).maybeSingle();
  if (existing?.error) return {ok: false, code: "CARAVEL_TERMS_STORE_UNAVAILABLE"};
  if (existing?.data) return existing.data.content_hash === hash
    ? {ok: true, documentId: i.documentId, contentHash: hash, version: Number(doc.version), alreadyStored: true}
    : {ok: false, code: "CARAVEL_TERMS_STORED_HASH_CONFLICT"};
  const {error} = await args.admin.from("caravel_reviewed_terms").insert({
    document_id: i.documentId, supplier_id: i.supplierId, language: doc.language, version: Number(doc.version),
    title: doc.title, format: doc.format, content_hash: hash, published_at: doc.published_at, body: doc.body,
    documented_excluded_codes: [...i.excludedCodes].sort(), damage_admin_fee_minor: i.damageAdminFeeMinor,
    damage_admin_fee_currency: "EUR", exclusion_clause_refs: i.exclusionClauseRefs, admin_fee_clause_ref: i.adminFeeClauseRef,
    approved_by: i.approvedBy.trim().slice(0, 200), approved_at: args.nowIso ?? new Date().toISOString(),
  });
  if (error) return {ok: false, code: "CARAVEL_TERMS_STORE_WRITE_FAILED"};
  return {ok: true, documentId: i.documentId, contentHash: hash, version: Number(doc.version), alreadyStored: false};
}

export async function syncCaravelCatalog(args: {
  admin: Db; client: Pick<CaravelClient, "environment" | "suppliers" | "locations" | "vehicleClasses" | "reference">;
  supplierId: string; partnerId?: string;
}): Promise<{ok: true; locations: {inserted: number; updated: number; missingFromRefresh: number; rejected: Record<string, number>};
  vehicles: {inserted: number; updated: number; missingFromRefresh: number; rejected: Record<string, number>}} | {ok: false; code: string}> {
  const partnerId = args.partnerId ?? CARAVEL_PARTNER_ID;
  if (args.client.environment !== "production") return {ok: false, code: "CARAVEL_PRODUCTION_ONLY"};
  const sid = args.supplierId;
  const suppliers = (await args.client.suppliers()).data as Rec[];
  const s = suppliers.find((x) => x.supplier_id === sid);
  if (!s || s.status !== "active" || s.tax_inclusive !== true || !Array.isArray(s.payment_models) ||
      !(s.payment_models as unknown[]).includes("pay_on_arrival"))
    return {ok: false, code: "CARAVEL_SUPPLIER_NOT_SELLABLE"};
  const [loc, veh, pol] = await Promise.all([args.client.locations(200, sid), args.client.vehicleClasses(200, sid),
    args.client.reference("policies", sid)]);
  const tally = (list: Array<{ok: boolean; errors?: string[]}>) => list.reduce((acc: Record<string, number>, r) => {
    if (!r.ok) for (const e of r.errors ?? ["INVALID"]) acc[e] = (acc[e] ?? 0) + 1; return acc; }, {});
  const nl = (loc.data as unknown[]).map((l) => normalizeCaravelLocation(caravelLocationFromApi(l), sid));
  const nv = (veh.data as unknown[]).map((v) => normalizeCaravelVehicleClass(caravelVehicleFromApi(v, pol.data), sid));
  const okL = nl.filter((r) => r.ok).map((r) => (r as {value: Rec}).value);
  const okV = nv.filter((r) => r.ok).map((r) => (r as {value: Rec}).value);
  // "No credit card / no hold" is never claimed by the sync: unverified until Caravel confirms.
  const rows = caravelSyncRows(partnerId, okL as never, okV as never, new Map());
  async function merge(table: string, incoming: Rec[]) {
    const {data, error} = await args.admin.from(table).select("external_id").eq("partner_id", partnerId).eq("is_api_managed", true);
    if (error) throw new Error("CARAVEL_CATALOG_READ_FAILED");
    const known = new Set(((data ?? []) as Rec[]).map((r) => String(r.external_id)));
    const fresh = new Set(incoming.map((r) => String(r.external_id)));
    const existing = incoming.filter((r) => known.has(String(r.external_id))).map(({active: _a, ...rest}) => rest);
    const added = incoming.filter((r) => !known.has(String(r.external_id))).map((r) => ({...r, active: false}));
    if (existing.length) {
      const r = await args.admin.from(table).upsert(existing, {onConflict: "partner_id,external_id"});
      if (r.error) throw new Error("CARAVEL_CATALOG_WRITE_FAILED");
    }
    if (added.length) {
      const r = await args.admin.from(table).insert(added);
      if (r.error) throw new Error("CARAVEL_CATALOG_WRITE_FAILED");
    }
    return {inserted: added.length, updated: existing.length, missingFromRefresh: [...known].filter((k) => !fresh.has(k)).length};
  }
  try {
    const l = await merge("partner_locations", rows.partner_locations as Rec[]);
    const v = await merge("car_classes", rows.car_classes as Rec[]);
    return {ok: true, locations: {...l, rejected: tally(nl as never)}, vehicles: {...v, rejected: tally(nv as never)}};
  } catch (e) { return {ok: false, code: String((e as Error).message)}; }
}

export async function setCaravelRelease(args: {admin: Db; open: boolean; certifiedAt?: string | null;
  documentId?: string | null; contentHash?: string | null; actor: string; reason: string}) {
  if (typeof args.actor !== "string" || !args.actor.trim() || typeof args.reason !== "string" || !args.reason.trim())
    return {ok: false as const, code: "CARAVEL_RELEASE_AUDIT_REQUIRED"};
  if (args.open && (!args.certifiedAt || !Number.isFinite(Date.parse(args.certifiedAt)) || !args.documentId ||
      !/^[0-9a-f]{64}$/.test(String(args.contentHash))))
    return {ok: false as const, code: "CARAVEL_RELEASE_EVIDENCE_REQUIRED"};
  const {data, error} = await args.admin.rpc("caravel_set_release", {
    p_open: args.open, p_certified_at: args.open ? args.certifiedAt : null,
    p_document_id: args.open ? args.documentId : null, p_content_hash: args.open ? args.contentHash : null,
    p_actor: args.actor.trim().slice(0, 200), p_reason: args.reason.trim().slice(0, 500)});
  if (error) return {ok: false as const, code: String(error.message || "CARAVEL_RELEASE_FAILED").slice(0, 120)};
  return {ok: true as const, state: data};
}
