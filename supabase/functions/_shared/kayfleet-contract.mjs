// KayFleet v1 booking contract. Offline-only preparation: no network calls or booking writes.
// This module NEVER authorizes supplier booking by itself; production fulfillment
// remains gated until test-key acceptance and Stripe/refund integration.
const fail = (code) => { throw new Error("PARTNER_API_ERROR:KAYFLEET_" + code); };
const rec = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
const clean = (v) => (typeof v === "string" ? v.trim() : "");
const euroCents = (v, code) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e7) fail(code);
  const cents = Math.round(v * 100);
  if (Math.abs(cents / 100 - v) > 0.000001) fail(code);
  return cents;
};
const needed = (v, code) => {
  const s = clean(v);
  if (!s || s.length > 500) fail(code);
  return s;
};
function positiveInt(value, max, code) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    fail(code);
  return value;
}
export function kayfleetSelections(value) {
  const data = rec(value);
  if (!data) fail("INVALID_EXTRAS");
  return {
    car_seat_qty: positiveInt(data.car_seat_qty, 2, "CAR_SEAT_QTY"),
    booster_seat_qty: positiveInt(data.booster_seat_qty, 2, "BOOSTER_SEAT_QTY"),
    additional_drivers: positiveInt(data.additional_drivers, 5, "ADDITIONAL_DRIVERS"),
  };
}
function sameExtras(expected, actual) {
  const e = kayfleetSelections(expected), a = kayfleetSelections(actual);
  return e.car_seat_qty === a.car_seat_qty
    && e.booster_seat_qty === a.booster_seat_qty
    && e.additional_drivers === a.additional_drivers;
}
export function kayfleetLiability(row, { requireDeposit = true } = {}) {
  const x = rec(row);
  if (!x || x.full_insurance !== true || x.insurance_excess !== 0)
    fail("FULL_INSURANCE_REQUIRED");
  if (requireDeposit && x.deposit_amount !== 0)
    fail("ZERO_DEPOSIT_REQUIRED");
  if (!requireDeposit && x.deposit_amount != null && x.deposit_amount !== 0)
    fail("ZERO_DEPOSIT_REQUIRED");
  return true;
}
export function kayfleetClassifyQuoteError(status, code) {
  if (status !== 409) return null;
  if (!["quote_expired", "quote_already_used", "quote_mismatch"].includes(code))
    return null;
  // A fresh quote is required. Never replay the same provider booking and
  // never accept a changed amount/extras without renewed customer approval.
  return { action: "requote", code, repeat_booking: false, customer_reapproval_required: true };
}
// Assemble a booking-only request from a server-persisted, user-approved quote.
// Caller must bind an idempotency key to Ride24's immutable booking ID.
export function kayfleetBookingRequest(input) {
  const i = rec(input); if (!i) fail("INVALID_BOOKING");
  const q = rec(i.quote); if (!q) fail("QUOTE_REQUIRED");
  const expiresAt = Date.parse(needed(q.quote_expires_at, "QUOTE_EXPIRY"));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000)
    fail("QUOTE_EXPIRED");
  const quoteRef = needed(q.quote_reference, "QUOTE_REFERENCE");
  const groupId = needed(i.group_id, "GROUP_REQUIRED");
  if (q.group_id !== groupId) fail("GROUP_MISMATCH");
  if (q.currency !== "EUR") fail("CURRENCY_MISMATCH");
  const price = euroCents(q.grand_total, "PRICE");
  if (price <= 0 || price !== euroCents(i.approved_partner_total, "ACCEPTED_PRICE"))
    fail("PRICE_MISMATCH");
  // Only a fully protected, zero-excess and zero-deposit contract may be booked.
  kayfleetLiability(q, { requireDeposit: true });
  const approvedExtras = kayfleetSelections(i.approved_extras);
  const quotedExtras = kayfleetSelections(i.quoted_extras);
  if (!sameExtras(approvedExtras, quotedExtras)) fail("EXTRAS_CHANGED");
  const pickupDatetime = needed(i.pickup_datetime, "PICKUP_REQUIRED");
  const returnDatetime = needed(i.return_datetime, "RETURN_REQUIRED");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(pickupDatetime)
    || !/(Z|[+-]\d{2}:\d{2})$/.test(returnDatetime)
    || !(Date.parse(returnDatetime) > Date.parse(pickupDatetime))) fail("TIME_MISMATCH");
  const pickupName = needed(i.pickup_location, "PICKUP_LOCATION");
  const dropoffName = needed(i.dropoff_location, "DROPOFF_LOCATION");
  const customer = rec(i.customer);
  if (!customer) fail("CUSTOMER_REQUIRED");
  const idempotencyKey = needed(i.idempotency_key, "IDEMPOTENCY_REQUIRED");
  const partnerRef = needed(i.partner_ref, "PARTNER_REF_REQUIRED");
  return {
    path: "/api/partner/bookings",
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      group_id: groupId, quote_reference: quoteRef,
      pickup_datetime: pickupDatetime, return_datetime: returnDatetime,
      pickup_location: pickupName, dropoff_location: dropoffName,
      customer: {
        full_name: needed(customer.full_name, "CUSTOMER_NAME"),
        email: needed(customer.email, "CUSTOMER_EMAIL"),
        phone: needed(customer.phone, "CUSTOMER_PHONE"),
      },
      full_insurance: true,
      ...approvedExtras,
      partner_ref: partnerRef,
    },
  };
}
export function verifyKayfleetBookingSnapshot(response, accepted) {
  const r = rec(response), a = rec(accepted);
  if (!r || !a) fail("STATUS_NOT_VERIFIED");
  if (r.status !== "confirmed") fail("NOT_CONFIRMED");
  kayfleetLiability(r, { requireDeposit: true });
  if (r.currency !== "EUR" || r.quote_reference !== a.quote_reference
    || r.partner_ref !== a.partner_ref || r.pickup_datetime !== a.pickup_datetime
    || r.return_datetime !== a.return_datetime
    || r.pickup_location !== a.pickup_location
    || r.dropoff_location !== a.dropoff_location
    || (a.group_name && r.group_name !== a.group_name)
    || euroCents(r.grand_total, "STATUS_TOTAL") !== euroCents(a.grand_total, "ACCEPTED_TOTAL"))
      fail("STATUS_MISMATCH");
  if (!sameExtras(r.extras, a.extras)) fail("STATUS_EXTRAS_CHANGED");
  const subtotal = ["rental_price", "insurance_fee", "delivery_fee",
    "equipment_fee", "additional_driver_fee"]
    .reduce((acc, key) => acc + euroCents(r[key], "STATUS_COMPONENT_" + key.toUpperCase()), 0);
  if (subtotal !== euroCents(r.grand_total, "STATUS_TOTAL"))
    fail("STATUS_PRICE_BREAKDOWN");
  return { confirmed: true, reference: needed(r.reference, "REFERENCE"),
    booking_number: needed(r.booking_number, "BOOKING_NUMBER"),
    total_eur: r.grand_total };
}
