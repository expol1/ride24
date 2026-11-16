// Unit tests with a MOCKED Caravel sandbox — they check the acceptance flow code
// (supabase/functions/_shared/caravel-acceptance.mjs), not the real API.
import test from "node:test";
import assert from "node:assert/strict";
import {runCaravelAcceptance} from "../supabase/functions/_shared/caravel-acceptance.mjs";

const KEY = "FAKE-KEY-FOR-UNIT-TESTS-acceptance-000";
const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });

function sandboxMock({premiumDepositMinor = 0, premiumExcessMinor = 0, availabilityPlan = "premium", protectionPricingType = "included", bookingPayment = "present", twoVehicles = false, unknownLocation = false} = {}) {
  const calls = [];
  let shrink = false;
  const m = (amount, currency) => ({amount, currency});
  const SUP = [{supplier_id: "acct_gbp", name: "G", status: "active", currency: "GBP", tax_inclusive: true, payment_models: ["pay_on_arrival", "partial", "prepaid"]},
    {supplier_id: "acct_eur", name: "E", status: "active", currency: "EUR", tax_inclusive: true, payment_models: ["pay_on_arrival", "partial", "prepaid"]}];
  const cur = (sid) => SUP.find(s => s.supplier_id === sid)?.currency ?? "EUR";
  const prot = (sid) => ({protection_id: `prot-${sid}`, vehicle_id: `veh-${sid}`, tier: "premium", pricing_type: protectionPricingType, code: "INS_PREMIUM", excess: m(premiumExcessMinor, cur(sid)), deposit: m(premiumDepositMinor, cur(sid)),
    theft_excess: m(0, cur(sid)), product_type: "waiver", covers: ["glass", "undercarriage", "tyres_and_wheels", "theft", "fire"], excludes: []});
  const row = (sid) => ({supplier_id: sid, vehicle_id: `veh-${sid}`, display_name: "Golf or similar", acriss: "CDMR", plan: availabilityPlan, protection: prot(sid),
    line_items: [], min_driver_age: 21, max_driver_age: 75, seats: 5, large_bags: 1, small_bags: 1, transmission: "manual", fuel: "petrol", images: []});
  const quotes = new Map(), bookings = new Map(), idem = new Map(), consumed = new Set();
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const route = (method, path, sid, key, body) => {
    if (path === "/v1/capabilities") return [200, {environment: "sandbox", api_version: "1.67.0"}];
    if (path === "/v1/whoami") return [200, {scopes: ["read:reference"], opt_ins: {}}];
    if (path === "/v1/suppliers") return [200, SUP];
    if (path === "/v1/reference/constants") return [200, {}];
    if (path === "/v1/reference/locations") return [200, [
      {supplier_id: sid, location_id: `loc-${sid}`, type: "airport", name: "Airport", address: {country: "HR"},
        timezone: "Europe/Zagreb", hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => ({day, open: "08:00", close: "20:00"}))},
      ...(unknownLocation ? [{supplier_id: sid, location_id: `loc-unknown-${sid}`, type: "future-unknown-location-type",
        name: "Unnamed fixture", address: {country: "HR"}, timezone: "Europe/Zagreb"}] : []),
    ]];
    if (path === "/v1/reference/policies") return [200, [{mileage: {type: "unlimited"}, deposit_payment_methods: []}]];
    if (path === "/v1/reference/vehicles") return [200, [row(sid),
      ...(twoVehicles && !shrink ? [{...row(sid), vehicle_id: `veh-second-${sid}`, display_name: "Renamed test vehicle"}] : []),
    ]];
    if (path === "/v1/reference/protections") return [200, [prot(sid),
      ...(twoVehicles && !shrink ? [{...prot(sid), vehicle_id: `veh-second-${sid}`, protection_id: `prot-second-${sid}`}] : []),
    ]];
    if (path === "/v1/reference/extras" || path === "/v1/reference/fees") return [200, []];
    if (path === "/v1/availability") return [200, [row(sid)]];
    if (path === "/v1/quote") {
      const sig = JSON.stringify(body);
      if (idem.has(key)) return idem.get(key).sig === sig ? [200, quotes.get(idem.get(key).id)] : [409, null, "idempotency_key_reused"];
      if (body.vehicle_id.startsWith("ride24-nonexistent")) return [422, null, "validation_error"];
      const q = {currency: cur(sid), rental_days: 3, quote_id: uuid(), plan: body.plan ?? "premium", status: "active", expires_at: new Date(Date.now() + 600000).toISOString(),
        line_items: [{kind: "base_rate", code: "T", total: m(12000, cur(sid))}, {kind: "protection", code: "INS_PREMIUM", total: m(0, cur(sid))}], totals: {grand_total: m(12000, cur(sid)), pay_now: m(0, cur(sid)), pay_at_pickup: m(12000, cur(sid))},
        deposit: {amount: m(premiumDepositMinor, cur(sid)), type: "pre_authorization"}};
      quotes.set(q.quote_id, q); idem.set(key, {sig, id: q.quote_id});
      return [201, q];
    }
    if (path === "/v1/bookings" && method === "POST") {
      if (idem.has(key)) return [200, bookings.get(idem.get(key).id)];
      if (consumed.has(body.quote_id)) return [409, null, "quote_consumed"];
      consumed.add(body.quote_id);
      const b = {booking_id: uuid(), quote_id: body.quote_id, status: "confirmed", revision: 1, price: {totals: {grand_total: quotes.get(body.quote_id).totals.grand_total}},
        protection: {excess: m(premiumExcessMinor, cur(sid)), deposit: m(premiumDepositMinor, cur(sid))}, payment: {model: body.payment_model, amount_on_arrival: quotes.get(body.quote_id).totals.grand_total}};
      if (bookingPayment === "absent") delete b.payment;
      if (bookingPayment === "prepaid") b.payment.model = "prepaid";
      if (bookingPayment === "wrong_amount") b.payment.amount_on_arrival = m(11999, cur(sid));
      bookings.set(b.booking_id, b); idem.set(key, {id: b.booking_id});
      return [201, b];
    }
    const get = path.match(/^\/v1\/bookings\/([^/]+)$/);
    if (get) return [200, bookings.get(decodeURIComponent(get[1]))];
    const cancel = path.match(/^\/v1\/bookings\/([^/]+)\/cancel$/);
    if (cancel) {
      const b = bookings.get(decodeURIComponent(cancel[1]));
      // Confirmed live Caravel behavior: second cancellation is HTTP 200 even
      // if the request carries the pre-cancel revision.
      if (b.status === "cancelled") return [200, b];
      if (body.expected_revision !== b.revision) return [409, null, "revision_conflict"];
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
  return {calls, bookings, setShrink: (next) => {shrink = Boolean(next);}};
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
  assert.equal(r.results.filter(x => x.endpoint.includes("wrong revision (expect revision_conflict)") && x.outcome.includes("revision_conflict")).length, 2);
  assert.equal(r.results.filter(x => x.endpoint.includes("after revision conflict") && x.summary?.state_preserved === true).length, 2);
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
    assert.equal(r.results.some(x => x.outcome === "ERROR UNCANCELLED_BOOKINGS"), false);
    assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
  } finally { delete globalThis.__failedOnce; }
});

