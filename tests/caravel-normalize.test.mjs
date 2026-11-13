import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaravelOffer, caravelExtrasCatalog, caravelSyncRows, minorToMajor,
  normalizeCaravelLocation, normalizeCaravelVehicleClass, ride24StandardPayload,
} from "../supabase/functions/_shared/caravel-normalize.ts";
// Real shared Ride24 code (read-only use): the Caravel output must pass unchanged.
import {normalizeGroups, normalizeLocations} from "../supabase/functions/_shared/partner-api.ts";
import {apiPriceTotals} from "../supabase/functions/_shared/api-quote-contract.mjs";

const NOW = 1900000000000;
const pickup = Date.UTC(2027, 0, 10, 21, 30);
const vehicle = () => ({
  vehicleId: "veh-cdmr", supplierId: "sup-1", acrissCode: "CDMR", makeModel: "VW Golf", orSimilar: true,
  transmission: "manual", fuelType: "petrol", seats: 5, bags: 3, imageUrl: "https://img.example/golf.jpg",
  mileage: {unlimited: true}, creditCardRequired: false, cardHoldRequired: false,
  roadsideAssistance: true, airConditioning: true, minDriverAge: 21, maxDriverAge: 75, active: true,
});
const offer = () => ({
  vehicle: vehicle(),
  quote: {currency: "EUR", rentalAmountMinor: 12000, extrasAmountMinor: 0, mandatoryFeesAmountMinor: 3000,
    totalAmountMinor: 15000, quoteId: "q-1", expiresAtEpochMs: NOW + 600000, plan: "Premium",
    depositAmountMinor: 0, excessAmountMinor: 0},
  protectionId: "prot-premium",
  mandatoryCharges: [{externalId: "ooh-1", label: "Out of hours pickup", category: "out_of_hours_pickup", amountMinor: 3000, currency: "EUR"}],
  operatingHours: {pickupLocalTime: "23:30", returnLocalTime: "10:00", pickupTimezone: "Europe/Zagreb",
    returnTimezone: "Europe/Zagreb", pickupOutsideHours: true, returnOutsideHours: false},
  rules: {minRentalMinutes: 1440, minDriverAge: 21, maxDriverAge: 75, currency: "EUR"},
  extras: [{externalId: "seat", name: "Child seat", unitAmountMinor: 500, currency: "EUR", chargingUnit: "day", maxQuantity: 1, selectedQuantity: 0}],
  context: {scopeSupplierId: "sup-1", partnerCurrency: "EUR", pickupLocationId: "loc-spu", dropoffLocationId: "loc-spu",
    pickupEpochMs: pickup, dropoffEpochMs: pickup + 3 * 86400000, rentalDays: 3, driverAge: 30, nowEpochMs: NOW},
});
const location = () => ({locationId: "loc-spu", supplierId: "sup-1", name: "Split Airport", countryCode: "HR",
  region: "Dalmatia", city: "Split", type: "airport", timezone: "Europe/Zagreb", active: true});

test("offer passes shared normalizeGroups unchanged with provider total", () => {
  const built = buildCaravelOffer(offer());
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const [group] = normalizeGroups(ride24StandardPayload({groups: [built.value]}));
  assert.equal(group.external_id, "veh-cdmr");
  assert.equal(group.class_code, "C");
  assert.equal(group.model, "VW Golf or similar");
  assert.equal(group.image, "https://img.example/golf.jpg");
  assert.equal(group.transmission, "manual");
  assert.equal(group.seats, 5);
  assert.equal(group.bags, 3);
  assert.equal(group.currency, "EUR");
  assert.equal(group.price_is_total, true);
  assert.equal(group.public_price_total, 150);
  assert.equal(group.public_price, 50);
  assert.equal(group.deposit_amount, 0);
  // Shared normalizeGroups stores "no limit" as 0; the card renders 0 as unlimited mileage.
  assert.equal(group.mileage_limit, 0);
  assert.equal(group.quote_reference, "q-1");
  assert.deepEqual(group.location_external_ids, ["loc-spu"]);
  assert.equal(group.features.fullInsurance, true);
  assert.equal(group.features.roadsideAssistance, true);
  assert.equal(group.features.out_of_hours_amount, 30);
  assert.equal(group.provider_quote_data.quote_id, "q-1");
  assert.equal(group.provider_quote_data.protection_id, "prot-premium");
  // Shared sanitizePartnerPayload returns null-prototype objects; compare plain values.
  assert.deepEqual({...group.provider_quote_data.amounts_minor}, {rental: 12000, extras: 0, mandatory_fees: 3000, total: 15000});
});

