import test from "node:test";
import assert from "node:assert/strict";
import {
  caravelPaidFulfillmentApproved, caravelBookingUuid, revalidatePaidCaravel, createPaidCaravel, readPaidCaravelStatus,
} from "../supabase/functions/_shared/caravel-paid-fulfillment.ts";
import {advanceApiPayment, DefiniteApiFailure} from "../supabase/functions/_shared/api-payment-flow.mjs";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const PARTNER = "78721481-7619-44df-a9b7-5faa344b69bb";
const BOOKING = "0b7d6a34-3f43-4c51-9a8e-2b1e0f6c7d11";
const QUOTE_ROW = "4da4d7ca-7244-4416-ab7b-2632bd5f882a";
const CAR = "d20bbca4-678c-4abf-bf4d-cf5356220170";
const QID = "3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const FRESH_QID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const HASH = "a".repeat(64);
const money = (n = 0) => ({amount: n, currency: "EUR"});
const protection = () => ({protection_id: "pro-premium", tier: "premium", product_type: "waiver", deposit: money(),
  excess: money(), theft_excess: money(), covers: ["bodywork", "theft", "fire"], excludes: ["glass", "tyres_and_wheels", "undercarriage"]});
const providerQuote = () => ({provider: "caravel", quote_id: QID, supplier_id: "acct_eur", vehicle_id: "opaque-group",
  plan: "premium", currency: "EUR", payment_model: "pay_on_arrival", protection_id: "pro-premium", protection: protection(),
  amounts_minor: {total: 15000, pay_now: 0, pay_at_pickup: 15000},
  pickup_at: "2027-01-10T10:00:00+02:00", dropoff_at: "2027-01-13T10:00:00+02:00",
  terms_document_id: "caravel-en-v4", terms_content_hash: HASH, terms_language: "en",
  coverage_exclusions: ["glass", "tyres_and_wheels", "undercarriage"], damage_administration_fee_minor: 10000});
const quoteRow = () => ({id: QUOTE_ROW, booking_id: BOOKING, partner_id: PARTNER, car_class_id: CAR, external_group_id: "opaque-group",
  start_date: "2027-01-10", end_date: "2027-01-13", pickup_location_external_id: "ath-airport", dropoff_location_external_id: "ath-airport",
  raw_response: {provider_quote_data: providerQuote()}});
const booking = () => ({id: BOOKING, partner_id: PARTNER, car_class_id: CAR, api_quote_id: QUOTE_ROW, status: "pending",
  start_date: "2027-01-10", end_date: "2027-01-13", reservation_code: "R24-TEST", partner_currency: "EUR",
  partner_net_price_snapshot: 150, online_payment_pln: 64.5, main_driver_name: "Jan Test Kowalski", main_driver_age: 30,
  client_email: "sandbox@example.test", client_phone: "+48000000000", partners: {api_provider: "caravel"},
  caravel_terms_document_id: "caravel-en-v4", caravel_terms_content_hash: HASH, caravel_terms_language: "en",
  caravel_coverage_supplier_id: "acct_eur", caravel_coverage_quote_id: QID, caravel_coverage_terms_document_id: "caravel-en-v4",
  caravel_coverage_terms_content_hash: HASH, caravel_coverage_excluded_codes: ["undercarriage", "glass", "tyres_and_wheels"],
  caravel_coverage_damage_admin_fee_minor: 10000, caravel_coverage_accepted_at: "2026-11-18T11:55:00Z"});
const creds = () => ({api_key: "prod-key-fixture", api_url: "https://api.caravelway.com"});
const freshQuote = (patch = {}) => ({quote_id: FRESH_QID, status: "active", plan: "premium", currency: "EUR",
  payment_model: "pay_on_arrival", rental_days: 3, expires_at: new Date(NOW + 30 * 60000).toISOString(),
  totals: {grand_total: money(15000), pay_now: money(), pay_at_pickup: money(15000)}, deposit: {amount: money()},
  line_items: [{kind: "base_rate", total: money(15000)}], ...patch});
const confirmed = (key, patch = {}) => ({booking_id: "c0ffee00-1111-4222-8333-444455556666", revision: 1, status: "confirmed",
  quote_id: FRESH_QID, external_ref: `ride24-${key}`, price: {totals: {grand_total: money(15000)}},
  protection: {deposit: money(), excess: money()},
  payment: {model: "pay_on_arrival", amount_on_arrival: money(15000), amount_prepaid: money()}, ...patch});