test("time budget stops new steps but never the cleanup", async () => {
  sandboxMock();
  const r = await runCaravelAcceptance(KEY, {booking: true, budgetMs: -1});
  assert.ok(r.results.every(x => x.outcome.startsWith("NOT RUN")));
});

test("supplier_id scope: only that supplier is walked and booked", async () => {
  const {calls, bookings} = sandboxMock();
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur"});
  assert.equal(r.failed, false, JSON.stringify(r.results.filter(x => !x.outcome.startsWith("OK"))));
  const scoped = calls.filter(c => c.path.startsWith("/v1/reference/locations") || c.path === "/v1/availability" || c.path === "/v1/quote" || c.path.startsWith("/v1/bookings"));
  assert.ok(scoped.length > 0);
  assert.equal(bookings.size, 1);
  assert.ok(!r.results.some(x => x.endpoint.includes("acct_gbp")));
});

test("unknown supplier_id is refused before any supplier-scoped call", async () => {
  const {calls} = sandboxMock();
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_unknown"});
  assert.equal(r.failed, true);
  assert.ok(r.results.some(x => x.outcome === "ERROR SUPPLIER_NOT_VISIBLE"));
  // constants are operator-wide; nothing supplier-scoped may follow an unknown supplier
  assert.equal(calls.some(c => (c.path.startsWith("/v1/reference/") && c.path !== "/v1/reference/constants") || c.path.startsWith("/v1/bookings") || c.path === "/v1/availability"), false);
});

