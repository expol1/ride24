/**
 * Caravel inside the EXISTING "Konfiguracja Partnera API" admin modal — no new
 * admin tabs or buttons. api-partner-admin routes its ordinary actions here only
 * for the Caravel partner UUID (every other partner keeps its existing code path):
 *
 *   test       -> read-only production connection check (capabilities + suppliers)
 *   sync       -> catalogue merge for every active supplier + current terms ingest
 *                 (first time: review fields from the Caravel panel; later: the
 *                  parameters of the previously reviewed document are reused)
 *   activate   -> atomic caravel_set_release(open) with the certification time
 *   deactivate -> caravel_set_release(close) kill switch
 *
 * runCaravelAutoSync() is the scheduled job (no UI): catalogue merge and terms
 * version check. A new terms document is stored when the machine checks pass, but
 * sales are PAUSED until an administrator presses "Aktywuj API" — old consent can
 * never be reused for a new version.
 */
import {ingestCaravelProductionTerms, syncCaravelCatalog, setCaravelRelease, CARAVEL_PARTNER_ID} from "./caravel-admin.ts";
import {loadCaravelRelease} from "./caravel-release.ts";
import type {CaravelClient} from "./caravel-sandbox-adapter.ts";

type Rec = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;
type Client = Pick<CaravelClient, "environment" | "capabilities" | "suppliers" | "locations" | "vehicleClasses" | "reference" |
  "referenceTerms" | "referenceTermsDocument">;
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const list = (v: unknown) => (typeof v === "string" ? v.split(/[,\s]+/) : Array.isArray(v) ? v.map(String) : [])
  .map((x) => x.trim()).filter(Boolean);

export type CaravelPanelInput = {
  certified_at?: string; excluded_codes?: string | string[]; damage_admin_fee_eur?: string | number;
  exclusion_clause_refs?: string | string[]; admin_fee_clause_ref?: string;
};
export type CaravelAdminResult = {status: number; body: Rec};
const ok = (message: string, extra: Rec = {}): CaravelAdminResult => ({status: 200, body: {success: true, message, ...extra}});
const no = (error: string, status = 409): CaravelAdminResult => ({status, body: {error}});

async function sellableSuppliers(client: Client): Promise<string[]> {
  return ((await client.suppliers()).data as Rec[])
    .filter((s) => s.status === "active" && s.tax_inclusive === true && Array.isArray(s.payment_models) &&
      (s.payment_models as unknown[]).includes("pay_on_arrival"))
    .map((s) => String(s.supplier_id));
}

async function latestReviewed(admin: Db, supplierId?: string): Promise<Rec | null> {
  let q = admin.from("caravel_reviewed_terms").select("document_id,supplier_id,language,content_hash,documented_excluded_codes,damage_admin_fee_minor,exclusion_clause_refs,admin_fee_clause_ref,approved_at");
  if (supplierId) q = q.eq("supplier_id", supplierId);
  const {data} = await q.order("approved_at", {ascending: false}).limit(1);
  return (data ?? [])[0] ?? null;
}

/** Current terms for one supplier: already stored -> no-op; otherwise ingest with panel or previous review parameters. */
async function refreshTerms(admin: Db, client: Client, supplierId: string, panel: CaravelPanelInput | null, actor: string) {
  const prev = await latestReviewed(admin, supplierId);
  const fee = panel?.damage_admin_fee_eur !== undefined && panel.damage_admin_fee_eur !== ""
    ? Math.round(Number(String(panel.damage_admin_fee_eur).replace(",", ".")) * 100) : prev ? Number(prev.damage_admin_fee_minor) : NaN;
  const codes = panel && list(panel.excluded_codes).length ? list(panel.excluded_codes) : prev ? list(prev.documented_excluded_codes) : [];
  const refs = panel && list(panel.exclusion_clause_refs).length ? list(panel.exclusion_clause_refs) : prev ? list(prev.exclusion_clause_refs) : [];
  const feeRef = panel?.admin_fee_clause_ref?.trim() || (prev?.admin_fee_clause_ref as string | null) || null;
  const metaList = (await client.referenceTerms(supplierId)).data;
  const current = metaList.filter((m) => m.language === "en" && m.withdrawn_at === null);
  if (current.length !== 1) return {ok: false, code: "CARAVEL_TERMS_CURRENT_AMBIGUOUS_OR_MISSING"};
  if (!Number.isSafeInteger(fee)) return {ok: false, code: "CARAVEL_TERMS_REVIEW_FIELDS_REQUIRED"};
  return ingestCaravelProductionTerms({admin, client, input: {supplierId, language: "en", documentId: current[0].document_id,
    excludedCodes: codes, damageAdminFeeMinor: fee, exclusionClauseRefs: refs, adminFeeClauseRef: feeRef, approvedBy: actor}});
}

