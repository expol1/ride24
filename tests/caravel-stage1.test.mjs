// Stage 1 modules: Premium policy, desk hours, reference merge, webhooks, booking
// checks, client guards. Webhook HMAC is checked against Caravel's PUBLISHED static
// self-test fixture (docs/packs/caravel/fixtures/webhook-hmac-self-test.json);
// everything else uses synthetic data shaped like OpenAPI v1.67.0 — not live API.
import test from "node:test";
import assert from "node:assert/strict";
import {evaluateCaravelPremium, caravelConditionsOfHire, reconcileCaravelTerms, CARAVEL_PREMIUM_TERMS} from "../supabase/functions/_shared/caravel-premium.ts";
import {caravelOutsideHours, caravelLocalTime} from "../supabase/functions/_shared/caravel-hours.ts";
import {mergeCaravelReference, findCaravelReference} from "../supabase/functions/_shared/caravel-reference-sync.ts";
import {verifyCaravelSignature, parseCaravelSignatureHeader, parseCaravelWebhookEvent, decideCaravelWebhookEvent, shouldApplyFetchedBooking, caravelSignatureFor} from "../supabase/functions/_shared/caravel-webhooks.ts";
import {caravelBookingStatus, verifyCaravelBookingAgainstQuote, caravelErrorAction} from "../supabase/functions/_shared/caravel-booking.ts";
import {verifyCaravelQuotedExtras, caravelProviderExtras} from "../supabase/functions/_shared/caravel-normalize.ts";
import {CaravelClient, CaravelError} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";

const eur = (amount) => ({amount, currency: "EUR"});
const premium = (patch = {}) => ({protection_id: "p", tier: "premium", excess: eur(0), deposit: eur(0), theft_excess: eur(0),
  product_type: "waiver", covers: ["glass", "undercarriage", "tyres_and_wheels", "theft", "fire", "wrong_fuel"], excludes: [], ...patch});

// ------------------------------------------------------------- Premium ----
test("Premium passes only when every Ride24 guarantee is stated by the supplier", () => {
  const ok = evaluateCaravelPremium("premium", premium(), {amount: eur(0), type: "pre_authorization"});
  assert.equal(ok.ok, true);
  assert.equal(ok.noCreditCard, true);
  assert.equal(ok.noCardHold, true);
  const cases = [
    ["medium", premium(), "PREMIUM_PLAN_REQUIRED"],
    ["premium", premium({tier: "medium"}), "PREMIUM_TIER_REQUIRED"],
    ["premium", premium({deposit: eur(25000)}), "ZERO_DEPOSIT_REQUIRED"],
    ["premium", premium({excess: eur(100000)}), "ZERO_EXCESS_REQUIRED"],
    ["premium", premium({theft_excess: undefined}), "ZERO_THEFT_EXCESS_UNCONFIRMED"],
    ["premium", premium({theft_excess: eur(50000)}), "ZERO_THEFT_EXCESS_UNCONFIRMED"],
    ["premium", premium({product_type: undefined}), "DAMAGE_WAIVER_UNCONFIRMED"],
    ["premium", premium({product_type: "insurance"}), "DAMAGE_WAIVER_UNCONFIRMED"],
    ["premium", premium({covers: undefined}), "COVERS_UNSTATED"],
    ["premium", premium({covers: ["theft", "fire", "glass", "tyres_and_wheels"]}), "COVER_MISSING_UNDERCARRIAGE"],
    ["premium", premium({covers: ["theft", "glass", "tyres_and_wheels", "undercarriage"]}), "COVER_MISSING_FIRE"],
    ["premium", premium({excludes: ["glass"]}), "COVERS_CONTRADICT_EXCLUDES"],
  ];
  for (const [plan, prot, code] of cases) {
    const r = evaluateCaravelPremium(plan, prot);
    assert.equal(r.ok, false, code);
    assert.ok(r.errors.includes(code), `${code} not in ${r.errors}`);
  }
  assert.ok(evaluateCaravelPremium("premium", premium(), {amount: eur(30000)}).errors.includes("QUOTE_DEPOSIT_NOT_ZERO"));
  assert.equal(evaluateCaravelPremium(undefined, undefined).ok, false);
});