test("premiumOnly: an offer failing the Premium policy is quoted for evidence but never booked", async () => {
  const {calls, bookings} = sandboxMock({premiumDepositMinor: 25000});
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", premiumOnly: true});
  assert.equal(bookings.size, 0);
  assert.equal(calls.some(c => c.method === "POST" && c.path === "/v1/bookings"), false);
  assert.ok(r.results.some(x => x.outcome === "NOT RUN" && String(x.summary).includes("premiumOnly")));
});

test("sandbox mechanics books fictional nonzero Premium and cancels, without marking it publishable", async () => {
  const {calls, bookings} = sandboxMock({premiumDepositMinor: 30000, premiumExcessMinor: 45000});
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", sandboxPremiumMechanics: true});
  assert.equal(r.failed, false, JSON.stringify(r.results.filter(x => !x.outcome.startsWith("OK"))));
  assert.equal(bookings.size, 1);
  assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
  assert.ok(calls.every(c => c.host === "sandbox-api.caravelway.com"));
  const premiumQuote = calls.find(c => c.path === "/v1/quote" && c.body?.plan === "premium");
  assert.ok(premiumQuote);
  assert.equal(premiumQuote.body.protection_id, "prot-acct_eur");
  const bookingResult = r.results.find(x => x.endpoint.includes("POST /v1/bookings (pay_on_arrival)"));
  assert.equal(bookingResult.outcome, "OK");
  assert.equal(bookingResult.summary.publishable, false);
  assert.deepEqual(bookingResult.summary.sandbox_only_advisories, ["BOOKED_PROTECTION_NOT_ZERO_RISK"]);
  assert.equal(bookingResult.summary.matches_quote, true);
});

test("sandbox mechanics refuses Medium and non-included protection", async () => {
  for (const patch of [{availabilityPlan: "medium"}, {protectionPricingType: "optional"}]) {
    const {calls, bookings} = sandboxMock({...patch, premiumDepositMinor: 30000});
    const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", sandboxPremiumMechanics: true});
    assert.equal(bookings.size, 0);
    assert.equal(calls.some(c => c.path === "/v1/bookings" && c.method === "POST"), false);
    assert.ok(r.results.some(x => x.outcome === "NOT RUN" && String(x.summary).includes("included protection")));
  }
});

test("sandbox mechanics cannot bypass premiumOnly and cannot book when booking=false", async () => {
  const {calls} = sandboxMock({premiumDepositMinor: 30000});
  await assert.rejects(
    () => runCaravelAcceptance(KEY, {booking: true, premiumOnly: false, sandboxPremiumMechanics: true}),
    /INVALID_SANDBOX_MECHANICS_CONFIG/,
  );
  const r = await runCaravelAcceptance(KEY, {booking: false, supplierId: "acct_eur", sandboxPremiumMechanics: true});
  assert.equal(calls.some(c => c.path === "/v1/bookings" && c.method === "POST"), false);
  assert.equal(r.failed, false);
});

test("sandbox mechanics never waives quote-price integrity or confirmation", async () => {
  const {calls, bookings} = sandboxMock({premiumDepositMinor: 30000, premiumExcessMinor: 45000});
  const normal = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const res = await normal(url, options);
    if (new URL(String(url)).pathname !== "/v1/bookings" || options?.method !== "POST") return res;
    const clone = await res.clone().json();
    if (clone?.data?.status === "confirmed") {
      clone.data.price.totals.grand_total.amount += 1;
      return new Response(JSON.stringify(clone), {status: res.status});
    }
    return res;
  };
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", sandboxPremiumMechanics: true});
  assert.equal(r.failed, true);
  assert.ok(r.results.some(x => String(x.outcome).includes("BOOKED_PRICE_DIFFERS_FROM_QUOTE")));
  assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
});

test("sandbox cleanup reports unresolved bookings if cancellation repeatedly fails", async () => {
  const {bookings} = sandboxMock();
  const normal = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).includes("/cancel")
    ? Promise.resolve(new Response(JSON.stringify({error: {code: "service_unavailable"}}), {status: 503}))
    : normal(url, options);
  const result = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur"});
  assert.equal(result.failed, true);
  const unresolved = result.results.find(x => x.outcome === "ERROR UNCANCELLED_BOOKINGS");
  assert.ok(unresolved);
  assert.equal(unresolved.summary.length, 1);
  assert.equal(unresolved.summary[0].supplier_id, "acct_eur");
  assert.ok([...bookings.values()].some(b => b.status !== "cancelled"));
});