export async function handleCaravelPartnerAction(args: {
  action: string; admin: Db; client: Client | null; panel: CaravelPanelInput | null; actor: string;
}): Promise<CaravelAdminResult> {
  const {action, admin, panel, actor} = args;
  const client = args.client as Client;
  // The kill switch never depends on the supplier connection.
  if (action === "deactivate") {
    const r = await setCaravelRelease({admin, open: false, actor, reason: "Wyłączenie w ustawieniach partnera API"});
    return r.ok ? ok("Caravel: sprzedaż wyłączona") : no(`Caravel: wyłączenie nieudane (${r.code})`, 500);
  }
  if (!client || client.environment !== "production") return no("Caravel: wymagane poświadczenia produkcyjne (https://api.caravelway.com)");
  if (action === "test") {
    const caps = await client.capabilities();
    const suppliers = await sellableSuppliers(client);
    await admin.from("partner_api_credentials").update({last_test_at: new Date().toISOString(), last_test_ok: suppliers.length > 0,
      last_error: suppliers.length ? null : "CARAVEL_NO_PAY_ON_ARRIVAL_SUPPLIER"}).eq("partner_id", CARAVEL_PARTNER_ID);
    return suppliers.length
      ? ok(`Caravel: połączenie poprawne (API ${String(rec(caps.data)?.api_version ?? "?")}, dostawców: ${suppliers.length})`)
      : no("Caravel: brak dostawcy z płatnością przy odbiorze");
  }
  if (action === "sync") {
    const suppliers = await sellableSuppliers(client);
    if (!suppliers.length) return no("Caravel: brak dostawcy z płatnością przy odbiorze");
    const open = (await loadCaravelRelease(admin)).open;
    let locations = 0, groups = 0;
    const terms: Rec[] = [];
    for (const sid of suppliers) {
      const c = await syncCaravelCatalog({admin, client, supplierId: sid, activateNew: open});
      if ("code" in c) return no(`Caravel: synchronizacja katalogu nieudana (${c.code})`);
      locations += c.locations.inserted + c.locations.updated; groups += c.vehicles.inserted + c.vehicles.updated;
      terms.push({supplier_id: sid, ...(await refreshTerms(admin, client, sid, panel, actor))});
    }
    await admin.from("partner_api_credentials").update({last_sync_at: new Date().toISOString()}).eq("partner_id", CARAVEL_PARTNER_ID);
    const termsOk = terms.every((t) => t.ok === true);
    return ok(termsOk ? "Caravel: katalog i regulamin zsynchronizowane" : "Caravel: katalog zsynchronizowany; regulamin wymaga uzupełnienia danych przeglądu",
      {result: {locations, groups, terms}});
  }
  if (action === "activate") {
    const doc = await latestReviewed(admin);
    if (!doc) return no("Caravel: najpierw zsynchronizuj regulamin (brak zatwierdzonego dokumentu)");
    const r = await setCaravelRelease({admin, open: true, certifiedAt: panel?.certified_at ?? null,
      documentId: String(doc.document_id), contentHash: String(doc.content_hash), actor, reason: "Aktywacja w ustawieniach partnera API"});
    if (!r.ok) return no(`Caravel: aktywacja zablokowana (${r.code})`);
    await admin.from("partners").update({api_last_error: null}).eq("id", CARAVEL_PARTNER_ID);
    return ok("Caravel: sprzedaż aktywna (certyfikacja i regulamin potwierdzone)");
  }
  return no("Nieobsługiwana akcja Caravel", 400);
}

/** Scheduled job (no UI): keep catalogue and terms in sync; pause sales on a terms change. */
export async function runCaravelAutoSync(args: {admin: Db; client: Client}): Promise<Rec> {
  const {admin, client} = args;
  const release = await loadCaravelRelease(admin);
  if (client.environment !== "production") return {ok: false, code: "CARAVEL_PRODUCTION_ONLY"};
  const suppliers = await sellableSuppliers(client);
  const out: Rec = {release_open: release.open, suppliers: []};
  for (const sid of suppliers) {
    const catalog = await syncCaravelCatalog({admin, client, supplierId: sid, activateNew: release.open});
    const meta = (await client.referenceTerms(sid)).data.filter((m) => m.language === "en" && m.withdrawn_at === null);
    const changed = release.open && release.terms.supplierId === sid &&
      (meta.length !== 1 || meta[0].document_id !== release.terms.documentId || meta[0].content_hash !== release.terms.contentHash);
    let terms: Rec = {changed: false};
    if (changed) {
      const stored = await refreshTerms(admin, client, sid, null, "auto-sync:verified-awaiting-activation");
      const paused = await setCaravelRelease({admin, open: false, actor: "auto-sync",
        reason: `Nowa wersja regulaminu Caravel (${meta[0]?.document_id ?? "brak"}): sprzedaż wstrzymana do ponownej aktywacji`});
      await admin.from("partners").update({api_last_error: "CARAVEL_TERMS_CHANGED: przejrzyj regulamin i kliknij Aktywuj API"})
        .eq("id", CARAVEL_PARTNER_ID);
      terms = {changed: true, stored, paused: paused.ok};
    }
    (out.suppliers as Rec[]).push({supplier_id: sid, catalog, terms});
  }
  return out;
}
