import test from "node:test";
import assert from "node:assert/strict";
import {ingestCaravelProductionTerms, syncCaravelCatalog, setCaravelRelease} from "../supabase/functions/_shared/caravel-admin.ts";
import {computeCaravelTermsContentHash} from "../supabase/functions/_shared/caravel-terms-canonical.ts";
import {body} from "./fixtures/caravel/checkout-fixtures.mjs";

const PARTNER = "78721481-7619-44df-a9b7-5faa344b69bb";
function db(state = {}) {
  const ops = [];
  return {ops, state, from(table) {
    const filters = [];
    const rows = () => (state[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const chain = {
      select() { return chain; }, eq(k, v) { filters.push([k, v]); return chain; },
      async maybeSingle() { return {data: rows()[0] ?? null, error: null}; },
      then(res) { return Promise.resolve({data: rows(), error: null}).then(res); },
      async insert(r) { ops.push({table, op: "insert", rows: [].concat(r)}); (state[table] ??= []).push(...[].concat(r)); return {error: null}; },
      async upsert(r, o) { ops.push({table, op: "upsert", rows: r, onConflict: o.onConflict}); return {error: null}; },
    };
    return chain;
  }, async rpc(name, args) { ops.push({rpc: name, args}); return {data: {certified: args.p_open}, error: null}; }};
}
async function termsClient(patch = {}, env = "production") {
  const b = body();
  const meta = {document_id: "caravel-en-v5", language: "en", version: 5, title: b.title, format: "clauses/v1",
    content_hash: await computeCaravelTermsContentHash(b), published_at: "2026-11-17T10:00:00Z", withdrawn_at: null, ...patch};
  return {environment: env, async referenceTerms() { return {data: [meta]}; },
    async referenceTermsDocument() { return {data: {...meta, body: b}}; }, meta};
}
const input = (p = {}) => ({supplierId: "acct_eur", language: "en", documentId: "caravel-en-v5",
  excludedCodes: ["undercarriage", "glass", "tyres_and_wheels"], damageAdminFeeMinor: 10000,
  exclusionClauseRefs: ["5.4"], adminFeeClauseRef: "7.1", approvedBy: "admin:test", freeCancellationUntilPickup: true, ...p});

test("terms ingest: production document re-hashed, clause refs checked, stored immutably with sorted codes", async () => {
  const c = await termsClient(); const d = db();
  const r = await ingestCaravelProductionTerms({admin: d, client: c, input: input(), nowIso: "2026-12-01T09:00:00Z"});
  assert.equal(r.ok, true); assert.equal(r.alreadyStored, false); assert.equal(r.version, 5);
  const row = d.ops[0].rows[0];
  assert.equal(row.content_hash, c.meta.content_hash);
  assert.deepEqual(row.documented_excluded_codes, ["glass", "tyres_and_wheels", "undercarriage"]);
  assert.equal(row.admin_fee_clause_ref, "7.1");
  assert.equal(row.no_card_required, true, "clause 17 states no card is required");
  assert.equal(row.key_clause_refs.post_return, "27.1");
  assert.equal(d.ops.filter((o) => o.table === "caravel_release_control").length, 0, "never approves the release");
  const again = await ingestCaravelProductionTerms({admin: d, client: c, input: input()});
  assert.equal(again.ok, true); assert.equal(again.alreadyStored, true);
  d.state.caravel_reviewed_terms[0].content_hash = "f".repeat(64);
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: c, input: input()})).code, "CARAVEL_TERMS_STORED_HASH_CONFLICT");
});

test("terms ingest refuses: sandbox, not current doc, forged hash, missing clause, fee not in clause, bad input", async () => {
  const d = db();
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient({}, "sandbox"), input: input()})).code, "CARAVEL_PRODUCTION_ONLY");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient(), input: input({documentId: "caravel-en-v4"})})).code, "CARAVEL_TERMS_NOT_CURRENT_DOCUMENT");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient({content_hash: "a".repeat(64)}), input: input()})).code, "CARAVEL_TERMS_CONTENT_HASH_MISMATCH");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient(), input: input({exclusionClauseRefs: ["9.9"]})})).code, "CARAVEL_CLAUSE_REFERENCE_NOT_IN_DOCUMENT");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient(), input: input({damageAdminFeeMinor: 15000})})).code, "CARAVEL_PRODUCTION_CONTRACT_NOT_VERIFIED");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient(), input: input({adminFeeClauseRef: null})})).code, "CARAVEL_ADMIN_FEE_CLAUSE_REQUIRED");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient({version: 4}), input: input()})).code, "CARAVEL_TERMS_V5_REQUIRED");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient(), input: input({freeCancellationUntilPickup: false})})).code, "CARAVEL_PRODUCTION_CONTRACT_NOT_VERIFIED");
  assert.equal((await ingestCaravelProductionTerms({admin: d, client: await termsClient(), input: input({excludedCodes: ["Glass!"]})})).code, "CARAVEL_TERMS_INGEST_INPUT_INVALID");
  assert.equal(d.ops.length, 0, "nothing written on refusal");
});