test("real API shape: Booking.payment can be absent when pay_on_arrival defaulted", async () => {
  const {calls, bookings} = sandboxMock({premiumDepositMinor: 30000, premiumExcessMinor: 10000, bookingPayment: "absent"});
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", sandboxPremiumMechanics: true});
  assert.equal(r.failed, false, JSON.stringify(r.results.filter(x => !x.outcome.startsWith("OK"))));
  assert.equal(bookings.size, 1);
  assert.ok([...bookings.values()].every(b => b.status === "cancelled" && b.payment === undefined));
  const booking = r.results.find(x => x.endpoint.includes("POST /v1/bookings (pay_on_arrival)"));
  assert.equal(booking.outcome, "OK");
  assert.equal(booking.summary.requested_payment_model, "pay_on_arrival");
  assert.equal(booking.summary.booking_payment_model, "not stated (optional)");
  assert.equal(booking.summary.matches_quote, true);
  assert.equal(booking.summary.grand_total.currency, "EUR");
  assert.ok(booking.summary.booking_id);
  const replay = r.results.find(x => x.endpoint.includes("cancel again (idempotent, prior revision)"));
  assert.equal(replay.outcome, "OK");
  assert.equal(replay.summary.revision, 2);
  assert.equal(calls.filter(x => x.path.endsWith("/cancel") && x.method === "POST").length, 3); // wrong active revision + valid cancel + idempotent replay
  assert.ok(r.results.some(x => x.endpoint.includes("wrong revision (expect revision_conflict)") && x.outcome.includes("revision_conflict")));
  assert.ok(r.results.some(x => x.endpoint.includes("after revision conflict") && x.summary?.state_preserved));
});

test("present contradictory Booking.payment model remains a hard verification error with evidence", async () => {
  for(const payment of ["prepaid", "wrong_amount"]){
    const {bookings} = sandboxMock({premiumDepositMinor: 30000, bookingPayment: payment});
    const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", sandboxPremiumMechanics: true});
    assert.equal(r.failed, true);
    const booking = r.results.find(x => x.endpoint.includes("POST /v1/bookings (pay_on_arrival)"));
    assert.ok(booking.summary?.booking_id);
    assert.equal(booking.summary?.grand_total?.currency, "EUR");
    assert.equal(booking.summary?.matches_quote, false);
    assert.ok(booking.summary?.verification_errors.includes(payment === "prepaid"
      ? "PAYMENT_MODEL_NOT_PAY_ON_ARRIVAL" : "AMOUNT_ON_ARRIVAL_DIFFERS"));
    assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
  }
});

test("a mismatched booked price is reported with the booking ID and amount before cleanup", async () => {
  const {bookings} = sandboxMock({premiumDepositMinor: 30000});
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await fetchReal(url, options);
    if (new URL(String(url)).pathname !== "/v1/bookings" || options?.method !== "POST") return response;
    const payload = await response.clone().json();
    if (payload?.data?.status === "confirmed") {
      payload.data.price.totals.grand_total.amount += 100;
      return new Response(JSON.stringify(payload), {status: response.status});
    }
    return response;
  };
  const r = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur", sandboxPremiumMechanics: true});
  assert.equal(r.failed, true);
  const booking = r.results.find(x => x.endpoint.includes("POST /v1/bookings (pay_on_arrival)"));
  assert.ok(booking.summary?.booking_id);
  assert.equal(booking.summary?.grand_total?.amount, 12100);
  assert.ok(booking.summary?.verification_errors.includes("BOOKED_PRICE_DIFFERS_FROM_QUOTE"));
  assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
});

