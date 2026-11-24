import test from "node:test";
import assert from "node:assert/strict";
import {
  kayfleetSelections, kayfleetLiability, kayfleetClassifyQuoteError,
  kayfleetBookingRequest, verifyKayfleetBookingSnapshot,
} from "../../supabase/functions/_shared/kayfleet-contract.mjs";

const extras = { car_seat_qty: 1, booster_seat_qty: 0, additional_drivers: 1 };
const quoted = {
  quote_reference: "quote-1", quote_expires_at: new Date(Date.now() + 25 * 60_000).toISOString(),
  group_id: "economy", currency: "EUR", grand_total: 380,
  full_insurance: true, insurance_excess: 0, deposit_amount: 0,
};
const booking = () => ({
  quote: structuredClone(quoted), group_id: "economy", approved_partner_total: 380,
  approved_extras: structuredClone(extras), quoted_extras: structuredClone(extras),
  pickup_datetime: "2026-12-02T10:00:00+02:00",
  return_datetime: "2026-12-09T10:00:00+02:00",
  pickup_location: "Larnaca Airport", dropoff_location: "Larnaca Airport",
  partner_ref: "R24-10045", idempotency_key: "ride24:immutable-booking-1",
  customer: { full_name: "Example Person", email: "customer@example.invalid", phone: "+35710000000" },
});
const confirmation = () => ({
  reference: "external-test-1", booking_number: "FR-A1B2C3",
  quote_reference: "quote-1", partner_ref: "R24-10045", status: "confirmed",
  group_name: "Economy",
  pickup_datetime: "2026-12-02T10:00:00+02:00",
  return_datetime: "2026-12-09T10:00:00+02:00",
  pickup_location: "Larnaca Airport", dropoff_location: "Larnaca Airport",
  currency: "EUR", rental_price: 210, insurance_fee: 105, delivery_fee: 0,
  equipment_fee: 35, additional_driver_fee: 30, grand_total: 380,
  full_insurance: true, insurance_excess: 0, deposit_amount: 0,
  extras: structuredClone(extras),
});
function accepted() {
  return {
    quote_reference: "quote-1", partner_ref: "R24-10045",
    pickup_datetime: "2026-12-02T10:00:00+02:00",
    return_datetime: "2026-12-09T10:00:00+02:00",
    pickup_location: "Larnaca Airport", dropoff_location: "Larnaca Airport",
    group_name: "Economy", grand_total: 380, extras: structuredClone(extras),
  };
}
test("KayFleet POST body binds the exact accepted quote, extras, route and idempotency", () => {
  const output = kayfleetBookingRequest(booking());
  assert.equal(output.path, "/api/partner/bookings");
  assert.equal(output.headers["Idempotency-Key"], "ride24:immutable-booking-1");
  assert.equal(output.body.quote_reference, "quote-1");
  assert.equal(output.body.partner_ref, "R24-10045");
  assert.equal(output.body.full_insurance, true);
  assert.deepEqual({
    car_seat_qty: output.body.car_seat_qty,
    booster_seat_qty: output.body.booster_seat_qty,
    additional_drivers: output.body.additional_drivers,
  }, extras);
  for (const name of ["grand_total", "approved_partner_total", "platform_margin", "online_payment_pln"]) {
    assert.equal(name in output.body, false, "Never send Ride24 fees or client totals");
  }
});
test("KayFleet extras enforce the documented per-field quantity limits", () => {
  assert.deepEqual(kayfleetSelections({ car_seat_qty: 2, booster_seat_qty: 2, additional_drivers: 5 }),
    { car_seat_qty: 2, booster_seat_qty: 2, additional_drivers: 5 });
  for (const value of [
    { ...extras, car_seat_qty: -1 }, { ...extras, car_seat_qty: 3 },
    { ...extras, booster_seat_qty: 3 }, { ...extras, additional_drivers: 6 },
    { ...extras, additional_drivers: "1" }, { ...extras, booster_seat_qty: 0.5 },
  ]) assert.throws(() => kayfleetSelections(value), /KAYFLEET_/);
});
test("KayFleet only assembles quotes with zero deposit, full insurance and exact approved total", () => {
  for (const mutation of [
    b => b.quote.deposit_amount = 300,
    b => b.quote.deposit_amount = undefined,
    b => b.quote.insurance_excess = 100,
    b => b.quote.full_insurance = false,
    b => b.quote.grand_total = 381,
    b => b.quote.quote_expires_at = "2020-01-01T00:00:00Z",
    b => b.quoted_extras.additional_drivers = 2,
    b => b.quote.group_id = "other",
    b => b.quote.currency = "USD",
  ]) {
    const b = booking();mutation(b);
    assert.throws(() => kayfleetBookingRequest(b), /KAYFLEET_/);
  }
  assert.equal(kayfleetLiability({ full_insurance: true, insurance_excess: 0, deposit_amount: 0 }), true);
});
test("KayFleet 409 quote conflicts require a fresh customer-approved quote, not booking replay", () => {
  for (const code of ["quote_expired", "quote_already_used", "quote_mismatch"]) {
    assert.deepEqual(kayfleetClassifyQuoteError(409, code),
      { action: "requote", code, repeat_booking: false, customer_reapproval_required: true });
  }
  assert.equal(kayfleetClassifyQuoteError(409, "unknown"), null);
  assert.equal(kayfleetClassifyQuoteError(500, "quote_expired"), null);
});
test("KayFleet full confirmed snapshot verifies complete amounts and matching extras", () => {
  assert.deepEqual(verifyKayfleetBookingSnapshot(confirmation(), accepted()),
    { confirmed: true, reference: "external-test-1", booking_number: "FR-A1B2C3", total_eur: 380 });
});
test("KayFleet sample deposit 300 EUR from IT email is refused, not silently accepted", () => {
  const row = confirmation();row.deposit_amount = 300;
  assert.throws(() => verifyKayfleetBookingSnapshot(row, accepted()), /ZERO_DEPOSIT_REQUIRED/);
});
test("KayFleet confirmed payload with changed price, route, extras or insurance requires review", () => {
  for (const mutation of [
    r => r.grand_total = 390,
    r => r.rental_price = 211,
    r => r.pickup_location = "Paphos City",
    r => r.quote_reference = "another-quote",
    r => r.extras.additional_drivers = 2,
    r => r.insurance_excess = 50,
    r => r.full_insurance = false,
    r => r.status = "pending",
  ]) {
    const r = confirmation(); mutation(r);
    assert.throws(() => verifyKayfleetBookingSnapshot(r, accepted()), /KAYFLEET_/);
  }
});