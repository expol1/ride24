// Unit tests with a MOCKED Caravel sandbox — they check the acceptance flow code
// (supabase/functions/_shared/caravel-acceptance.mjs), not the real API.
import test from "node:test";
import assert from "node:assert/strict";
import {runCaravelAcceptance} from "../supabase/functions/_shared/caravel-acceptance.mjs";

const KEY = "FAKE-KEY-FOR-UNIT-TESTS-acceptance-000";
const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });

function sandboxMock() {
  const calls = [];
  const m = (amount, currency) => ({amount, currency});
  const SUP = [{supplier_id: "acct_gbp", name: "G", status: "active", currency: "GBP", tax_inclusive: true, payment_models: ["pay_on_arrival", "partial", "prepaid"]},
    {supplier_id: "acct_eur", name: "E", status: "active", currency: "EUR", tax_inclusive: true, payment_models: ["pay_on_arrival", "partial", "prepaid"]}];
  const cur = (sid) => SUP.find(s => s.supplier_id === sid)?.currency ?? "EUR";
  const prot = (sid) => ({protection_id: `prot-${sid}`, vehicle_id: `veh-${sid}`, tier: "premium", excess: m(0, cur(sid)), deposit: m(0, cur(sid)),
    theft_excess: m(0, cur(sid)), product_type: "waiver", covers: ["glass", "undercarriage", "tyres_and_wheels", "theft", "fire"], excludes: []});
  const row = (sid) => ({supplier_id: sid, vehicle_id: `veh-${sid}`, display_name: "Golf or similar", acriss: "CDMR", plan: "premium", protection: prot(sid),
    line_items: [], min_driver_age: 21, max_driver_age: 75, seats: 5, large_bags: 1, small_bags: 1, transmission: "manual", fuel: "petrol", images: []});
  const quotes = new Map(), bookings = new Map(), idem = new Map(), consumed = new Set();
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const route = (method, path, sid, key, body) => {
    if (path === "/v1/capabilities") return [200, {environment: "sandbox", api_version: "1.67.0"}];
    if (path === "/v1/whoami") return [200, {scopes: ["read:reference"], opt_ins: {}}];
    if (path === "/v1/suppliers") return [200, SUP];
    if (path === "/v1/reference/constants") return [200, {}];
    if (path === "/v1/reference/locations") return [200, [{supplier_id: sid, location_id: `loc-${sid}`, type: "airport", name: "Airport", address: {country: "HR"},
      timezone: "Europe/Zagreb", hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => ({day, open: "08:00", close: "20:00"}))}]];
    if (path === "/v1/reference/policies") return [200, [{mileage: {type: "unlimited"}, deposit_payment_methods: []}]];
    if (path === "/v1/reference/vehicles") return [200, [row(sid)]];
    if (path === "/v1/reference/protections") return [200, [prot(sid)]];
    if (path === "/v1/reference/extras" || path === "/v1/reference/fees") return [200, []];
    if (path === "/v1/availability") return [200, [row(sid)]];
    if (path === "/v1/quote") {
      const sig = JSON.stringify(body);
      if (idem.has(key)) return idem.get(key).sig === sig ? [200, quotes.get(idem.get(key).id)] : [409, null, "idempotency_key_reused"];
      if (body.vehicle_id.startsWith("ride24-nonexistent")) return [422, null, "validation_error"];
      const q = {currency: cur(sid), rental_days: 3, quote_id: uuid(), plan: body.plan ?? "premium", status: "active", expires_at: new Date(Date.now() + 600000).toISOString(),
        line_items: [{kind: "base_rate", code: "T", total: m(12000, cur(sid))}], totals: {grand_total: m(12000, cur(sid)), pay_now: m(0, cur(sid)), pay_at_pickup: m(12000, cur(sid))},
        deposit: {amount: m(0, cur(sid)), type: "pre_authorization"}};
      quotes.set(q.quote_id, q); idem.set(key, {sig, id: q.quote_id});
      return [201, q];
    }
    if (path === "/v1/bookings" && method === "POST") {
      if (idem.has(key)) return [200, bookings.get(idem.get(key).id)];
      if (consumed.has(body.quote_id)) return [409, null, "quote_consumed"];
      consumed.add(body.quote_id);
      const b = {booking_id: uuid(), quote_id: body.quote_id, status: "confirmed", revision: 1, price: {totals: {grand_total: quotes.get(body.quote_id).totals.grand_total}},
        protection: {excess: m(0, cur(sid)), deposit: m(0, cur(sid))}, payment: {model: body.payment_model, amount_on_arrival: quotes.get(body.quote_id).totals.grand_total}};
      bookings.set(b.booking_id, b); idem.set(key, {id: b.booking_id});
      return [201, b];
    }
    const get = path.match(/^\/v1\/bookings\/([^/]+)$/);
    if (get) return [200, bookings.get(decodeURIComponent(get[1]))];
    const cancel = path.match(/^\/v1\/bookings\/([^/]+)\/cancel$/);
    if (cancel) {
      const b = bookings.get(decodeURIComponent(cancel[1]));
      if (b.status === "cancelled") return body.expected_revision === b.revision ? [200, b] : [409, null, "invalid_transition"];
      Object.assign(b, {status: "cancelled", revision: b.revision + 1, cancellation: {fee: m(0, cur(sid)), refund: m(0, cur(sid))}});
      return [200, b];
    }
    return [404, null, "not_found"];
  };
  globalThis.fetch = async (url, options) => {
    const u = new URL(String(url));
    const h = options?.headers ?? {};
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({host: u.host, method: options?.method, path: u.pathname, body, key: h["X-API-Key"]});
    const [status, data, code] = route(options?.method ?? "GET", u.pathname, h["X-Supplier-Id"], h["Idempotency-Key"], body);
    return new Response(JSON.stringify(status < 400 ? {request_id: "mock", data, meta: {}} : {error: {code, request_id: "mock"}}), {status});
  };
  return {calls, bookings};
}

