import test from "node:test";
import assert from "node:assert/strict";
import {buildCaravelBookingDraft, caravelCanonicalStatus, expectedPartnerAmount} from "../supabase/functions/_shared/caravel-booking.ts";
import {CaravelSandboxClient} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";

const NOW = 1900000000000;
const input = () => ({
  idempotency_key: "idem-1", ride24_booking_id: "b-123", vehicle_group_id: "veh-cdmr",
  main_driver: {name: "Jan Testowy", age: 30}, additional_driver: null,
  client_email: "sandbox@example.test", client_phone: "+48000000000",
  currency: "EUR", partner_discount_percent: 10, partner_amount: 135, quote_reference: "q-1",
  provider_quote_data: {provider: "caravel", quote_id: "q-1", supplier_id: "sup-1", vehicle_id: "veh-cdmr",
    protection_id: "prot-premium", plan: "premium", currency: "EUR", amounts: {total: 150},
    expires_at: new Date(NOW + 600000).toISOString()},
});

test("builds a sandbox booking draft from the common Ride24 booking input", () => {
  const result = buildCaravelBookingDraft(input(), NOW);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.draft, {quoteId: "q-1", supplierId: "sup-1", externalRef: "ride24-sandbox-b-123",
    idempotencyKey: "idem-1", mainDriver: {firstName: "Jan", lastName: "Testowy", age: 30},
    contact: {email: "sandbox@example.test", phone: "+48000000000"}, expectedPartnerAmount: 135, currency: "EUR"});
});

test("partner amount must equal quote total after partner discount", () => {
  assert.equal(expectedPartnerAmount(150, 10), 135);
  const result = buildCaravelBookingDraft({...input(), partner_amount: 140}, NOW);
  assert.ok(result.errors.includes("PARTNER_AMOUNT_MISMATCH"));
});

test("rejects changed, expired or foreign quotes and unsupported options", () => {
  const cases = [
    [i => { i.quote_reference = "q-2"; }, "QUOTE_REFERENCE_MISMATCH"],
    [i => { i.provider_quote_data.provider = "renteon"; }, "CARAVEL_QUOTE_REQUIRED"],
    [i => { i.provider_quote_data.expires_at = new Date(NOW).toISOString(); }, "QUOTE_EXPIRED"],
    [i => { i.vehicle_group_id = "other"; }, "VEHICLE_MISMATCH"],
    [i => { i.currency = "PLN"; }, "CURRENCY_MISMATCH"],
    [i => { i.additional_driver = {name: "A B", age: 40}; }, "ADDITIONAL_DRIVER_NOT_SUPPORTED"],
    [i => { i.main_driver = {name: "Jan", age: 30}; }, "DRIVER_NAME_REQUIRED"],
    [i => { i.client_email = "x"; }, "CONTACT_EMAIL_REQUIRED"],
    [i => { i.idempotency_key = ""; }, "IDEMPOTENCY_REQUIRED"],
  ];
  for (const [patch, code] of cases) {
    const i = input(); patch(i);
    const result = buildCaravelBookingDraft(i, NOW);
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.includes(code), `${code} not in ${result.errors}`);
  }
  assert.equal(buildCaravelBookingDraft(undefined, NOW).ok, false);
});

test("status mapping is explicit; unknown values stay unresolved", () => {
  assert.equal(caravelCanonicalStatus("CONFIRMED"), "confirmed");
  assert.equal(caravelCanonicalStatus("canceled"), "cancelled");
  assert.equal(caravelCanonicalStatus("on_request"), "pending");
  assert.equal(caravelCanonicalStatus("weird"), null);
  assert.equal(caravelCanonicalStatus(null), null);
});

const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });
const mock = (handler) => { globalThis.fetch = async (url, options) =>
  new Response(JSON.stringify(handler(String(url), options)), {status: 200, headers: {"content-type": "application/json"}}); };

test("capabilities are checked once per client and failures are not cached", async () => {
  const calls = [];
  mock((url) => { calls.push(url); return url.endsWith("/v1/capabilities") ? {data: {environment: "sandbox"}} : {data: []}; });
  const client = new CaravelSandboxClient("fixture");
  await client.suppliers();
  await client.locations();
  assert.equal(calls.filter(u => u.endsWith("/v1/capabilities")).length, 1);
  let n = 0;
  mock((url) => (url.endsWith("/v1/capabilities") && n++ === 0) ? {data: {environment: "production"}} : {data: {environment: "sandbox"}});
  const fresh = new CaravelSandboxClient("fixture");
  await assert.rejects(() => fresh.suppliers(), /SANDBOX_ENVIRONMENT_REQUIRED/);
  await fresh.capabilities();
});

test("booking status uses guarded booking id", async () => {
  const calls = [];
  mock((url) => { calls.push(url); return url.endsWith("/v1/capabilities") ? {data: {environment: "sandbox"}} : {data: {status: "confirmed"}}; });
  await new CaravelSandboxClient("fixture").bookingStatusSandbox("bk_1");
  assert.equal(calls[1], "https://sandbox-api.caravelway.com/v1/bookings/bk_1?ref_type=booking_id");
  await assert.rejects(() => new CaravelSandboxClient("fixture").bookingStatusSandbox("../x"), /INVALID_BOOKING_ID/);
});