const eur = (n) => ({amount: n, currency: "EUR"});
const loc = (id, p = {}) => ({supplier_id: "acct_eur", location_id: id, code: id, type: "airport", name: `Desk ${id}`,
  address: {city: "Athens", region: "Attica", country: "GR"}, timezone: "Europe/Athens", hours: null, ...p});
const veh = (id, p = {}) => ({supplier_id: "acct_eur", vehicle_id: id, acriss: "CDMR", name: "Group", display_name: "VW Golf or similar",
  seats: 5, large_bags: 1, small_bags: 2, transmission: "manual", fuel: "diesel", air_conditioning: true,
  min_driver_age: 21, max_driver_age: 75, images: [], ...p});
function catalogClient(env = "production", supplier = {}) {
  return {environment: env,
    async suppliers() { return {data: [{supplier_id: "acct_eur", status: "active", currency: "EUR", tax_inclusive: true, payment_models: ["pay_on_arrival"], ...supplier}]}; },
    async locations() { return {data: [loc("1"), loc("2"), loc("3", {timezone: "Mars/Olympus"})]}; },
    async vehicleClasses() { return {data: [veh("veh-a"), veh("veh-b")]}; },
    async reference() { return {data: {mileage: {type: "unlimited", source: "operator_default"}, fuel: {type: "full_to_full"},
      cancellation: {type: "free"}, deposit_payment_methods: [], tax_inclusive: true}}; }};
}

test("catalog sync: new rows INACTIVE, existing rows keep active flag, nothing deleted, no card claims", async () => {
  const d = db({partner_locations: [{partner_id: PARTNER, is_api_managed: true, external_id: "1", active: true},
    {partner_id: PARTNER, is_api_managed: true, external_id: "old", active: true}], car_classes: []});
  const r = await syncCaravelCatalog({admin: d, client: catalogClient(), supplierId: "acct_eur"});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.locations, {inserted: 1, updated: 1, missingFromRefresh: 1, rejected: {TIMEZONE_UNVERIFIED: 1}});
  assert.equal(r.vehicles.inserted, 2);
  const up = d.ops.find((o) => o.table === "partner_locations" && o.op === "upsert");
  assert.equal(up.onConflict, "partner_id,external_id");
  assert.equal("active" in up.rows[0], false, "existing row activation is not touched by sync");
  const ins = d.ops.find((o) => o.table === "partner_locations" && o.op === "insert");
  assert.equal(ins.rows[0].active, false);
  const cars = d.ops.find((o) => o.table === "car_classes" && o.op === "insert").rows;
  assert.ok(cars.every((c) => c.active === false && c.features.noCreditCard === false && c.features.noCardHold === false));
  assert.ok(!d.ops.some((o) => o.op === "delete"));
});

test("catalog sync refuses sandbox and suppliers that are not pay-on-arrival / tax-inclusive", async () => {
  assert.equal((await syncCaravelCatalog({admin: db(), client: catalogClient("sandbox"), supplierId: "acct_eur"})).code, "CARAVEL_PRODUCTION_ONLY");
  assert.equal((await syncCaravelCatalog({admin: db(), client: catalogClient("production", {payment_models: ["prepaid"]}), supplierId: "acct_eur"})).code, "CARAVEL_SUPPLIER_NOT_SELLABLE");
  assert.equal((await syncCaravelCatalog({admin: db(), client: catalogClient("production", {tax_inclusive: false}), supplierId: "acct_eur"})).code, "CARAVEL_SUPPLIER_NOT_SELLABLE");
  assert.equal((await syncCaravelCatalog({admin: db(), client: catalogClient("production", {currency: "GBP"}), supplierId: "acct_eur"})).code, "CARAVEL_SUPPLIER_NOT_SELLABLE");
});

test("release switch wrapper: evidence and audit required before the atomic SQL function is called", async () => {
  const d = db();
  assert.equal((await setCaravelRelease({admin: d, open: true, actor: "a", reason: "r"})).code, "CARAVEL_RELEASE_EVIDENCE_REQUIRED");
  assert.equal((await setCaravelRelease({admin: d, open: false, actor: "", reason: "r"})).code, "CARAVEL_RELEASE_AUDIT_REQUIRED");
  assert.equal(d.ops.length, 0);
  const ok = await setCaravelRelease({admin: d, open: false, actor: "admin:x", reason: "pause"});
  assert.equal(ok.ok, true); assert.equal(d.ops[0].rpc, "caravel_set_release");
  assert.equal(d.ops[0].args.p_document_id, null);
});