test("Ride24 fee and partner payable come from shared apiPriceTotals on the provider total", () => {
  const [group] = normalizeGroups({groups: [buildCaravelOffer(offer()).value]});
  const totals = apiPriceTotals(group, 3, 10, 20);
  assert.equal(totals.partnerNetTotal, 135); // 150 - 10 % partner discount
  assert.equal(totals.finalTotal, 162); // + 20 % Ride24 margin
  assert.equal(totals.commissionTotal, 27); // Ride24 fee
  assert.equal(totals.finalPerDay, 54);
});

test("night fee is inside the provider total and never added twice", () => {
  const o = offer();
  o.quote.totalAmountMinor = 12000; // fee missing from total
  assert.equal(buildCaravelOffer(o).ok, false);
  const p = offer();
  p.mandatoryCharges = [];
  p.quote.mandatoryFeesAmountMinor = 0; p.quote.totalAmountMinor = 12000;
  assert.ok(buildCaravelOffer(p).errors.includes("PICKUP_FEE_UNVERIFIED"));
});

test("fails closed on unverified or misleading card data", () => {
  const cases = [
    [o => { o.quote.plan = "Basic"; }, "PREMIUM_REQUIRED"],
    [o => { o.quote.depositAmountMinor = 30000; }, "ZERO_DEPOSIT_REQUIRED"],
    [o => { o.vehicle.mileage = {unlimited: false, limitKm: 1000, period: "rental"}; }, "MILEAGE_PERIOD_UNSUPPORTED"],
    [o => { o.vehicle.mileage = null; }, "MILEAGE_UNVERIFIED"],
    [o => { o.vehicle.acrissCode = "QDMR"; }, "VEHICLE_CLASS_UNVERIFIED"],
    [o => { o.vehicle.supplierId = "other"; }, "SUPPLIER_SCOPE_MISMATCH"],
    [o => { o.vehicle.imageUrl = "http://img.example/x.jpg"; }, "IMAGE_UNVERIFIED"],
    [o => { o.context.partnerCurrency = "PLN"; }, "PARTNER_CURRENCY_MISMATCH"],
    [o => { o.context.driverAge = 19; }, "DRIVER_AGE_OUT_OF_RANGE"],
    [o => { o.vehicle.minDriverAge = 31; }, "DRIVER_AGE_OUT_OF_RANGE"],
    [o => { o.extras[0].selectedQuantity = 1; o.context.providerChargeableDays = 3; }, "SELECTED_EXTRAS_NOT_SUPPORTED"],
    [o => { o.protectionId = ""; }, "PROTECTION_ID_UNVERIFIED"],
    [o => { o.quote.expiresAtEpochMs = NOW; }, "QUOTE_EXPIRED"],
  ];
  for (const [patch, code] of cases) {
    const o = offer(); patch(o);
    const result = buildCaravelOffer(o);
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.includes(code), `${code} not in ${result.errors}`);
  }
});

test("missing input never throws", () => {
  assert.equal(buildCaravelOffer(undefined).ok, false);
  assert.equal(buildCaravelOffer({}).ok, false);
  assert.equal(normalizeCaravelLocation(undefined, "sup-1").ok, false);
  assert.equal(normalizeCaravelVehicleClass(undefined, "sup-1").ok, false);
});

test("per-day mileage limit uses the Ride24 km/day card field", () => {
  const o = offer(); o.vehicle.mileage = {unlimited: false, limitKm: 300, period: "day"};
  const [group] = normalizeGroups({groups: [buildCaravelOffer(o).value]});
  assert.equal(group.mileage_limit, 300);
});

test("card badges: only explicit provider false yields no-card badges", () => {
  const o = offer(); o.vehicle.cardHoldRequired = null;
  const built = buildCaravelOffer(o).value;
  assert.equal(built.features.noCardHold, false);
  assert.equal(built.features.noCreditCard, false);
});

