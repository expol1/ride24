import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../../supabase/functions/_shared/kayfleet-adapter.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function setup(reply = () => null) {
  const calls = [];
  const sandbox = {
    exports: {},
    require: (name) => {
      if (!name.includes("partner-api")) throw Error("Unexpected module " + name);
      return { partnerApiRequest: async (_credentials, path, request) => {
        calls.push({ path, request });
        return reply(path, request);
      } };
    },
    URL, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(code, sandbox);
  return { ...sandbox.exports, calls };
}
function groups() {
  return { vehicle_groups: [{
    group_id: "economy", name: "Economy", seats: 5, bags: 2,
    currency: "EUR", daily_price_from: 35, insurance_excess: 500,
    premium_protection_daily: 15, image_url: "https://example.invalid/economy.jpg",
  }] };
}
const locations = { locations: [
  { location_id: "Paphos Airport", name: "Paphos Airport",
    currency: "EUR", pickup_fee: 25, dropoff_fee: 25 },
  { location_id: "Larnaca Airport", name: "Larnaca Airport",
    currency: "EUR", pickup_fee: 0, dropoff_fee: 20 },
] };
const window = {
  pickup_location_id: "Paphos Airport",
  dropoff_location_id: "Larnaca Airport",
  pickup_date: "2027-07-01",
  return_date: "2027-07-06",
  pickup_time: "10:00",
  return_time: "10:00",
  currency: "EUR",
};
const availability = { vehicle_groups: [{
  group_id: "economy", name: "Economy", available: true,
  available_count: 3, daily_rate: 37.05, rental_total: 185.25, days: 5,
}] };
function quote(change = {}) {
  return {
    quote_reference: "q-123", quote_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    group_id: "economy", group_name: "Economy", currency: "EUR", days: 5,
    daily_rate: 37.05, rental_total: 185.25, insurance_fee: 87.5,
    insurance_excess: 0, equipment_fee: 0,
    additional_driver_fee: 0, delivery_fee: 25, grand_total: 297.75,
    ...change,
  };
}
test("KayFleet uses correct Cyprus winter and summer offsets, never naive UTC", () => {
  const a = setup();
  assert.equal(a.cyprusIso("2027-01-12", "10:00"), "2027-01-12T10:00:00+02:00");
  assert.equal(a.cyprusIso("2027-07-12", "10:15"), "2027-07-12T10:15:00+03:00");
  assert.throws(() => a.cyprusIso("2027-02-31", "10:00"), /INVALID_TIME/);
  assert.throws(() => a.cyprusIso("2027-03-28", "03:30"), /AMBIGUOUS_TIME/);
  assert.throws(() => a.cyprusIso("2027-10-31", "03:30"), /AMBIGUOUS_TIME/);
});
test("KayFleet locations retain different pickup and drop-off fees", () => {
  const a = setup();
  const rows = a.normalizeKayFleetLocations(locations);
  assert.equal(rows[0].external_id, "Paphos Airport");
  assert.equal(rows[0].country, "Cyprus");
  assert.equal(rows[0].type, "airport");
  assert.equal(rows[0].extra_fee_amount, 25);
  assert.equal(rows[1].return_fee_amount, 20);
  assert.equal(rows[1].extra_fee_amount, 0);
  assert.throws(() => a.normalizeKayFleetLocations({ locations: [
    { location_id: "X", name: "X", currency: "EUR", pickup_fee: -1, dropoff_fee: 0 },
  ] }), /INVALID_PICKUP_FEE/);
});
test("KayFleet group is a category; price_from is never a live offer", () => {
  const a = setup();
  const [g] = a.normalizeKayFleetGroups(groups());
  assert.equal(g.external_id, "economy");
  assert.equal(g.class_code, "E");
  assert.equal(g.public_price, 0);
  assert.equal(g.model, "Economy");
  assert.equal(g.image, "https://example.invalid/economy.jpg");
  assert.equal(g.deposit_amount, null);
  const [unsafe] = a.normalizeKayFleetGroups({
    vehicle_groups: [{ ...groups().vehicle_groups[0], image_url: "http://example.invalid/a.jpg" }],
  });
  assert.equal(unsafe.image, null);
});
test("KayFleet quote includes full insurance and fees in exactly one partner total", () => {
  const a = setup();
  const g = a.normalizeKayFleetGroups(groups())[0];
  const result = a.normalizeKayFleetQuote(g, availability.vehicle_groups[0], quote(), window);
  assert.equal(result.public_price_total, 297.75);
  assert.equal(result.public_price, 59.55);
  assert.equal(result.price_is_total, true);
  assert.equal(result.quote_reference, "q-123");
  assert.equal(result.location_external_ids.join(","), "Paphos Airport,Larnaca Airport");
  assert.equal(result.provider_quote_data.quote.insurance_excess, 0);
});
test("unsafe quotes never become offers: excess, price mismatch, expired, wrong currency", () => {
  const a = setup();
  const group = a.normalizeKayFleetGroups(groups())[0];
  for (const bad of [
    { insurance_excess: 500 },
    { grand_total: 300 },
    { quote_expires_at: "2020-01-01T00:00:00Z" },
    { currency: "USD" },
    { group_id: "other" },
  ]) {
    assert.throws(() => a.normalizeKayFleetQuote(
      group, availability.vehicle_groups[0], quote(bad), window,
    ), /KAYFLEET_/);
  }
  assert.throws(() => a.normalizeKayFleetQuote(
    group, { ...availability.vehicle_groups[0], available_count: 0 }, quote(), window,
  ), /UNAVAILABLE/);
});
test("KayFleet GET search passes Cyprus offsets, both locations and full insurance", async () => {
  const a = setup((path) => {
    if (path.startsWith("/api/partner/availability?")) return availability;
    if (path === "/api/partner/vehicle-groups") return groups();
    if (path.startsWith("/api/partner/quote?")) return quote();
    throw Error("Unexpected URL " + path);
  });
  const result = await a.kayfleetSearch({}, window);
  assert.equal(result.length, 1);
  assert.equal(result[0].public_price_total, 297.75);
  const avail = a.calls.find((x) => x.path.startsWith("/api/partner/availability?"));
  const priced = a.calls.find((x) => x.path.startsWith("/api/partner/quote?"));
  assert.equal(avail.request.method, "GET");
  assert.equal(priced.request.method, "GET");
  const aq = new URLSearchParams(avail.path.split("?")[1]);
  const pq = new URLSearchParams(priced.path.split("?")[1]);
  assert.equal(aq.get("pickup_datetime"), "2027-07-01T10:00:00+03:00");
  assert.equal(pq.get("full_insurance"), "true");
  assert.equal(pq.get("pickup_location"), "Paphos Airport");
  assert.equal(pq.get("dropoff_location"), "Larnaca Airport");
});
test("Booking creation is blocked until binding quote and final terms are certified", async () => {
  const a = setup(() => { throw Error("No external request must run"); });
  await assert.rejects(() => a.kayfleetCreateBooking(), /BOOKING_NOT_CERTIFIED/);
  assert.equal(a.calls.length, 0);
});
test("KayFleet denied remains rejection; confirmed remains pending manual validation", async () => {
  for (const [raw, canonical, manual] of [
    ["pending", "pending", false],
    ["denied", "rejected", false],
    ["confirmed", "confirmed", true],
    ["active", "pending", true],
    ["overdue", "pending", true],
  ]) {
    const a = setup(() => ({ status: raw, reference: "ext-1" }));
    const result = await a.kayfleetBookingStatus({}, "ext-1");
    assert.equal(result.status, canonical);
    assert.equal(result.needs_manual_review, manual);
    assert.equal(result.definitive_rejection, raw === "denied");
  }
});
test("Cancellation requires explicit provider cancelled; no inferred success", async () => {
  const a = setup(() => ({ status: "cancelled" }));
  assert.equal((await a.kayfleetCancel({}, "ext-1")).status, "cancelled");
  assert.equal(a.calls[0].request.method, "POST");
  assert.match(a.calls[0].path, /\/cancel$/);
  const b = setup(() => ({ status: "pending" }));
  await assert.rejects(() => b.kayfleetCancel({}, "ext-1"), /CANCEL_NOT_CONFIRMED/);
});