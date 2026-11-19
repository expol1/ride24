// Shared Caravel checkout fixtures (fictional sandbox-style data only).
import {computeCaravelTermsContentHash} from "../../../supabase/functions/_shared/caravel-terms-canonical.ts";

export const PARTNER = "78721481-7619-44df-a9b7-5faa344b69bb";
const QROW = "4da4d7ca-7244-4416-ab7b-2632bd5f882a";
const CAR = "d20bbca4-678c-4abf-bf4d-cf5356220170";
const QID = "3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const USER = "0a1b2c3d-4e5f-4a6b-8c7d-1234567890ab";
const PICK = "0aa18fda-4e7c-4b31-98b9-480d53e086e8";
export const NOW = Date.UTC(2026, 11, 1, 10, 0, 0);
// Structure mirrors Caravel EN v5 clause numbering (18 Nov 2026); text is a fictional paraphrase.
const P = (t, mark) => [mark ? {text: t, mark} : {text: t}];
export const body = () => ({title: "Caravel Rental Terms", language: "en", clauses: [
  {number: "4", heading: "Driving licence", paragraphs: [P("A licence issued in the EU/EEA is accepted.")]},
  {number: "5", heading: "Protection packages", paragraphs: [], clauses: [
    {number: "5.3", heading: "Premium", paragraphs: [P("Deposit 0, excess 0. The damage administration fee in 7.1 still applies.")]},
    {number: "5.2", heading: "Medium", paragraphs: [P("The damage administration fee in 7.1 still applies.")]},
    {number: "5.4", heading: "What CDW / Super CDW does NOT cover (all packages)",
      paragraphs: [P("Premium excludes glass, tyres and wheels and undercarriage, mirrors, interior, roof, keys. Ferry and cross-border travel are not permitted.")]}]},
  {number: "7", heading: "Charges", paragraphs: [], clauses: [
    {number: "7.1", paragraphs: [P("An administration fee of EUR 100 per rental applies to damage or theft, under every package.", "strong")]},
    {number: "7.4", paragraphs: [P("Traffic fines, parking and tolls remain the renter's and are passed on with a handling fee.")]}]},
  {number: "13", heading: "Cancellation", paragraphs: [P("Broker cancellation terms agreed with us apply.")]},
  {number: "17", heading: "Payment", paragraphs: [P("Pay at the desk in cash or by Visa or MasterCard. No card is required for the Premium package.")]},
  {number: "27", heading: "After return", paragraphs: [], clauses: [
    {number: "27.1", paragraphs: [P("Amounts owed after return are payable at return; amounts identified later are invoiced to the main renter.")]}]}]});
export async function termsRow(patch = {}) {
  const b = body();
  return {document_id: "caravel-en-v5", supplier_id: "acct_eur", language: "en", version: 5, title: "Caravel Rental Terms",
    format: "clauses/v1", content_hash: await computeCaravelTermsContentHash(b), published_at: "2026-11-17T10:00:00Z", body: b,
    documented_excluded_codes: ["glass", "tyres_and_wheels", "undercarriage"], damage_admin_fee_minor: 10000,
    damage_admin_fee_currency: "EUR", exclusion_clause_refs: ["5.4"], admin_fee_clause_ref: "7.1",
    key_clause_refs: {no_card: "17", post_return: "27.1", fines: "7.4", cancellation: "13", premium_package: "5.3"},
    no_card_required: true, free_cancellation_until_pickup: true,
    approved_by: "ride24-operator", approved_at: "2026-12-01T09:00:00Z", ...patch};
}
export function fakeDb(state) {
  return {
    from(table) {
      const filters = [];
      const chain = {
        select() { return chain; }, eq(k, v) { filters.push([k, v]); return chain; },
        in(k, vs) { filters.push([k, (x) => vs.includes(x)]); return chain; },
        async maybeSingle() {
          const rows = state[table] ?? [];
          const row = rows.find((r) => filters.every(([k, v]) => typeof v === "function" ? v(r[k]) : r[k] === v));
          return {data: row ? structuredClone(row) : null, error: null};
        },
        then(res) { const rows = (state[table] ?? []).filter((r) => filters.every(([k, v]) => typeof v === "function" ? v(r[k]) : r[k] === v)); return Promise.resolve({data: rows, error: null}).then(res); },
      };
      return chain;
    },
    async rpc(name, args) { state.rpc = state.rpc ?? []; state.rpc.push({name, args}); return {data: state.rpcResult ?? "11111111-2222-4333-8444-555555555555", error: state.rpcError ?? null}; },
  };
}
export async function releasedState(patch = {}) {
  const t = await termsRow();
  return {
    caravel_release_control: [{singleton: true, certified: true, allow_customer_checkout: true,
      official_certified_at: "2026-11-30T12:00:00Z", terms_document_id: t.document_id, terms_content_hash: t.content_hash}],
    partners: [{id: PARTNER, api_provider: "caravel", api_enabled: true, api_status: "synced", provider_type: "api", active: true, account_status: "active"}],
    caravel_reviewed_terms: [t],
    ...patch,
  };
}
export async function quoteRow(patch = {}, dataPatch = {}) {
  const t = await termsRow();
  return {id: QROW, partner_id: PARTNER, car_class_id: CAR, external_group_id: "opaque-group", external_quote_reference: QID,
    partner_net_total: 150, commission_total: 15, final_total: 165, currency: "EUR",
    expires_at: new Date(NOW + 30 * 60000).toISOString(), start_date: "2027-01-10", end_date: "2027-01-13",
    booking_id: null, used_at: null, pickup_location_external_id: "ath-airport", dropoff_location_external_id: "ath-airport",
    raw_response: {provider_quote_data: {provider: "caravel", quote_id: QID, supplier_id: "acct_eur", vehicle_id: "opaque-group",
      plan: "premium", currency: "EUR", payment_model: "pay_on_arrival", protection_id: "pro-premium",
      protection: {protection_id: "pro-premium", tier: "premium", product_type: "waiver",
        deposit: {amount: 0, currency: "EUR"}, excess: {amount: 0, currency: "EUR"}, theft_excess: {amount: 0, currency: "EUR"},
        covers: ["bodywork", "theft", "fire"], excludes: ["glass", "tyres_and_wheels", "undercarriage"]},
      amounts_minor: {total: 15000, pay_now: 0, pay_at_pickup: 15000}, drivers: [{age: 30, role: "main"}],
      terms_document_id: "caravel-en-v5", terms_content_hash: t.content_hash, terms_language: "en",
      damage_administration_fee_minor: 10000, pickup_at: "2027-01-10T10:00:00+02:00", dropoff_at: "2027-01-13T10:00:00+02:00",
      ...dataPatch},
      ride24_context: {version: 1, pickup_time: "10:00", return_time: "10:00", pickup_location: "Athens Airport", return_location: "Athens Airport"}},
    ...patch};
}