test("conditions of hire are read as stated and reconciled with Ride24 terms", () => {
  const c = caravelConditionsOfHire({licence_rules: {min_years_held: 2, international_permit_required_for: ["non_eu"]},
    restrictions: ["off_road"], deposit_payment_methods: [], mileage: {type: "unlimited"}, min_rental_days: 1, max_rental_days: 365});
  assert.equal(c.minLicenceYears, 2);
  assert.deepEqual(reconcileCaravelTerms(c), {conflicts: ["LICENCE_YEARS_2_VS_RIDE24_1"], unstated: ["deposit_card_rules"]});
  const empty = caravelConditionsOfHire({});
  assert.equal(empty.restrictions, null); // absent = not stated, never "none"
  assert.equal(reconcileCaravelTerms(empty).unstated.length, 4);
  assert.equal(CARAVEL_PREMIUM_TERMS.exclusions.find(x => x.code === "keys").amountMinor, 20000);
});

// --------------------------------------------------------------- Hours ----
const desk = (patch = {}) => ({timezone: "Europe/Zagreb", hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => ({day, open: "08:00", close: "20:00"})), ...patch});
test("out-of-hours follows the desk's own schedule in its timezone", () => {
  // 2027-01-11 is a Monday; Zagreb is UTC+1 in January.
  assert.equal(caravelOutsideHours(desk(), "2027-01-11T09:00:00Z"), false); // 10:00 local
  assert.equal(caravelOutsideHours(desk(), "2027-01-11T19:30:00Z"), true); // 20:30 local
  assert.equal(caravelOutsideHours(desk(), "2027-01-11T06:59:00Z"), true); // 07:59 local
  assert.equal(caravelOutsideHours(desk(), "2027-01-11T07:00:00Z"), false); // 08:00 local
  assert.equal(caravelLocalTime("2027-01-11T19:30:00Z", "Europe/Zagreb"), "20:30");
  // Summer time: UTC+2.
  assert.equal(caravelOutsideHours(desk(), "2027-07-12T17:30:00Z"), false); // 19:30 local (UTC+2)
  assert.equal(caravelOutsideHours(desk(), "2027-07-12T18:30:00Z"), true); // 20:30 local: closed
});
test("midnight-crossing windows, end-of-day 00:00, closed weekdays and holidays", () => {
  const night = desk({hours: [{day: "fri", open: "22:00", close: "06:00"}]});
  assert.equal(caravelOutsideHours(night, "2027-01-15T22:30:00Z"), false); // Fri 23:30 local
  assert.equal(caravelOutsideHours(night, "2027-01-16T03:00:00Z"), false); // Sat 04:00 local, Friday's window
  assert.equal(caravelOutsideHours(night, "2027-01-16T06:00:00Z"), true); // Sat 07:00 local
  assert.equal(caravelOutsideHours(night, "2027-01-14T12:00:00Z"), true); // Thursday: no entry = closed
  const late = desk({hours: [{day: "mon", open: "08:00", close: "00:00"}]});
  assert.equal(caravelOutsideHours(late, "2027-01-11T22:30:00Z"), false); // 23:30, open to end of day
  const holiday = desk({holidays: [{date: "2027-01-11", closed: true}, {date: "2027-01-12", closed: false, open: "10:00", close: "12:00"}]});
  assert.equal(caravelOutsideHours(holiday, "2027-01-11T09:00:00Z"), true);
  assert.equal(caravelOutsideHours(holiday, "2027-01-12T08:00:00Z"), true); // 09:00 local, holiday opens 10:00
  assert.equal(caravelOutsideHours(holiday, "2027-01-12T09:30:00Z"), false);
  assert.equal(caravelOutsideHours({timezone: "Europe/Zagreb", hours: null}, "2027-01-11T09:00:00Z"), null);
  assert.equal(caravelOutsideHours(desk({timezone: "Mars/Base"}), "2027-01-11T09:00:00Z"), null);
  assert.equal(caravelOutsideHours(desk({hours: [{day: "mon", open: "8", close: "20:00"}]}), "2027-01-11T09:00:00Z"), null);
});

