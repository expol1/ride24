// Unit tests with MOCKED fetch — they check the diagnostics code, not the real Caravel API.
import test from "node:test";
import assert from "node:assert/strict";
import {runCaravelDiagnostics} from "../supabase/functions/_shared/caravel-diagnostics.ts";

const KEY = "ck_test_SECRET_VALUE_should_never_leak_123";
const NOW = 1900000000000;
const eur = (amount) => ({amount, currency: "EUR"});
const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });

const routes = {
  "/v1/capabilities": {environment: "sandbox", api_version: "1.67.0"},
  "/v1/whoami": {scopes: ["read:reference", "read:availability"], currency: "EUR", opt_ins: {availability_plans: true}},
  "/v1/suppliers": [{supplier_id: "sup-1", name: "S", status: "active", currency: "EUR", tax_inclusive: true}],
  "/v1/reference/locations": [{supplier_id: "sup-1", location_id: "loc-1", type: "airport", name: "Airport", address: {country: "HR"}, timezone: "Europe/Zagreb", hours: [{day: "mon", open: "08:00", close: "20:00"}], out_of_hours: {available: true, fee: eur(3000)}}],
  "/v1/reference/policies": [{mileage: {type: "unlimited"}, deposit_payment_methods: []}],
  "/v1/reference/vehicles": [{supplier_id: "sup-1", vehicle_id: "v1", acriss: "CDMR", display_name: "Golf or similar", seats: 5, large_bags: 1, small_bags: 1, transmission: "manual", fuel: "petrol", min_driver_age: 21, max_driver_age: 75}],
  "/v1/reference/protections": [{tier: "premium", excess: eur(0), deposit: eur(0)}],
  "/v1/reference/extras": [{extra_id: "e", name: "Seat", category: "child_seat", pricing_type: "per_day", unit_price: eur(500), price_cap: null, quantity: {min: 0, max: 1, default: 0}, requires_quantity: false, payable: "at_pickup"}],
  "/v1/reference/fees": [{type: "out_of_hours"}],
  "/v1/availability": [{plan: "premium", protection: {excess: eur(0), deposit: eur(0)}, line_items: [{kind: "fee", type: "out_of_hours"}]}],
};
function mock({status = () => 200, body} = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const u = new URL(String(url));
    calls.push({host: u.host, path: u.pathname, method: options?.method, key: options?.headers?.["X-API-Key"]});
    const s = status(u.pathname);
    const payload = body ? body(u.pathname, s) : (s === 200 ? {request_id: "r", data: routes[u.pathname], meta: {}} : {error: {code: "x", request_id: "r"}});
    return new Response(JSON.stringify(payload), {status: s, headers: {"content-type": "application/json"}});
  };
  return calls;
}

test("missing secret is reported without any network call", async () => {
  const calls = mock();
  const r = await runCaravelDiagnostics(undefined, {nowEpochMs: NOW});
  assert.deepEqual(r, {secret_present: false, sandbox_only: true, blocker: "MISSING_SECRET", steps: []});
  assert.equal(calls.length, 0);
});

test("full read-only pass: only GET, only the sandbox host, key never in the result", async () => {
  const calls = mock();
  const r = await runCaravelDiagnostics(KEY, {nowEpochMs: NOW});
  assert.equal(r.blocker, null, JSON.stringify(r.steps.filter(s => s.outcome !== "OK")));
  assert.equal(r.steps.length, 11);
  assert.ok(calls.every(c => c.method === "GET" && c.host === "sandbox-api.caravelway.com"));
  assert.ok(!calls.some(c => /quote|bookings|credentials|webhooks/.test(c.path)));
  assert.equal(JSON.stringify(r).includes(KEY), false);
  const loc = r.steps.find(s => s.endpoint === "GET /v1/reference/locations").summary;
  assert.deepEqual(loc.weekday_values, ["mon"]);
  assert.equal(r.steps.find(s => s.endpoint.startsWith("GET /v1/availability (night")).summary.fee_types.out_of_hours, 1);
});

test("blockers are classified from the real HTTP outcome", async () => {
  const cases = [
    [() => 401, "INVALID_KEY"],
    [(p) => (p === "/v1/capabilities" ? 200 : 403), "FORBIDDEN_SCOPE_OR_IP"],
    [(p) => (p === "/v1/reference/locations" ? 503 : 200), "API_ERROR"],
  ];
  for (const [status, blocker] of cases) {
    mock({status});
    const r = await runCaravelDiagnostics(KEY, {nowEpochMs: NOW});
    assert.equal(r.blocker, blocker);
  }
  mock({body: (p) => (p === "/v1/capabilities" ? {data: {environment: "production"}} : {data: []})});
  assert.equal((await runCaravelDiagnostics(KEY, {nowEpochMs: NOW})).blocker, "NOT_SANDBOX");
  mock();
  const unknownSupplier = await runCaravelDiagnostics(KEY, {supplierId: "nope", nowEpochMs: NOW});
  assert.equal(unknownSupplier.blocker, "SUPPLIER");
  assert.equal((await runCaravelDiagnostics(KEY, {supplierId: "bad id!", nowEpochMs: NOW})).blocker, "SUPPLIER");
});

test("network failure is classified as NETWORK_OR_DNS", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const r = await runCaravelDiagnostics(KEY, {nowEpochMs: NOW});
  assert.equal(r.blocker, "NETWORK_OR_DNS");
  assert.equal(r.steps[0].outcome, "NETWORK_ERROR");
});

test("a key echoed back in an upstream error message is scrubbed", async () => {
  globalThis.fetch = async () => { throw new Error(`boom ${KEY}`); };
  const r = await runCaravelDiagnostics(KEY, {nowEpochMs: NOW});
  assert.equal(JSON.stringify(r).includes(KEY), false);
  assert.match(r.steps[0].error_code, /\*\*\*/);
});