test("no key: skipped, no network", async () => {
  const {calls} = sandboxMock();
  const r = await runCaravelAcceptance("", {booking: true});
  assert.equal(r.results[0].outcome, "SKIPPED");
  assert.equal(calls.length, 0);
});

test("full flow at both suppliers: sandbox host only, pay_on_arrival, invented data, every booking cancelled, key never returned", async () => {
  const {calls, bookings} = sandboxMock();
  const r = await runCaravelAcceptance(KEY, {booking: true, runId: "unit"});
  assert.equal(r.failed, false, JSON.stringify(r.results.filter(x => !x.outcome.startsWith("OK"))));
  assert.ok(calls.every(c => c.host === "sandbox-api.caravelway.com"));
  const creates = calls.filter(c => c.method === "POST" && c.path === "/v1/bookings");
  assert.ok(creates.length >= 2);
  for (const c of creates) {
    assert.equal(c.body.payment_model, "pay_on_arrival");
    assert.match(c.body.external_ref, /^ride24-sandbox-/);
    assert.equal(c.body.customer.email, "sandbox-ci@example.test");
  }
  assert.equal(bookings.size, 2); // one per supplier (replays and the 409 probe create nothing)
  assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
  for (const sid of ["acct_gbp", "acct_eur"]) {
    assert.ok(r.results.some(x => x.endpoint.includes("POST /v1/bookings (pay_on_arrival)") && x.endpoint.includes(sid.slice(0, 8))), sid);
  }
  assert.equal(JSON.stringify(r).includes(KEY), false);
});

test("booking=false never calls booking endpoints", async () => {
  const {calls} = sandboxMock();
  const r = await runCaravelAcceptance(KEY, {booking: false});
  assert.equal(r.failed, false);
  assert.equal(calls.some(c => c.path.startsWith("/v1/bookings")), false);
});

test("a booking left open by a failure is cancelled by the cleanup pass", async () => {
  const {bookings} = sandboxMock();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    // Fail the first regular cancel once: the cleanup pass must still cancel the booking.
    if (String(url).includes("/cancel") && !globalThis.__failedOnce) { globalThis.__failedOnce = true; return new Response(JSON.stringify({error: {code: "service_unavailable"}}), {status: 503}); }
    return inner(url, options);
  };
  try {
    const r = await runCaravelAcceptance(KEY, {booking: true});
    assert.equal(r.failed, true); // the failed cancel is reported
    assert.ok(r.results.some(x => x.endpoint.startsWith("cleanup cancel")));
    assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
  } finally { delete globalThis.__failedOnce; }
});

test("time budget stops new steps but never the cleanup", async () => {
  sandboxMock();
  const r = await runCaravelAcceptance(KEY, {booking: true, budgetMs: -1});
  assert.ok(r.results.every(x => x.outcome.startsWith("NOT RUN")));
});