// ------------------------------------------------------ Reference sync ----
test("shrunk refresh merges and never deletes; renamed record stays the same", () => {
  const store = new Map();
  const v = (id, name) => ({supplier_id: "sup-1", vehicle_id: id, display_name: name});
  assert.deepEqual(mergeCaravelReference(store, [v("a", "Golf"), v("b", "Polo")], "vehicle_id", "t1"), {added: 2, updated: 0, missing: 0, returned: 0, invalid: 0});
  assert.deepEqual(mergeCaravelReference(store, [v("a", "Golf or similar")], "vehicle_id", "t2"), {added: 0, updated: 1, missing: 1, returned: 0, invalid: 0});
  const b = findCaravelReference(store, "b", "sup-1");
  assert.equal(b.missing_since, "t2"); // kept, still quotable
  assert.equal(findCaravelReference(store, "a", "sup-1").data.display_name, "Golf or similar");
  assert.deepEqual(mergeCaravelReference(store, [v("a", "Golf or similar"), v("b", "Polo")], "vehicle_id", "t3"), {added: 0, updated: 1, missing: 0, returned: 1, invalid: 0});
  assert.equal(findCaravelReference(store, "b", "sup-1").first_seen, "t1"); // the same record
  assert.equal(mergeCaravelReference(store, [{display_name: "no id"}], "vehicle_id", "t4").invalid, 1);
});

// ------------------------------------------------------------ Webhooks ----
// Caravel's published static fixture; the secret is built at runtime so it is not a literal in the repo.
const FIXTURE = {
  secret: ["whsec", "sandbox_fixture_5f8a2e91c3b74d0aa6e1f2c9d8b3a704"].join("_"),
  t: 1752480000, method: "POST", path: "/example/booking-events",
  body: JSON.stringify({event_id: "3f2a91c4-8e77-4c1b-9d2a-5b6e0f7a1c33", type: "booking.confirmed", occurred_at: "2026-07-14T08:00:00.000Z",
    api_version: "1.1.1", operator_id: "00000000-0000-4000-8000-000000000000", booking_id: "9c1a4f22-0d5e-4b83-a7f1-2e6c8d40b915",
    external_ref: "PARTNER-FIXTURE-0001", revision: 1, sequence: 4187,
    data: {booking_id: "9c1a4f22-0d5e-4b83-a7f1-2e6c8d40b915", external_ref: "PARTNER-FIXTURE-0001", status: "confirmed", revision: 1}}),
  expected: "49d42e2772fee8254a847c813871f4ea752486a8dc5e1369bafa6b48fa9a82d6",
};
FIXTURE.header = `t=${FIXTURE.t},v1=${FIXTURE.expected}`;
FIXTURE.tampered = FIXTURE.body.replace('"status":"confirmed","revision":1}', '"status":"confirmed","revision":2}');