test("opaque-id certification phase quotes BOTH first catalogue vehicles without plan", async () => {
  const {calls} = sandboxMock({twoVehicles: true});
  const result = await runCaravelAcceptance(KEY, {booking: false, supplierId: "acct_eur",
    certificationPhase: "opaque-id-tolerance"});
  assert.equal(result.failed, false, JSON.stringify(result.results.filter(x => x.outcome.startsWith("ERROR"))));
  const servedQuotes = calls.filter(c => c.path === "/v1/quote" &&
    ["veh-acct_eur", "veh-second-acct_eur"].includes(c.body?.vehicle_id) && c.body?.plan === undefined);
  assert.deepEqual(servedQuotes.map(x => x.body.vehicle_id), ["veh-acct_eur", "veh-second-acct_eur"]);
  assert.deepEqual(servedQuotes.map(x => x.body.protection_id), ["prot-acct_eur", "prot-second-acct_eur"]);
  assert.ok(servedQuotes.every(q => !Object.hasOwn(q.body, "plan")));
});

test("unknown-enum certification phase quotes from an unknown-type location without publishing it", async () => {
  const {calls} = sandboxMock({unknownLocation: true});
  const result = await runCaravelAcceptance(KEY, {booking: false, supplierId: "acct_eur",
    certificationPhase: "unknown-enum-value"});
  assert.equal(result.failed, false, JSON.stringify(result.results.filter(x => x.outcome.startsWith("ERROR"))));
  const quote = calls.find(c => c.path === "/v1/quote" && c.body?.pickup?.location_id === "loc-unknown-acct_eur");
  assert.ok(quote, "unknown location must be quoted using its exact opaque ID");
  assert.ok(result.results.some(x => x.endpoint.includes("quote at unknown-type location") && x.outcome === "OK"));
  assert.equal(calls.filter(c => c.path === "/v1/bookings" && c.method === "POST").length, 0);
});

test("shrunk-reference-refresh:2 quotes vanished vehicle from repository persisted across runs", async () => {
  const {calls, setShrink} = sandboxMock({twoVehicles: true});
  const snapshots = new Map();
  const referenceRepository = {
    load: async sid => snapshots.get(sid) ?? null,
    save: async (sid, snapshot) => { snapshots.set(sid, structuredClone(snapshot)); },
  };
  const first = await runCaravelAcceptance(KEY, {booking: false, supplierId: "acct_eur",
    certificationPhase: "shrunk-reference-refresh:1", referenceRepository});
  assert.equal(first.failed, false, JSON.stringify(first.results.filter(x => x.outcome.startsWith("ERROR"))));
  assert.ok(snapshots.get("acct_eur").vehicles.length === 2);
  setShrink(true);
  const before = calls.length;
  const second = await runCaravelAcceptance(KEY, {booking: false, supplierId: "acct_eur",
    certificationPhase: "shrunk-reference-refresh:2", referenceRepository});
  assert.equal(second.failed, false, JSON.stringify(second.results.filter(x => x.outcome.startsWith("ERROR"))));
  const laterCalls = calls.slice(before);
  assert.ok(laterCalls.some(c => c.path === "/v1/quote" && c.body?.vehicle_id === "veh-second-acct_eur"
    && c.body?.protection_id === "prot-second-acct_eur" && !Object.hasOwn(c.body, "plan")));
  const vanished = snapshots.get("acct_eur").vehicles.find(([_, rec]) => rec.id === "veh-second-acct_eur");
  assert.ok(vanished?.[1]?.missing_since);
});

test("shrunk-reference-refresh fails closed without durable repository", async () => {
  const {calls} = sandboxMock({twoVehicles: true});
  const result = await runCaravelAcceptance(KEY, {booking: false, supplierId: "acct_eur",
    certificationPhase: "shrunk-reference-refresh:2"});
  assert.equal(result.failed, true);
  assert.ok(result.results.some(x => x.outcome === "ERROR PERSISTENT_REFERENCE_STORE_REQUIRED"));
  assert.equal(calls.filter(c => c.path === "/v1/quote").length, 0);
});

test("certification unknown-response-field path reads cancelled booking after cancellation", async () => {
  sandboxMock({premiumDepositMinor: 30000});
  const result = await runCaravelAcceptance(KEY, {booking: true, supplierId: "acct_eur",
    sandboxPremiumMechanics: true, certificationPhase: "unknown-response-field"});
  assert.equal(result.failed, false, JSON.stringify(result.results.filter(x => !x.outcome.startsWith("OK"))));
  assert.ok(result.results.some(x => x.endpoint.includes("after cancellation") &&
    x.outcome === "OK" && x.summary?.confirmed_cancelled));
});
