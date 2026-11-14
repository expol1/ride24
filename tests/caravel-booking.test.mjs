import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaravelBookingDraft, caravelCancellationFromApi, caravelCanonicalStatus, caravelQuotedBookingRequest, expectedPartnerAmount,
} from "../supabase/functions/_shared/caravel-booking.ts";
import {CaravelSandboxClient, CaravelError, isUuid} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";

const NOW = 1900000000000;
const QID = "3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const IDEM = "9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e";
const input = () => ({
  idempotency_key: IDEM, ride24_booking_id: "b-123", vehicle_group_id: "veh-cdmr",
  main_driver: {name: "Jan Testowy", age: 30}, additional_driver: null,
  client_email: "sandbox@example.test", client_phone: "+48 000 000 000",
  currency: "EUR", partner_discount_percent: 0, partner_amount: 150, quote_reference: QID,
  provider_quote_data: {provider: "caravel", quote_id: QID, supplier_id: "sup-1", vehicle_id: "veh-cdmr",
    protection_id: "prot-premium", plan: "premium", currency: "EUR", amounts: {total: 150},
    drivers: [{age: 30, role: "main"}], expires_at: new Date(NOW + 600000).toISOString()},
});

test("builds the documented quoted-create body from the common Ride24 booking input", () => {
  const result = buildCaravelBookingDraft(input(), NOW);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(caravelQuotedBookingRequest(result.draft), {
    quote_id: QID,
    external_ref: "ride24-sandbox-b-123",
    drivers: [{first_name: "Jan", last_name: "Testowy", age: 30, role: "main"}],
    customer: {first_name: "Jan", last_name: "Testowy", email: "sandbox@example.test", phone: "+48 000 000 000"},
    payment_model: "pay_on_arrival",
  });
  assert.equal(result.draft.expectedPartnerAmount, 150);
});

test("invalid phone is omitted, never sent", () => {
  const r = buildCaravelBookingDraft({...input(), client_phone: "call me"}, NOW);
  assert.equal("phone" in caravelQuotedBookingRequest(r.draft).customer, false);
});

test("partner amount must equal grand_total exactly; no partner discount for Caravel", () => {
  assert.equal(expectedPartnerAmount(150, 10), 135);
  assert.ok(buildCaravelBookingDraft({...input(), partner_amount: 140}, NOW).errors.includes("PARTNER_AMOUNT_MISMATCH"));
  assert.ok(buildCaravelBookingDraft({...input(), partner_discount_percent: 10, partner_amount: 135}, NOW).errors.includes("PARTNER_DISCOUNT_NOT_ALLOWED"));
});

test("rejects changed, expired or foreign quotes and unsupported options", () => {
  const cases = [
    [i => { i.quote_reference = "q-2"; }, "QUOTE_REFERENCE_MISMATCH"],
    [i => { i.provider_quote_data.quote_id = "q-1"; i.quote_reference = "q-1"; }, "QUOTE_REFERENCE_MISMATCH"],
    [i => { i.provider_quote_data.provider = "renteon"; }, "CARAVEL_QUOTE_REQUIRED"],
    [i => { i.provider_quote_data.expires_at = new Date(NOW).toISOString(); }, "QUOTE_EXPIRED"],
    [i => { i.vehicle_group_id = "other"; }, "VEHICLE_MISMATCH"],
    [i => { i.currency = "PLN"; }, "CURRENCY_MISMATCH"],
    [i => { i.main_driver.age = 31; }, "DRIVER_SET_CHANGED"],
    [i => { i.additional_driver = {name: "A B", age: 40}; }, "ADDITIONAL_DRIVER_NOT_SUPPORTED"],
    [i => { i.main_driver = {name: "Jan", age: 30}; }, "DRIVER_NAME_REQUIRED"],
    [i => { i.client_email = "x"; }, "CONTACT_EMAIL_REQUIRED"],
    [i => { i.idempotency_key = "key-1"; }, "IDEMPOTENCY_REQUIRED"],
    [i => { i.ride24_booking_id = "x".repeat(60); }, "BOOKING_ID_REQUIRED"],
  ];
  for (const [patch, code] of cases) {
    const i = input(); patch(i);
    const result = buildCaravelBookingDraft(i, NOW);
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.includes(code), `${code} not in ${result.errors}`);
  }
  assert.equal(buildCaravelBookingDraft(undefined, NOW).ok, false);
});

test("status mapping follows the documented lifecycle; others stay unresolved", () => {
  assert.equal(caravelCanonicalStatus("confirmed"), "confirmed");
  assert.equal(caravelCanonicalStatus("pending"), "pending");
  assert.equal(caravelCanonicalStatus("cancelled"), "cancelled");
  for (const v of ["no_show", "completed", "canceled", "CONFIRMED", "on_request", null]) assert.equal(caravelCanonicalStatus(v), null);
});