function fakeFactory(state) {
  return (apiKey, writes) => {
    state.clients.push({apiKey, writes});
    return {
      environment: "production",
      async referenceTerms(s) { state.calls.push(["terms", s]); return {data: state.terms}; },
      async suppliers() { state.calls.push(["suppliers"]); return {data: [{supplier_id: "acct_eur", status: "active", currency: "EUR", tax_inclusive: true, payment_models: ["pay_on_arrival"]}]}; },
      async quote(req, key, s) { state.calls.push(["quote", key, s, req]); return {data: state.fresh}; },
      async book(req, key, s) { state.calls.push(["book", key, s, req]); if (state.bookThrows) throw new Error("network"); return {data: state.booked(key)}; },
      async bookingStatusSandbox(ref, s) { state.calls.push(["status", ref, s]); return {data: state.status}; },
    };
  };
}
const newState = () => ({clients: [], calls: [], fresh: freshQuote(),
  terms: [{document_id: "caravel-en-v4", language: "en", content_hash: HASH, withdrawn_at: null}], booked: (k) => confirmed(k)});
const withFlags = async (flags, fn) => {
  const prev = globalThis.Deno;
  globalThis.Deno = {env: {get: (k) => flags[k]}};
  try { return await fn(); } finally { if (prev === undefined) delete globalThis.Deno; else globalThis.Deno = prev; }
};
const ON = {CARAVEL_PRODUCTION_WRITES_ALLOWED: "true", CARAVEL_STRIPE_FIRST_APPROVED: "true"};

test("disabled by default: no flags -> ADAPTER_NOT_READY before any supplier call", async () => {
  assert.equal(caravelPaidFulfillmentApproved(() => undefined), false);
  assert.equal(caravelPaidFulfillmentApproved((k) => k === "CARAVEL_PRODUCTION_WRITES_ALLOWED" ? "true" : undefined), false);
  const state = newState();
  await assert.rejects(() => revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state)}), /ADAPTER_NOT_READY/);
  await assert.rejects(() => createPaidCaravel(creds(), {provider: "caravel"}, {factory: fakeFactory(state)}), /ADAPTER_NOT_READY/);
  assert.equal(state.calls.length, 0);
});

test("stable booking-derived idempotency key: same booking -> same UUID; purposes differ", async () => {
  const a = await caravelBookingUuid(BOOKING, "book"), b = await caravelBookingUuid(BOOKING, "book");
  assert.equal(a, b);
  assert.notEqual(a, await caravelBookingUuid(BOOKING, "quote"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("revalidate: accepted terms + consent + unchanged fresh quote -> prepared booking with derived key", () => withFlags(ON, async () => {
  const state = newState();
  const prepared = await revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state), nowMs: NOW});
  const key = await caravelBookingUuid(BOOKING, "book");
  assert.equal(prepared.idempotency_key, key);
  assert.equal(prepared.external_ref, `ride24-${key}`);
  assert.equal(prepared.quote_id, FRESH_QID);
  assert.equal(prepared.total_minor, 15000);
  assert.deepEqual(prepared.main_driver, {first_name: "Jan Test", last_name: "Kowalski", age: 30});
  assert.deepEqual(state.clients.map((c) => c.writes), [false], "revalidation never gets write permission");
  const q = state.calls.find((c) => c[0] === "quote");
  assert.equal(q[1], await caravelBookingUuid(BOOKING, "quote"));
  assert.equal(q[3].plan, "premium");
  assert.equal(q[3].pickup.at, "2027-01-10T10:00:00+02:00");
  assert.ok(!state.calls.some((c) => c[0] === "book"));
}));

for (const [name, mutate, code] of [
  ["missing consent", (b) => { b.caravel_coverage_accepted_at = null; }, /CONSENT_MISSING_OR_STALE/],
  ["consent for another terms hash", (b) => { b.caravel_terms_content_hash = "b".repeat(64); }, /CONSENT_MISSING_OR_STALE/],
  ["undisclosed exclusion", (b) => { b.caravel_coverage_excluded_codes = ["glass"]; }, /CONSENT_MISSING_OR_STALE/],
  ["admin fee not as accepted", (b) => { b.caravel_coverage_damage_admin_fee_minor = 0; }, /CONSENT_MISSING_OR_STALE/],
  ["Stripe fee missing (double-prepayment guard)", (b) => { b.online_payment_pln = 0; }, /ACCEPTED_QUOTE_MISMATCH/],
  ["rental amount differs from quote", (b) => { b.partner_net_price_snapshot = 160; }, /ACCEPTED_QUOTE_MISMATCH/],
  ["cancelled before dispatch", (b) => { b.status = "cancelled"; }, /CANCELLED_BEFORE_DISPATCH/],
  ["additional driver unsupported", (b) => { b.add_driver_name = "X Y"; }, /DRIVER_DETAILS_UNSUPPORTED/],
]) test(`revalidate refuses (definitive, refund path): ${name}`, () => withFlags(ON, async () => {
  const state = newState(); const b = booking(); mutate(b);
  const err = await revalidatePaidCaravel(creds(), b, quoteRow(), {factory: fakeFactory(state), nowMs: NOW}).catch((e) => e);
  assert.ok(err instanceof DefiniteApiFailure); assert.match(err.message, code);
  assert.ok(!state.calls.some((c) => c[0] === "book"));
}));

test("terms changed after consent (new document_id) blocks old consent -> refund, never book", () => withFlags(ON, async () => {
  const state = newState();
  state.terms = [{document_id: "caravel-en-v5", language: "en", content_hash: "c".repeat(64), withdrawn_at: null}];
  const err = await revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state), nowMs: NOW}).catch((e) => e);
  assert.ok(err instanceof DefiniteApiFailure); assert.match(err.message, /TERMS_CHANGED_AFTER_CONSENT/);
  assert.ok(!state.calls.some((c) => c[0] === "quote" || c[0] === "book"));
}));

