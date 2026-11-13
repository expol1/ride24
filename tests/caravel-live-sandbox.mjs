// Caravel Channel API v1.67.0 — LIVE sandbox acceptance run (not a unit test).
//
// Runs only server-side (GitHub Actions) with the key from the environment:
//   CARAVEL_SANDBOX_API_KEY  required; never printed (GitHub also masks it)
//   CARAVEL_SUPPLIER_ID      optional supplier scope (X-Supplier-Id)
//   CARAVEL_LIVE_BOOKING=1   also create ONE sandbox booking with invented data and cancel it at once
// The client is hard-limited to https://sandbox-api.caravelway.com and refuses a
// non-sandbox environment. Output: endpoint, HTTP outcome and mapped results only.
import {randomUUID} from "node:crypto";
import {appendFileSync} from "node:fs";
import {CaravelSandboxClient, CaravelError} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";
import {
  buildCaravelOfferFromApi, caravelExtraFromApi, caravelExtrasCatalog, caravelLocationFromApi, caravelQuoteFromApi,
  caravelVehicleFromApi, minorToMajor, normalizeCaravelLocation, normalizeCaravelVehicleClass,
} from "../supabase/functions/_shared/caravel-normalize.ts";
import {buildCaravelBookingDraft, caravelCancellationFromApi, caravelCanonicalStatus, caravelQuotedBookingRequest, expectedPartnerAmount} from "../supabase/functions/_shared/caravel-booking.ts";

const key = process.env.CARAVEL_SANDBOX_API_KEY || "";
const scope = process.env.CARAVEL_SUPPLIER_ID || undefined;
const doBooking = process.env.CARAVEL_LIVE_BOOKING === "1";
const results = [];
let failed = false;