test("HMAC verifier reproduces Caravel's published fixture signature", async () => {
  assert.equal(await caravelSignatureFor(FIXTURE.secret, FIXTURE.t, FIXTURE.method, FIXTURE.path, FIXTURE.body), FIXTURE.expected);
  const req = {method: FIXTURE.method, path: FIXTURE.path, body: FIXTURE.body};
  assert.equal(await verifyCaravelSignature(FIXTURE.header, [FIXTURE.secret], req, {nowSecs: FIXTURE.t}), true);
});
test("HMAC verifier rejects tamper, replay, wrong secret; accepts during rotation; ignores unknown schemes", async () => {
  const req = {method: FIXTURE.method, path: FIXTURE.path, body: FIXTURE.body};
  assert.equal(await verifyCaravelSignature(FIXTURE.header, [FIXTURE.secret], {...req, body: FIXTURE.tampered}, {nowSecs: FIXTURE.t}), false);
  assert.equal(await verifyCaravelSignature(FIXTURE.header, [FIXTURE.secret], req, {nowSecs: FIXTURE.t + 301}), false);
  assert.equal(await verifyCaravelSignature(FIXTURE.header, [FIXTURE.secret], req, {nowSecs: FIXTURE.t - 301}), false);
  assert.equal(await verifyCaravelSignature(FIXTURE.header, ["other-secret"], req, {nowSecs: FIXTURE.t}), false);
  assert.equal(await verifyCaravelSignature(FIXTURE.header, ["old-secret", FIXTURE.secret], req, {nowSecs: FIXTURE.t}), true);
  const rotated = `t=${FIXTURE.t},v1=${"0".repeat(64)},v1=${FIXTURE.expected},v2=abc`;
  assert.equal(await verifyCaravelSignature(rotated, [FIXTURE.secret], req, {nowSecs: FIXTURE.t}), true);
  assert.equal(await verifyCaravelSignature(FIXTURE.header, [FIXTURE.secret], {...req, path: "/other"}, {nowSecs: FIXTURE.t}), false);
  assert.equal(parseCaravelSignatureHeader("v1=abc"), null);
  assert.equal(await verifyCaravelSignature(undefined, [FIXTURE.secret], req), false);
});

test("events: dedupe on event_id, reject stale revisions, detect sequence gaps, always re-fetch", () => {
  const event = parseCaravelWebhookEvent(FIXTURE.body);
  assert.equal(event.revision, 1);
  const state = (seen = [], rev = null, seq = null) => ({hasEvent: (id) => seen.includes(id), lastRevision: () => rev, lastSequence: () => seq});
  assert.deepEqual(decideCaravelWebhookEvent(event, state([event.event_id])), {action: "ignore", reason: "DUPLICATE_EVENT"});
  assert.deepEqual(decideCaravelWebhookEvent(event, state([], 1)), {action: "ignore", reason: "STALE_REVISION"});
  const fresh = decideCaravelWebhookEvent(event, state([], null, 4186));
  assert.equal(fresh.action, "refetch_booking");
  assert.equal(fresh.sequence_gap, false);
  const gap = decideCaravelWebhookEvent(event, state([], null, 4100));
  assert.equal(gap.sequence_gap, true);
  assert.ok(gap.reconcile_since);
  for (const type of ["booking.modified", "booking.no_show", "booking.completed"]) {
    const e = parseCaravelWebhookEvent(FIXTURE.body.replace("booking.confirmed", type));
    assert.equal(decideCaravelWebhookEvent(e, state()).known_type, true);
  }
  const unknown = parseCaravelWebhookEvent(FIXTURE.body.replace("booking.confirmed", "booking.future_thing"));
  assert.equal(decideCaravelWebhookEvent(unknown, state()).known_type, false); // still re-fetched, flagged
  assert.equal(parseCaravelWebhookEvent("{not json"), null);
  assert.equal(parseCaravelWebhookEvent(FIXTURE.body.replace('"revision":1,"sequence"', '"revision":0,"sequence"')), null);
  assert.equal(shouldApplyFetchedBooking(3, 2), true);
  assert.equal(shouldApplyFetchedBooking(2, 2), false);
});

// ------------------------------------------------- Booking & statuses ----
test("status lifecycle: unknown never confirmed or terminal", () => {
  assert.deepEqual(caravelBookingStatus("confirmed"), {caravel: "confirmed", ride24: "confirmed", terminal: false, review: false, known: true});
  assert.equal(caravelBookingStatus("no_show").terminal, true);
  assert.equal(caravelBookingStatus("no_show").review, true);
  assert.equal(caravelBookingStatus("completed").ride24, null);
  const unknown = caravelBookingStatus("on_hold");
  assert.deepEqual([unknown.ride24, unknown.terminal, unknown.review, unknown.known], [null, false, true, false]);
});