for (const [name, patch] of [
  ["price changed", {totals: {grand_total: money(15100), pay_now: money(), pay_at_pickup: money(15100)}, line_items: [{kind: "base_rate", total: money(15100)}]}],
  ["prepayment introduced", {totals: {grand_total: money(15000), pay_now: money(5000), pay_at_pickup: money(10000)}}],
  ["fresh quote about to expire", {expires_at: new Date(NOW + 30000).toISOString()}],
]) test(`fresh supplier quote mismatch -> definitive refusal: ${name}`, () => withFlags(ON, async () => {
  const state = newState(); state.fresh = freshQuote(patch);
  const err = await revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state), nowMs: NOW}).catch((e) => e);
  assert.ok(err instanceof DefiniteApiFailure, String(err)); assert.match(err.message, /PROVIDER_PRICE_OR_TERMS_CHANGED/);
}));

test("credentials must be the production Caravel host", () => withFlags(ON, async () => {
  const state = newState();
  await assert.rejects(() => revalidatePaidCaravel({api_key: "k", api_url: "https://sandbox-api.caravelway.com"}, booking(), quoteRow(),
    {factory: fakeFactory(state), nowMs: NOW}), /PRODUCTION_CREDENTIALS_INVALID/);
}));

test("create: one POST with the derived key; verified confirmation is returned for voucher finalisation", () => withFlags(ON, async () => {
  const state = newState();
  const prepared = await revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state), nowMs: NOW});
  const result = await createPaidCaravel(creds(), prepared, {factory: fakeFactory(state)});
  assert.equal(result.status, "confirmed");
  assert.equal(result.booking_reference, "c0ffee00-1111-4222-8333-444455556666");
  const books = state.calls.filter((c) => c[0] === "book");
  assert.equal(books.length, 1);
  assert.equal(books[0][1], prepared.idempotency_key);
  assert.equal(books[0][3].payment_model, "pay_on_arrival");
  assert.equal(books[0][3].quote_id, FRESH_QID);
  assert.equal(state.clients.at(-1).writes, true);
}));

test("create: confirmed but money/cover differs -> needs_manual_review (never auto-confirmed)", () => withFlags(ON, async () => {
  const state = newState();
  state.booked = (k) => confirmed(k, {protection: {deposit: money(30000), excess: money()}});
  const prepared = await revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state), nowMs: NOW});
  const result = await createPaidCaravel(creds(), prepared, {factory: fakeFactory(state)});
  assert.equal(result.needs_manual_review, true);
}));