test("location passes shared normalizeLocations and maps to partner_locations row", () => {
  const loc = normalizeCaravelLocation(location(), "sup-1");
  assert.equal(loc.ok, true);
  const [normalized] = normalizeLocations({locations: [loc.value]});
  assert.deepEqual(
    {id: normalized.external_id, country: normalized.country, region: normalized.region, city: normalized.city,
      name: normalized.location_name, type: normalized.type, fee: normalized.extra_fee},
    {id: "loc-spu", country: "Croatia", region: "Dalmatia", city: "Split", name: "Split Airport", type: "airport", fee: false},
  );
  const rows = caravelSyncRows("partner-1", [normalized], [], new Map());
  assert.equal(rows.partner_locations[0].is_api_managed, true);
  assert.equal(rows.partner_locations[0].return_fee_amount, 0);
  assert.equal(rows.partner_locations[0].type, "airport");
});

test("locations fail closed on scope, country and timezone", () => {
  assert.ok(normalizeCaravelLocation({...location(), supplierId: "x"}, "sup-1").errors.includes("SUPPLIER_SCOPE_MISMATCH"));
  assert.ok(normalizeCaravelLocation({...location(), countryCode: "ZZ"}, "sup-1").errors.includes("COUNTRY_UNVERIFIED"));
  assert.ok(normalizeCaravelLocation({...location(), timezone: "Mars/Base"}, "sup-1").errors.includes("TIMEZONE_UNVERIFIED"));
});

test("class catalog row matches car_classes columns and keeps verified badges", () => {
  const cls = normalizeCaravelVehicleClass({...vehicle(), cardHoldRequired: null}, "sup-1");
  assert.equal(cls.ok, true);
  const [group] = normalizeGroups({groups: [cls.value]});
  // Shared normalizeGroups forces badges on; the Caravel sync keeps provider truth.
  assert.equal(group.features.noCardHold, true);
  const flags = new Map([["veh-cdmr", {noCreditCard: cls.value.features.noCreditCard, noCardHold: cls.value.features.noCardHold}]]);
  const [row] = caravelSyncRows("partner-1", [], [group], flags).car_classes;
  assert.equal(row.features.noCardHold, false);
  assert.equal(row.features.noCreditCard, false);
  assert.equal(row.class_code, "C");
  assert.equal(row.is_api_managed, true);
  assert.equal(row.deposit_amount, 0);
  assert.deepEqual(Object.keys(row).sort(), ["active", "bags", "class_code", "deposit_amount", "description", "driver_included",
    "example_model", "external_id", "features", "fuel_type", "image", "is_api_managed", "mileage_limit", "model",
    "partner_id", "public_price", "seats", "transmission"]);
});

test("extras map to Ride24 partner_extras shape, inactive until shared support", () => {
  const {rows, rejected} = caravelExtrasCatalog([
    {externalId: "s", name: "Seat", unitAmountMinor: 500, currency: "EUR", chargingUnit: "day", maxQuantity: 2, selectedQuantity: 0, ride24Code: "child_seat"},
    {externalId: "g", name: "GPS", unitAmountMinor: 2500, currency: "EUR", chargingUnit: "rental", maxQuantity: 1, selectedQuantity: 0, ride24Code: "gps"},
    {externalId: "w", name: "Wifi", unitAmountMinor: 100, currency: "EUR", chargingUnit: "day", maxQuantity: 1, selectedQuantity: 0, ride24Code: null},
    {externalId: "x", name: "Seat 2", unitAmountMinor: 100, currency: "EUR", chargingUnit: "day", maxQuantity: 1, selectedQuantity: 0, ride24Code: "child_seat"},
    {externalId: "p", name: "Seat", unitAmountMinor: 100, currency: "PLN", chargingUnit: "day", maxQuantity: 1, selectedQuantity: 0, ride24Code: "booster_seat"},
  ], "EUR");
  assert.deepEqual(rows[0], {code: "child_seat", name_pl: "Fotelik dziecięcy", name_en: "Child seat", amount: "5.00",
    billing: "day", max_quantity: 1, active: false, external_id: "s"});
  assert.equal(rows[1].amount, "25.00");
  assert.equal(rows[1].billing, "rental");
  assert.deepEqual(rejected.map(r => r.error), ["EXTRA_CODE_UNMAPPED", "EXTRA_CODE_DUPLICATE", "EXTRA_PRICE_UNVERIFIED"]);
});

test("minor units convert per ISO currency exponent and fail closed otherwise", () => {
  assert.equal(minorToMajor(12345, "EUR"), 123.45);
  assert.equal(minorToMajor(12345, "JPY"), 12345);
  assert.equal(minorToMajor(12345, "KWD"), 12.345);
  assert.equal(minorToMajor(100, "XXX"), null);
  assert.equal(minorToMajor(1.5, "EUR"), null);
  assert.equal(minorToMajor(-1, "EUR"), null);
});