const QID = "3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11", BID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const booking = (patch = {}) => ({booking_id: BID, quote_id: QID, status: "confirmed", revision: 1,
  price: {totals: {grand_total: eur(15000)}}, protection: {excess: eur(0), deposit: eur(0)},
  payment: {model: "pay_on_arrival", amount_prepaid: eur(0), amount_on_arrival: eur(15000)}, ...patch});
test("booked price, protection and payment model must match the quote", () => {
  const q = {quoteId: QID, totalAmountMinor: 15000, currency: "EUR"};
  assert.deepEqual(verifyCaravelBookingAgainstQuote(booking(), q), {ok: true, bookingId: BID, revision: 1});
  const cases = [
    [{price: {totals: {grand_total: eur(15100)}}}, "BOOKED_PRICE_DIFFERS_FROM_QUOTE"],
    [{quote_id: "other"}, "QUOTE_ID_MISMATCH"],
    [{status: "pending"}, "NOT_CONFIRMED"],
    [{protection: {excess: eur(100), deposit: eur(0)}}, "BOOKED_PROTECTION_NOT_ZERO_RISK"],
    [{payment: {model: "prepaid"}}, "PAYMENT_MODEL_NOT_PAY_ON_ARRIVAL"],
    [{payment: {model: "pay_on_arrival", amount_on_arrival: eur(14000)}}, "AMOUNT_ON_ARRIVAL_DIFFERS"],
  ];
  for (const [patch, code] of cases) assert.ok(verifyCaravelBookingAgainstQuote(booking(patch), q).errors.includes(code), code);
});
test("documented error codes map to safe actions", () => {
  const act = (code, status = 409) => caravelErrorAction(new CaravelError(status, code, "r")).action;
  for (const c of ["availability_changed", "price_changed", "quote_expired", "quote_consumed", "no_availability"]) assert.equal(act(c), "requote");
  assert.equal(act("revision_conflict"), "refetch_then_retry");
  assert.equal(act("idempotency_in_progress"), "retry_same_key");
  assert.equal(act("rate_limited", 429), "retry_same_key");
  for (const c of ["invalid_transition", "booking_conflict", "idempotency_key_reused", "supplier_mismatch", "brand_new_code"]) assert.equal(act(c), "stop");
});

// -------------------------------------------------------------- Extras ----
test("quoted extras must match the selection, quantities and price caps", () => {
  const catalog = [{extra_id: "e1", code: "SEAT", price_cap: eur(5000), quantity: {min: 0, max: 2, default: 0}},
    {extra_id: "e2", code: "GPS", price_cap: null, quantity: {min: 0, max: 1, default: 0}}];
  const sel = [{extraId: "e1", quantity: 2}];
  assert.deepEqual(verifyCaravelQuotedExtras([{code: "SEAT", quantity: 2, totalMinor: 9000}], sel, catalog), {ok: true});
  assert.ok(verifyCaravelQuotedExtras([{code: "SEAT", quantity: 2, totalMinor: 12000}], sel, catalog).errors.includes("EXTRA_ABOVE_PRICE_CAP"));
  assert.ok(verifyCaravelQuotedExtras([], sel, catalog).errors.includes("SELECTED_EXTRA_NOT_PRICED"));
  assert.ok(verifyCaravelQuotedExtras([{code: "SEAT", quantity: 2, totalMinor: 9000}, {code: "GPS", quantity: 1, totalMinor: 100}], sel, catalog).errors.includes("UNSELECTED_EXTRA_PRICED"));
  assert.ok(verifyCaravelQuotedExtras([{code: "SEAT", quantity: 1, totalMinor: 4500}], sel, catalog).errors.includes("EXTRA_QUANTITY_MISMATCH"));
  assert.ok(verifyCaravelQuotedExtras([], [{extraId: "e1", quantity: 3}], catalog).errors.includes("EXTRA_QUANTITY_INVALID"));
  const provider = caravelProviderExtras([{extra_id: "x", code: "OTH", name: "Snow chains", category: "other", pricing_type: "per_day",
    unit_price: eur(450), price_cap: eur(4500), quantity: {min: 0, max: 1, default: 0}, requires_quantity: false, payable: "at_pickup", mutually_exclusive_group: null},
    {extra_id: "bad", name: "x", pricing_type: "per_hour", unit_price: eur(1)}]);
  assert.equal(provider.length, 1);
  assert.deepEqual([provider[0].unit_price, provider[0].price_cap, provider[0].payable], [4.5, 45, "at_pickup"]);
});