test("status: cancelled at supplier -> definitive rejection (refund); pending stays pending", () => withFlags(ON, async () => {
  const state = newState(); const key = await caravelBookingUuid(BOOKING, "book");
  const prepared = {provider: "caravel", supplier_id: "acct_eur", quote_id: FRESH_QID, total_minor: 15000, currency: "EUR", external_ref: `ride24-${key}`};
  state.status = confirmed(key, {status: "cancelled"});
  assert.deepEqual((await readPaidCaravelStatus(creds(), "c0ffee00-1111-4222-8333-444455556666", prepared, {factory: fakeFactory(state)})).definitive_rejection, true);
  state.status = confirmed(key, {status: "pending"});
  assert.equal((await readPaidCaravelStatus(creds(), "c0ffee00-1111-4222-8333-444455556666", prepared, {factory: fakeFactory(state)})).status, "pending");
  state.status = confirmed(key);
  assert.equal((await readPaidCaravelStatus(creds(), "c0ffee00-1111-4222-8333-444455556666", prepared, {factory: fakeFactory(state)})).status, "confirmed");
}));

// End-to-end through the SHARED workflow state machine with Caravel hooks.
function workflow(state, overrides = {}) {
  let w = {booking_id: BOOKING, state: "paid", paid_at: "2026-11-18T12:00:00Z", payment_intent: "pi_test", updated_at: "2026-11-18T12:00:00Z"};
  const log = [];
  const deps = {
    get: async () => w,
    move: async (_id, from, payload) => { if (w.state !== from) return null; w = {...w, ...payload}; log.push(payload.state); return w; },
    claimValidation: async () => { w = {...w, state: "revalidating"}; return w; },
    revalidate: () => revalidatePaidCaravel(creds(), booking(), quoteRow(), {factory: fakeFactory(state), nowMs: NOW}),
    claimDispatch: async (_id, prepared) => { if (state.claimed) return null; state.claimed = true; w = {...w, state: "dispatching", prepared_quote: prepared}; return w; },
    create: (_id, prepared) => createPaidCaravel(creds(), prepared, {factory: fakeFactory(state)}),
    recover: async () => null, status: async () => null,
    finalize: async () => { log.push("voucher"); },
    refund: async () => ({id: "re_test", status: "succeeded"}), refundNotice: async () => { log.push("refund_notice"); },
    ...overrides,
  };
  return {deps, log, get w() { return w; }};
}

test("shared flow: paid -> one Caravel booking -> confirmed -> voucher only after confirmation", () => withFlags(ON, async () => {
  const state = newState(); const f = workflow(state);
  assert.deepEqual(await advanceApiPayment(f.deps, BOOKING), {state: "confirmed"});
  assert.deepEqual(f.log, ["confirmed", "voucher"]);
  assert.equal(state.calls.filter((c) => c[0] === "book").length, 1);
  // Duplicate Stripe webhook / worker replay: claim already taken -> no second supplier booking.
  const f2 = workflow(state); state.calls.length = 0;
  assert.deepEqual(await advanceApiPayment(f2.deps, BOOKING), {skipped: true});
  assert.equal(state.calls.filter((c) => c[0] === "book").length, 0);
}));

test("shared flow: ambiguous supplier create -> unknown (manual review), no retry with a new key, no voucher", () => withFlags(ON, async () => {
  const state = newState(); state.bookThrows = true; const f = workflow(state);
  assert.deepEqual(await advanceApiPayment(f.deps, BOOKING), {state: "unknown"});
  assert.equal(f.w.last_error, "PROVIDER_CREATE_OUTCOME_UNKNOWN");
  assert.ok(!f.log.includes("voucher"));
  assert.equal(state.calls.filter((c) => c[0] === "book").length, 1);
}));

test("shared flow: terms changed after payment -> refund of the Ride24 fee, no supplier booking", () => withFlags(ON, async () => {
  const state = newState(); state.terms = [{document_id: "caravel-en-v5", language: "en", content_hash: HASH, withdrawn_at: null}];
  const f = workflow(state);
  assert.deepEqual(await advanceApiPayment(f.deps, BOOKING), {state: "refund_pending"});
  assert.equal(f.w.last_error, "CARAVEL_TERMS_CHANGED_AFTER_CONSENT");
  assert.equal(state.calls.filter((c) => c[0] === "book").length, 0);
}));

test("shared flow: flags off -> Caravel never reaches the supplier even after payment", async () => {
  const state = newState(); const f = workflow(state);
  const r = await advanceApiPayment(f.deps, BOOKING);
  assert.deepEqual(r, {state: "refund_pending"});
  assert.equal(f.w.last_error, "ADAPTER_NOT_READY");
  assert.equal(state.calls.length, 0);
});