const histogram = (items) => items.reduce((h, e) => { h[e] = (h[e] || 0) + 1; return h; }, {});
async function step(endpoint, fn) {
  try {
    const summary = await fn();
    results.push({endpoint, outcome: "OK", summary});
    return summary;
  } catch (error) {
    failed = true;
    const outcome = error instanceof CaravelError
      ? `HTTP ${error.status} ${error.code}${error.requestId ? ` (request_id ${error.requestId})` : ""}`
      : `ERROR ${String(error?.message || error).replace(key || "\u0000", "***").slice(0, 200)}`;
    results.push({endpoint, outcome});
    return null;
  }
}
function report() {
  const lines = ["# Caravel sandbox live run", "", `booking step: ${doBooking ? "enabled" : "disabled"}`, "",
    "| Endpoint | Outcome | Summary |", "| --- | --- | --- |",
    ...results.map(r => `| ${r.endpoint} | ${r.outcome} | ${r.summary ? JSON.stringify(r.summary).replace(/\|/g, "/").slice(0, 900) : ""} |`)];
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

if (!key) {
  results.push({endpoint: "-", outcome: "SKIPPED", summary: "CARAVEL_SANDBOX_API_KEY is not configured for this run"});
  report();
  process.exit(0);
}

const client = new CaravelSandboxClient(key);
const caps = await step("GET /v1/capabilities", async () => {
  const c = await client.capabilities();
  return {environment: c.data.environment, api_version: c.data.api_version};
});
if (!caps) { report(); process.exit(1); }

const who = await step("GET /v1/whoami", async () => {
  const w = (await client.whoami()).data;
  // Account configuration only: scopes and opt-ins, no credentials.
  return {scopes: w.scopes ?? w.key?.scopes ?? null, currency: w.currency ?? null, opt_ins: w.opt_ins ? Object.keys(w.opt_ins) : null};
});

let supplier = null;
await step("GET /v1/suppliers", async () => {
  const list = (await client.suppliers()).data;
  supplier = (scope ? list.find(s => s.supplier_id === scope) : list[0]) ?? null;
  if (!supplier) throw new Error(scope ? "CONFIGURED_SUPPLIER_NOT_VISIBLE" : "NO_SUPPLIERS");
  return {count: list.length, chosen: supplier.supplier_id, currency: supplier.currency, tax_inclusive: supplier.tax_inclusive, payment_models: supplier.payment_models ?? "not stated"};
});
if (!supplier) { report(); process.exit(1); }
const sid = supplier.supplier_id;

let goodLocations = [];
await step("GET /v1/reference/locations", async () => {
  const raw = (await client.locations(200, sid)).data;
  const mapped = raw.map(r => ({raw: r, n: normalizeCaravelLocation(caravelLocationFromApi(r), sid)}));
  goodLocations = mapped.filter(m => m.n.ok);
  return {count: raw.length, normalized: goodLocations.length, rejected: histogram(mapped.filter(m => !m.n.ok).flatMap(m => m.n.errors)),
    types: histogram(raw.map(r => r.type)), with_hours: raw.filter(r => Array.isArray(r.hours)).length,
    out_of_hours_offered: raw.filter(r => r.out_of_hours?.available === true).length,
    weekday_values: [...new Set(raw.flatMap(r => (r.hours || []).map(h => h.day)))].slice(0, 10)};
});

let policies = null;
await step("GET /v1/reference/policies", async () => {
  const list = (await client.reference("policies", sid)).data;
  policies = list[0] ?? null;
  return {count: list.length, mileage: policies?.mileage ?? null, deposit_payment_methods: policies?.deposit_payment_methods ?? null,
    min_rental_days: policies?.min_rental_days ?? null, max_rental_days: policies?.max_rental_days ?? null, tax_inclusive: policies?.tax_inclusive ?? null};
});

await step("GET /v1/reference/vehicles", async () => {
  const raw = (await client.vehicleClasses(200, sid)).data;
  const mapped = raw.map(r => normalizeCaravelVehicleClass(caravelVehicleFromApi(r, policies), sid));
  return {count: raw.length, normalized: mapped.filter(m => m.ok).length, rejected: histogram(mapped.filter(m => !m.ok).flatMap(m => m.errors)),
    fuels: histogram(raw.map(r => r.fuel ?? "not stated")), transmissions: histogram(raw.map(r => r.transmission ?? "not stated"))};
});

await step("GET /v1/reference/protections", async () => {
  const raw = (await client.reference("protections", sid)).data;
  const premium = raw.filter(p => p.tier === "premium");
  return {count: raw.length, tiers: histogram(raw.map(p => p.tier)), premium: premium.length,
    premium_zero_excess_and_deposit: premium.filter(p => p.excess?.amount === 0 && p.deposit?.amount === 0).length,
    premium_theft_excess_stated: premium.filter(p => p.theft_excess).length};
});

await step("GET /v1/reference/extras", async () => {
  const raw = (await client.reference("extras", sid)).data;
  const {rows, rejected} = caravelExtrasCatalog(raw.map(caravelExtraFromApi), supplier.currency);
  return {count: raw.length, mapped_to_ride24: rows.map(r => `${r.code}:${r.billing}:${r.amount}`), rejected: histogram(rejected.map(r => r.error)),
    categories: histogram(raw.map(e => e.category)), pricing_types: histogram(raw.map(e => e.pricing_type))};
});

await step("GET /v1/reference/fees", async () => {
  const raw = (await client.reference("fees", sid)).data;
  return {count: raw.length, types: histogram(raw.map(f => f.type))};
});

// Availability: a daytime window and a night window at the first usable desk.
const desk = goodLocations.find(m => m.raw.type === "airport") ?? goodLocations[0];
const day = new Date(Date.now() + 30 * 86400000); day.setUTCHours(0, 0, 0, 0);
const at = (offsetDays, hour, minute = 0) => new Date(day.getTime() + offsetDays * 86400000 + (hour * 60 + minute) * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
let dayRows = [], dayMeta = null;
if (desk) {
  const id = desk.raw.location_id;
  await step(`GET /v1/availability (day, ${desk.raw.type})`, async () => {
    const r = await client.availability({pickup_location_id: id, dropoff_location_id: id, pickup: at(0, 10), dropoff: at(3, 10), driver_age: 30, currency: supplier.currency}, sid);
    dayRows = r.data; dayMeta = r.meta;
    const premium = dayRows.filter(x => x.plan === "premium");
    return {rows: dayRows.length, plans: histogram(dayRows.map(x => x.plan ?? "none")), premium_rows: premium.length,
      premium_zero_risk: premium.filter(x => CaravelSandboxClient.isPremiumZeroRisk(x)).length,
      deposits_minor: [...new Set(dayRows.map(x => x.protection?.deposit?.amount))].slice(0, 8),
      rental_days: r.meta?.rental_days ?? null, withheld: r.meta?.withheld ?? null, mileage: r.meta?.policies?.mileage ?? null};
  });
  await step("GET /v1/availability (night, 23:30Z)", async () => {
    const r = await client.availability({pickup_location_id: id, dropoff_location_id: id, pickup: at(0, 23, 30), dropoff: at(3, 23, 30), driver_age: 30, currency: supplier.currency}, sid);
    const feeLines = r.data.flatMap(x => (x.line_items || []).filter(l => l.kind === "fee"));
    return {rows: r.data.length, fee_types: histogram(feeLines.map(l => l.type ?? "untyped")),
      out_of_hours_amounts_minor: [...new Set(feeLines.filter(l => l.type === "out_of_hours").map(l => l.total?.amount))],
      unsellable_ends: r.meta?.unsellable_ends ?? null};
  });
} else {
  results.push({endpoint: "GET /v1/availability", outcome: "NOT RUN", summary: "no desk passed location normalization"});
}

// Quote one zero-risk Premium row and normalize it to the Ride24 standard offer.
const row = dayRows.find(x => x.plan === "premium" && CaravelSandboxClient.isPremiumZeroRisk(x));
let quoteRead = null, quoteData = null;
if (row) {
  await step("POST /v1/quote (premium)", async () => {
    const q = await client.quote({pickup: {location_id: desk.raw.location_id, at: at(0, 10)}, dropoff: {location_id: desk.raw.location_id, at: at(3, 10)},
      vehicle_id: row.vehicle_id, protection_id: row.protection.protection_id, plan: "premium", currency: supplier.currency,
      drivers: [{age: 30, role: "main"}]}, randomUUID(), sid);
    quoteData = q.data;
    const read = caravelQuoteFromApi(quoteData, row.protection, supplier);
    quoteRead = read.ok ? read.value : null;
    const hasOoh = read.ok && read.value.mandatoryCharges.some(c => c.category === "out_of_hours");
    const offer = buildCaravelOfferFromApi({availabilityRow: row, policies: dayMeta?.policies ?? policies, quoteData, supplier,
      // Derived from the provider quote itself (not an independent hours check).
      operatingHours: {pickupLocalTime: "10:00", returnLocalTime: "10:00", pickupTimezone: desk.raw.timezone, returnTimezone: desk.raw.timezone,
        pickupOutsideHours: hasOoh, returnOutsideHours: false},
      context: {scopeSupplierId: sid, partnerCurrency: supplier.currency, pickupLocationId: desk.raw.location_id, dropoffLocationId: desk.raw.location_id,
        pickupEpochMs: Date.parse(at(0, 10)), dropoffEpochMs: Date.parse(at(3, 10)), rentalDays: 3, driverAge: 30, nowEpochMs: Date.now()}});
    return {status: quoteData.status, rental_days: quoteData.rental_days, line_kinds: histogram((quoteData.line_items || []).map(l => l.kind)),
      grand_total: quoteData.totals?.grand_total, pay_now: quoteData.totals?.pay_now, pay_at_pickup: quoteData.totals?.pay_at_pickup,
      deposit: quoteData.deposit?.amount ?? null, reconciliation: read.ok ? "OK" : read.errors,
      ride24_offer: offer.ok ? {class_code: offer.value.class_code, model: offer.value.model, public_price_total: offer.value.public_price_total, noCardHold: offer.value.features.noCardHold} : offer.errors};
  });
} else {
  results.push({endpoint: "POST /v1/quote", outcome: "NOT RUN", summary: "no zero-excess, zero-deposit Premium row in the daytime search"});
}

// Optional: one sandbox booking with invented data, read back and cancelled immediately.
if (doBooking && quoteRead) {
  const ref = `ci-${process.env.GITHUB_RUN_ID || "local"}-${Date.now()}`;
  const total = minorToMajor(quoteRead.quote.totalAmountMinor, quoteRead.quote.currency);
  const draft = buildCaravelBookingDraft({
    idempotency_key: randomUUID(), ride24_booking_id: ref, vehicle_group_id: row.vehicle_id,
    main_driver: {name: "Sandbox Tester", age: 30}, client_email: "sandbox-ci@example.test", client_phone: null,
    currency: quoteRead.quote.currency, partner_discount_percent: 0, partner_amount: expectedPartnerAmount(total, 0), quote_reference: quoteRead.quote.quoteId,
    provider_quote_data: {provider: "caravel", quote_id: quoteRead.quote.quoteId, supplier_id: sid, vehicle_id: row.vehicle_id,
      protection_id: row.protection.protection_id, plan: "premium", currency: quoteRead.quote.currency, amounts: {total},
      drivers: [{age: 30, role: "main"}], expires_at: new Date(quoteRead.quote.expiresAtEpochMs).toISOString()},
  }, Date.now());
  if (!draft.ok) {
    failed = true;
    results.push({endpoint: "POST /v1/bookings", outcome: "NOT SENT", summary: draft.errors});
  } else {
    let booking = null;
    await step("POST /v1/bookings (sandbox, invented data)", async () => {
      booking = (await client.bookSandbox(caravelQuotedBookingRequest(draft.draft), draft.draft.idempotencyKey, sid)).data;
      return {status: booking.status, ride24_status: caravelCanonicalStatus(booking.status), revision: booking.revision,
        grand_total: booking.price?.totals?.grand_total, payment: booking.payment ?? null};
    });
    if (booking) {
      await step("GET /v1/bookings/{ref}?ref_type=booking_id", async () => {
        const b = (await client.bookingStatusSandbox(booking.booking_id, sid)).data;
        return {status: b.status, revision: b.revision};
      });
      await step("POST /v1/bookings/{ref}/cancel", async () => {
        const c = (await client.cancelSandbox(booking.booking_id, booking.revision, randomUUID(), sid)).data;
        const read = caravelCancellationFromApi(c);
        return {status: c.status, ride24_status: caravelCanonicalStatus(c.status), cancellation: read.ok ? {fee_minor: read.feeMinor, currency: read.currency, revision: read.revision} : read.errors};
      });
    }
  }
} else if (doBooking) {
  results.push({endpoint: "POST /v1/bookings", outcome: "NOT RUN", summary: "no reconciled Premium quote"});
}

report();
process.exit(failed ? 1 : 0);