// ------------------------------------------------------- Client guards ----
test("base URL is configuration; production needs explicit consent; production bookings are blocked", async () => {
  assert.throws(() => new CaravelClient({apiKey: "k", environment: "staging"}), /INVALID_CARAVEL_CONFIG/);
  assert.throws(() => new CaravelClient({apiKey: "k", environment: "production"}), /PRODUCTION_NOT_ALLOWED/);
  const prod = new CaravelClient({apiKey: "k", environment: "production", allowProduction: true});
  const body = {quote_id: QID, external_ref: "ride24-1", drivers: [{age: 30, role: "main"}], customer: {first_name: "A", last_name: "B", email: "a@b.cd"}, payment_model: "pay_on_arrival"};
  await assert.rejects(() => prod.book(body, QID), /PRODUCTION_BOOKING_WRITES_DISABLED/);
  await assert.rejects(() => prod.cancel(BID, 1, QID), /PRODUCTION_BOOKING_WRITES_DISABLED/);
  await assert.rejects(() => prod.bookSandbox(body, QID), /SANDBOX_BOOKING_GUARD/);
  const sandbox = new CaravelClient({apiKey: "k", environment: "sandbox"});
  await assert.rejects(() => sandbox.book({...body, external_ref: "ride24-sandbox-1", payment_model: "prepaid"}, QID), /SANDBOX_BOOKING_GUARD/);
  await assert.rejects(() => sandbox.book({...body, external_ref: "ride24-1"}, QID), /SANDBOX_BOOKING_GUARD/);
});
test("production client refuses a host that reports a different environment", async () => {
  const original = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({data: {environment: "sandbox"}}), {status: 200}); };
    const prod = new CaravelClient({apiKey: "k", environment: "production", allowProduction: true});
    await assert.rejects(() => prod.suppliers(), /ENVIRONMENT_MISMATCH/);
    assert.equal(calls[0], "https://api.caravelway.com/v1/capabilities");
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify(String(url).includes("capabilities") ? {data: {environment: "sandbox"}} : {data: []}), {status: 200}); };
    const sb = new CaravelClient({apiKey: "k", environment: "sandbox"});
    await sb.listBookings({updated_since: "2026-11-14T10:00:00Z"}, "sup-1");
    assert.equal(calls.at(-1), "https://sandbox-api.caravelway.com/v1/bookings?updated_since=2026-11-14T10%3A00%3A00Z");
    await assert.rejects(() => sb.listBookings({updated_since: "yesterday"}), /INVALID_UPDATED_SINCE/);
    globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("capabilities") ? {data: {environment: "sandbox"}}
      : {error: {code: "validation_error", request_id: "r1", details: [{field: "pickup.at", issue: "out_of_hours_not_offered"}]}}), {status: String(url).includes("capabilities") ? 200 : 422});
    await assert.rejects(() => sb.quote({pickup: {location_id: "p", at: "2027-01-11T23:00:00Z"}, dropoff: {location_id: "p", at: "2027-01-14T10:00:00Z"}, vehicle_id: "v", protection_id: "pr", drivers: [{age: 30, role: "main"}]}, QID),
      (e) => e instanceof CaravelError && e.details[0].issue === "out_of_hours_not_offered" && e.details[0].field === "pickup.at");
  } finally { globalThis.fetch = original; }
});
