/**
 * Reference catalogue sync as a MERGE (OpenAPI v1.67.0: "Upsert each record by
 * id into what you hold — never replace your table"; certification scenario
 * shrunk-reference-refresh). A refresh that omits a record never deletes it:
 * the record is kept, marked `missing_since`, and stays quotable by its
 * original id. A changed display name is the same record. Ids are opaque and
 * stored exactly as served — never parsed or derived.
 */
type Json = Record<string, unknown>;
export type ReferenceRecord = {id: string; supplier_id: string | null; data: Json; first_seen: string; last_seen: string; missing_since: string | null};
export type ReferenceStore = Map<string, ReferenceRecord>;

export const REFERENCE_ID_KEYS = Object.freeze({
  locations: "location_id", vehicles: "vehicle_id", protections: "protection_id", extras: "extra_id",
} as const);

/** Merge one refresh into the store. Returns counts for the sync log. */
export function mergeCaravelReference(
  store: ReferenceStore,
  refresh: unknown[],
  idKey: string,
  syncedAtIso: string,
): {added: number; updated: number; missing: number; returned: number; invalid: number} {
  const counts = {added: 0, updated: 0, missing: 0, returned: 0, invalid: 0};
  const seen = new Set<string>();
  for (const raw of Array.isArray(refresh) ? refresh : []) {
    const r = raw && typeof raw === "object" ? raw as Json : null;
    const id = r && typeof r[idKey] === "string" && (r[idKey] as string).length > 0 ? r[idKey] as string : null;
    if (!r || !id) { counts.invalid++; continue; }
    // Key on supplier + id: ids are unique across suppliers, but keep the scope explicit.
    const supplier = typeof r.supplier_id === "string" ? r.supplier_id : null;
    const key = `${supplier ?? ""}\u0000${id}`;
    seen.add(key);
    const prior = store.get(key);
    if (!prior) {
      store.set(key, {id, supplier_id: supplier, data: r, first_seen: syncedAtIso, last_seen: syncedAtIso, missing_since: null});
      counts.added++;
    } else {
      if (prior.missing_since) counts.returned++;
      else counts.updated++;
      store.set(key, {...prior, data: r, last_seen: syncedAtIso, missing_since: null});
    }
  }
  for (const [key, rec] of store) {
    if (!seen.has(key) && !rec.missing_since) {
      store.set(key, {...rec, missing_since: syncedAtIso});
      counts.missing++;
    }
  }
  return counts;
}

/** Look a record up by its opaque id (and supplier), including ones missing from the last refresh. */
export function findCaravelReference(store: ReferenceStore, id: string, supplierId: string | null): ReferenceRecord | null {
  return store.get(`${supplierId ?? ""}\u0000${id}`) ?? null;
}
