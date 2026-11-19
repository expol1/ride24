import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {handleCaravelPartnerAction, runCaravelAutoSync} from "../supabase/functions/_shared/caravel-partner-admin.ts";
import {computeCaravelTermsContentHash} from "../supabase/functions/_shared/caravel-terms-canonical.ts";
import {body, termsRow, releasedState} from "./fixtures/caravel/checkout-fixtures.mjs";

const PARTNER = "78721481-7619-44df-a9b7-5faa344b69bb";
function db(state = {}) {
  const ops = [];
  const api = {ops, state, from(table) {
    const filters = [];
    const rows = () => (state[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const chain = {
      select() { return chain; }, eq(k, v) { filters.push([k, v]); return chain; },
      order() { return chain; }, limit() { return chain; },
      async maybeSingle() { return {data: rows()[0] ?? null, error: null}; },
      then(res) { return Promise.resolve({data: rows(), error: null}).then(res); },
      async insert(r) { ops.push({table, op: "insert", rows: [].concat(r)}); (state[table] ??= []).push(...[].concat(r)); return {error: null}; },
      async upsert(r) { ops.push({table, op: "upsert", rows: r}); return {error: null}; },
      update(v) { const u = {eq: async (k, val) => { ops.push({table, op: "update", values: v, where: [k, val]}); return {error: null}; }}; return u; },
    };
    return chain;
  }, async rpc(name, args) { ops.push({rpc: name, args}); return {data: {open: args.p_open}, error: null}; }};
  return api;
}
async function client(docId = "caravel-en-v5", env = "production") {
  const b = body();
  const meta = {document_id: docId, language: "en", version: 5, title: b.title, format: "clauses/v1",
    content_hash: await computeCaravelTermsContentHash(b), published_at: "2026-11-17T10:00:00Z", withdrawn_at: null};
  return {environment: env, meta,
    async capabilities() { return {data: {api_version: "1.68.0"}}; },
    pinned: "1.67.0",
    async whoami() { return {data: {api_version: {pinned: this.pinned, latest: "1.68.0"}}}; },
    async suppliers() { return {data: [{supplier_id: "acct_eur", status: "active", currency: "EUR", tax_inclusive: true, payment_models: ["pay_on_arrival"]},
      {supplier_id: "acct_other", status: "active", tax_inclusive: true, payment_models: ["prepaid"]}]}; },
    async locations() { return {data: [{supplier_id: "acct_eur", location_id: "1", type: "airport", name: "Athens Airport",
      address: {city: "Athens", region: "Attica", country: "GR"}, timezone: "Europe/Athens"}]}; },
    async vehicleClasses() { return {data: [{supplier_id: "acct_eur", vehicle_id: "veh-a", acriss: "CDMR", name: "Group", display_name: "VW Golf or similar",
      seats: 5, large_bags: 1, small_bags: 2, transmission: "manual", fuel: "diesel", air_conditioning: true, min_driver_age: 21, max_driver_age: 75, images: []}]}; },
    async reference() { return {data: [{supplier_id: "acct_eur", mileage: {type: "unlimited", source: "operator_default"}, fuel: {type: "full_to_full"}, cancellation: {type: "free"}, deposit_payment_methods: [], tax_inclusive: true}]}; },
    async referenceTerms() { return {data: [meta]}; },
    async referenceTermsDocument() { return {data: {...meta, body: b}}; }};
}
const panel = {certified_at: "2026-11-30T12:00:00.000Z", damage_admin_fee_eur: "100", excluded_codes: "glass, tyres_and_wheels, undercarriage",
  exclusion_clause_refs: "5.4", admin_fee_clause_ref: "7.1"};
const run = async (action, d, c, p = panel) => handleCaravelPartnerAction({action, admin: d, client: c, panel: p, actor: "admin:test"});

test("Test button: read-only production check; sandbox credentials refused", async () => {
  const d = db();
  const r = await run("test", d, await client());
  assert.equal(r.status, 200); assert.match(r.body.message, /dostawców: 1/);
  assert.equal(d.ops.find((o) => o.table === "partner_api_credentials").values.last_test_ok, true);
  assert.equal((await run("test", db(), await client("x", "sandbox"))).status, 409);
  const moved = await client(); moved.pinned = "1.68.0";
  const r2 = await run("test", db(), moved);
  assert.equal(r2.status, 409); assert.match(r2.body.error, /wymagane 1\.67\.0/);
});

test("Sync button: catalogue (pay-on-arrival suppliers only, new rows inactive) + terms with panel review fields", async () => {
  const d = db({caravel_release_control: [{singleton: true, certified: false}]});
  const r = await run("sync", d, await client());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.locations, 1); assert.equal(r.body.result.groups, 1);
  assert.equal(r.body.result.terms[0].ok, true);
  assert.ok(d.ops.filter((o) => o.op === "insert" && o.table !== "caravel_reviewed_terms").every((o) => o.rows.every((x) => x.active === false)));
  const stored = d.state.caravel_reviewed_terms[0];
  assert.equal(stored.damage_admin_fee_minor, 10000);
  assert.deepEqual(stored.documented_excluded_codes, ["glass", "tyres_and_wheels", "undercarriage"]);
  assert.ok(!d.ops.some((o) => o.rpc), "sync never opens sales");
  const missing = await run("sync", db({caravel_release_control: [{singleton: true}]}), await client(), {});
  assert.match(missing.body.message, /wymaga uzupełnienia/);
});

test("Activate button: atomic release with certification time and newest reviewed document; Deactivate without supplier", async () => {
  const d = db({caravel_reviewed_terms: [{document_id: "caravel-en-v5", content_hash: "a".repeat(64), approved_at: "x"}]});
  const r = await run("activate", d, await client());
  assert.equal(r.status, 200);
  const call = d.ops.find((o) => o.rpc === "caravel_set_release");
  assert.equal(call.args.p_open, true); assert.equal(call.args.p_certified_at, panel.certified_at);
  assert.equal(call.args.p_document_id, "caravel-en-v5");
  assert.equal((await run("activate", db(), await client())).status, 409, "no reviewed terms -> blocked");
  assert.equal((await run("activate", db({caravel_reviewed_terms: [{document_id: "d", content_hash: "a".repeat(64)}]}), await client(), {})).status, 409, "no certification date -> blocked");
  const off = db();
  assert.equal((await run("deactivate", off, null)).status, 200);
  assert.equal(off.ops[0].args.p_open, false);
});

test("auto-sync: unchanged terms keep selling; new terms version is stored and sales pause until Activate", async () => {
  const s = await releasedState({caravel_reviewed_terms: [await termsRow()]});
  const same = db(structuredClone(s));
  const r1 = await runCaravelAutoSync({admin: same, client: await client()});
  assert.equal(r1.release_open, true);
  assert.equal(r1.suppliers[0].terms.changed, false);
  assert.ok(!same.ops.some((o) => o.rpc));
  assert.ok(same.ops.filter((o) => o.op === "insert").every((o) => o.rows.every((x) => x.active === true)), "new catalogue rows go live while released");
  const changed = db(structuredClone(s));
  const r2 = await runCaravelAutoSync({admin: changed, client: await client("caravel-en-v6")});
  assert.equal(r2.suppliers[0].terms.changed, true);
  assert.equal(r2.suppliers[0].terms.stored.ok, true, "re-verified with previous review parameters");
  assert.equal(changed.ops.find((o) => o.rpc).args.p_open, false, "sales paused");
  assert.match(changed.ops.find((o) => o.table === "partners").values.api_last_error, /CARAVEL_TERMS_CHANGED/);
});

test("admin panel stays AVIA-simple: one provider option + one provider-only panel, no new buttons or tabs", () => {
  const html = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(html, /<option value="caravel">Caravel Channel API<\/option>/);
  const panel = html.slice(html.indexOf('<div id="caravel-review-panel"'), html.indexOf('<div id="api-test-status"'));
  assert.ok(panel.length > 0 && panel.includes('style="display:none;'), "hidden unless provider = caravel");
  assert.doesNotMatch(panel, /<button/i, "no extra technical buttons");
  const footer = html.slice(html.indexOf('<button onclick="closeApiPartnerModal()" class="btn-danger">Zamknij</button>'),
    html.indexOf('<button onclick="saveApiConfiguration()" class="btn-primary">'));
  assert.equal((footer.match(/<button/g) || []).length, 5, "same footer buttons as before");
  assert.equal((html.match(/caravel/gi) || []).length < 40, true);
  assert.doesNotMatch(html, /onclick="[^"]*[Cc]aravel/, "no Caravel-specific click handlers");
  const api = readFileSync(new URL("../supabase/functions/api-partner-admin/index.ts", import.meta.url), "utf8");
  assert.match(api, /partner\.id === CARAVEL_PARTNER_ID && partner\.api_provider === "caravel"/);
});