test("cancellation outcome is read from the documented Booking.cancellation", () => {
  assert.deepEqual(caravelCancellationFromApi({status: "cancelled", revision: 2, cancellation: {fee: {amount: 0, currency: "EUR"}, refund: {amount: 0, currency: "EUR"}}}),
    {ok: true, feeMinor: 0, currency: "EUR", revision: 2});
  assert.equal(caravelCancellationFromApi({status: "confirmed", revision: 1}).ok, false);
});

const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });
const mock = (handler, status = 200) => { globalThis.fetch = async (url, options) =>
  new Response(JSON.stringify(handler(String(url), options)), {status: typeof status === "function" ? status(String(url)) : status, headers: {"content-type": "application/json"}}); };
const caps = (url) => url.endsWith("/v1/capabilities");

test("capabilities are checked once per client and failures are not cached", async () => {
  const calls = [];
  mock((url) => { calls.push(url); return caps(url) ? {data: {environment: "sandbox"}} : {data: []}; });
  const client = new CaravelSandboxClient("fixture");
  await client.suppliers();
  await client.locations();
  assert.equal(calls.filter(caps).length, 1);
  let n = 0;
  mock((url) => (caps(url) && n++ === 0) ? {data: {environment: "production"}} : {data: {environment: "sandbox"}});
  const fresh = new CaravelSandboxClient("fixture");
  await assert.rejects(() => fresh.suppliers(), /SANDBOX_ENVIRONMENT_REQUIRED/);
  await fresh.capabilities();
});

test("error envelope request_id is read from the documented error object", async () => {
  mock((url) => caps(url) ? {data: {environment: "sandbox"}} : {error: {code: "unauthenticated", message: "Missing X-API-Key header.", request_id: "req_1", doc_url: "x"}},
    (url) => caps(url) ? 200 : 401);
  await assert.rejects(() => new CaravelSandboxClient("fixture").suppliers(), (e) => e instanceof CaravelError && e.requestId === "req_1" && e.code === "unauthenticated" && e.status === 401);
});

test("availability sends documented driver_age and currency, rejects bad values", async () => {
  const calls = [];
  mock((url) => { calls.push(url); return caps(url) ? {data: {environment: "sandbox"}} : {data: []}; });
  const client = new CaravelSandboxClient("fixture");
  await client.availability({pickup_location_id: "p", dropoff_location_id: "p", pickup: "2027-01-10T10:00:00+01:00", dropoff: "2027-01-13T10:00:00+01:00", driver_age: 30, currency: "EUR"});
  const qs = new URL(calls[1]).searchParams;
  assert.equal(qs.get("driver_age"), "30");
  assert.equal(qs.get("currency"), "EUR");
  assert.equal(qs.has("plan"), false);
  await assert.rejects(() => client.availability({pickup_location_id: "p", dropoff_location_id: "p", pickup: "x", dropoff: "y", driver_age: 15}), /INVALID_DRIVER_AGE/);
});

test("quote, booking and cancel require UUID idempotency keys and documented shapes", async () => {
  const client = new CaravelSandboxClient("fixture");
  const q = {pickup: {location_id: "p", at: "2027-01-10T10:00:00+01:00"}, dropoff: {location_id: "p", at: "2027-01-13T10:00:00+01:00"},
    vehicle_id: "v", protection_id: "pr", plan: "premium", drivers: [{age: 30, role: "main"}]};
  await assert.rejects(() => client.quote(q, "not-a-uuid"), /IDEMPOTENCY_REQUIRED/);
  await assert.rejects(() => client.quote({...q, drivers: [{age: 30, role: "additional"}]}, IDEM), /INVALID_QUOTE_REQUEST/);
  await assert.rejects(() => client.quote({...q, extras: [{extra_id: "e", quantity: 10}]}, IDEM), /INVALID_QUOTE_REQUEST/);
  await assert.rejects(() => client.bookSandbox({quote_id: "q", external_ref: "ride24-sandbox-1", drivers: [], customer: {}}, IDEM), /SANDBOX_BOOKING_GUARD/);
  await assert.rejects(() => client.cancelSandbox(QID, 1, "key"), /INVALID_CANCEL/);
  assert.equal(isUuid(IDEM), true);
  const calls = [];
  mock((url, options) => { calls.push({url, options}); return caps(url) ? {data: {environment: "sandbox"}} : {data: {quote_id: QID}}; });
  await new CaravelSandboxClient("fixture").quote(q, IDEM);
  assert.equal(calls[1].url, "https://sandbox-api.caravelway.com/v1/quote");
  assert.equal(calls[1].options.headers["Idempotency-Key"], IDEM);
  assert.deepEqual(JSON.parse(calls[1].options.body), q);
});

test("booking status uses guarded booking id", async () => {
  const calls = [];
  mock((url) => { calls.push(url); return caps(url) ? {data: {environment: "sandbox"}} : {data: {status: "confirmed"}}; });
  await new CaravelSandboxClient("fixture").bookingStatusSandbox(QID);
  assert.equal(calls[1], `https://sandbox-api.caravelway.com/v1/bookings/${QID}?ref_type=booking_id`);
  await assert.rejects(() => new CaravelSandboxClient("fixture").bookingStatusSandbox("../x"), /INVALID_BOOKING_ID/);
});
