import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaravelOffer, buildCaravelOfferFromApi, caravelExtraFromApi, caravelExtrasCatalog, caravelLocationFromApi,
  caravelMileageFromPolicies, caravelQuoteFromApi, caravelSyncRows, caravelVehicleFromApi, minorToMajor,
  normalizeCaravelLocation, normalizeCaravelVehicleClass, ride24StandardPayload,
} from "../supabase/functions/_shared/caravel-normalize.ts";
// Real shared Ride24 code (read-only use): the Caravel output must pass unchanged.
import {normalizeGroups, normalizeLocations} from "../supabase/functions/_shared/partner-api.ts";
import {apiPriceTotals} from "../supabase/functions/_shared/api-quote-contract.mjs";

// Synthetic fixtures shaped like the OpenAPI v1.67.0 response schemas.
const NOW = 1900000000000;
const pickup = Date.UTC(2027, 0, 10, 21, 30);
const QID = "3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const eur = (amount) => ({amount, currency: "EUR"});
const supplier = () => ({supplier_id: "sup-1", name: "Sandbox", status: "active", currency: "EUR", tax_inclusive: true,
  payment_models: ["pay_on_arrival", "partial", "prepaid"]});
const policies = () => ({mileage: {type: "unlimited", source: "operator_default"}, fuel: {type: "full_to_full"},
  cancellation: {type: "free"}, deposit_payment_methods: [], tax_inclusive: true});
const protection = () => ({supplier_id: "sup-1", protection_id: "prot-premium", vehicle_id: "veh-cdmr", code: "PREM",
  name: "Premium", tier: "premium", description: null, excess: eur(0), deposit: eur(0), theft_excess: eur(0), price: eur(0),
  pricing_type: "included", payable: "prepaid", active: true, product_type: "waiver",
  covers: ["glass", "undercarriage", "tyres_and_wheels", "theft", "fire"], excludes: []});
const row = () => ({supplier_id: "sup-1", vehicle_id: "veh-cdmr", display_name: "VW Golf or similar", acriss: "CDMR",
  available_units: 3, price: eur(15000), price_type: "indicative", requires_quote: true, plan: "premium",
  protection: protection(), protection_options: [], line_items: [], tax_breakdown: [],
  totals: {}, min_driver_age: 21, max_driver_age: 75, seats: 5, doors: 5, large_bags: 1, small_bags: 2,
  transmission: "manual", fuel: "petrol", air_conditioning: true,
  images: [{url: "https://img.example/golf.jpg", role: "hero"}]});
const quoteData = () => ({currency: "EUR", rental_days: 3, quote_id: QID, plan: "premium", status: "active",
  expires_at: new Date(NOW + 600000).toISOString(), supplier_id: "sup-1",
  line_items: [
    {kind: "base_rate", code: "TIME_MILEAGE", label: "Rental", quantity: 3, unit_price: eur(4000), total: eur(12000), payable: "prepaid", taxable: true},
    {kind: "protection", code: "PREM", label: "Premium", quantity: 3, unit_price: eur(0), total: eur(0), payable: "prepaid", taxable: true},
    {kind: "fee", code: "OOH", label: "Out of hours", quantity: 1, unit_price: eur(3000), total: eur(3000), payable: "at_pickup", taxable: true, type: "out_of_hours", fee_id: "fee-ooh"},
  ],
  tax_breakdown: [], totals: {subtotal_ex_tax: eur(12400), tax_total: eur(2600), grand_total: eur(15000), pay_now: eur(12000), pay_at_pickup: eur(3000)},
  deposit: {amount: eur(0), type: "pre_authorization", refundable: true, collected_at: "pickup"}});
const hours = () => ({pickupLocalTime: "23:30", returnLocalTime: "10:00", pickupTimezone: "Europe/Zagreb",
  returnTimezone: "Europe/Zagreb", pickupOutsideHours: true, returnOutsideHours: false});
const ctx = () => ({scopeSupplierId: "sup-1", partnerCurrency: "EUR", pickupLocationId: "loc-spu", dropoffLocationId: "loc-spu",
  pickupEpochMs: pickup, dropoffEpochMs: pickup + 3 * 86400000, rentalDays: 3, driverAge: 30, nowEpochMs: NOW});
const apiOffer = () => ({availabilityRow: row(), policies: policies(), quoteData: quoteData(), supplier: supplier(), operatingHours: hours(), context: ctx()});
const location = () => ({supplier_id: "sup-1", location_id: "loc-spu", code: "SPU-APT", type: "airport", name: "Split Airport",
  iata: "SPU", address: {city: "Split", region: "Dalmatia", country: "HR"}, geo: null, timezone: "Europe/Zagreb",
  hours: null, out_of_hours: null, updated_at: "2026-11-13T10:00:00Z"});

test("documented availability row + quote pass shared normalizeGroups unchanged", () => {
  const built = buildCaravelOfferFromApi(apiOffer());
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const [group] = normalizeGroups(ride24StandardPayload({groups: [built.value]}));
  assert.equal(group.external_id, "veh-cdmr");
  assert.equal(group.class_code, "C");
  assert.equal(group.model, "VW Golf or similar"); // display_name used as is, no duplicate suffix
  assert.equal(group.image, "https://img.example/golf.jpg");
  assert.equal(group.transmission, "manual");
  assert.equal(group.fuel_type, "petrol");
  assert.equal(group.seats, 5);
  assert.equal(group.bags, 3); // large_bags + small_bags
  assert.equal(group.currency, "EUR");
  assert.equal(group.price_is_total, true);
  assert.equal(group.public_price_total, 150);
  assert.equal(group.public_price, 50);
  assert.equal(group.deposit_amount, 0);
  // Shared normalizeGroups stores "no limit" as 0; the card renders 0 as unlimited mileage.
  assert.equal(group.mileage_limit, 0);
  assert.equal(group.quote_reference, QID);
  assert.deepEqual(group.location_external_ids, ["loc-spu"]);
  assert.equal(group.features.fullInsurance, true);
  assert.equal(group.features.out_of_hours_amount, 30);
  assert.equal(group.provider_quote_data.protection_id, "prot-premium");
  // Shared sanitizePartnerPayload returns null-prototype objects; compare plain values.
  assert.deepEqual({...group.provider_quote_data.amounts_minor},
    {rental: 12000, extras: 0, mandatory_fees: 3000, total: 15000, pay_now: 12000, pay_at_pickup: 3000});
  assert.deepEqual(group.provider_quote_data.drivers.map(d => ({...d})), [{age: 30, role: "main"}]);
});

test("pay_on_arrival: partner payable is exactly grand_total; Ride24 fee is separate (shared apiPriceTotals)", () => {
  const [group] = normalizeGroups({groups: [buildCaravelOfferFromApi(apiOffer()).value]});
  // Caravel partner discount must be 0: Caravel collects grand_total at the desk.
  const totals = apiPriceTotals(group, 3, 0, 20);
  assert.equal(totals.partnerNetTotal, 150); // = grand_total, collected by Caravel
  assert.equal(totals.commissionTotal, 30); // Ride24 booking fee, charged separately via Stripe
  assert.equal(totals.finalTotal, 180);
  assert.equal(totals.finalTotal - totals.commissionTotal, 150); // fee is never added into grand_total
  assert.equal(group.features.payment_model, "pay_on_arrival");
});

test("quote lines are reconciled by kind with grand_total and the payment split", () => {
  const read = caravelQuoteFromApi(quoteData(), protection(), supplier());
  assert.equal(read.ok, true, JSON.stringify(read.errors));
  assert.equal(read.value.quote.rentalAmountMinor, 12000);
  assert.equal(read.value.quote.mandatoryFeesAmountMinor, 3000);
  assert.deepEqual(read.value.mandatoryCharges, [{externalId: "fee-ooh", label: "Out of hours", category: "out_of_hours", amountMinor: 3000, currency: "EUR"}]);
  const withDiscount = quoteData();
  withDiscount.line_items.push({kind: "discount", code: "PROMO", label: "Promo", quantity: 1, unit_price: eur(-1000), total: eur(-1000), payable: "prepaid", taxable: true});
  withDiscount.totals.grand_total = eur(14000); withDiscount.totals.pay_now = eur(11000);
  const d = caravelQuoteFromApi(withDiscount, protection(), supplier());
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  assert.equal(d.value.quote.rentalAmountMinor, 11000);
  assert.equal(d.value.discountMinor, -1000);
});

test("quote reader fails closed on documented edge cases", () => {
  const cases = [
    [q => { q.totals.grand_total = eur(14000); }, "LINE_TOTAL_MISMATCH"],
    [q => { q.totals.pay_at_pickup = eur(0); }, "PAYMENT_SPLIT_MISMATCH"],
    [q => { q.status = "expired"; }, "QUOTE_NOT_ACTIVE"],
    [q => { q.quote_id = "q-1"; }, "QUOTE_ID_REQUIRED"],
    [q => { q.line_items[0].kind = "tax"; }, "LINE_KIND_UNSUPPORTED"],
    [q => { q.line_items[0].total = {amount: 120.5, currency: "EUR"}; }, "LINE_AMOUNT_UNVERIFIED"],
    [q => { q.line_items[2].total = eur(-1); }, "LINE_AMOUNT_UNVERIFIED"],
    [q => { q.deposit = {amount: {amount: 0, currency: "GBP"}}; }, "DEPOSIT_UNVERIFIED"],
  ];
  for (const [patch, code] of cases) {
    const q = quoteData(); patch(q);
    const result = caravelQuoteFromApi(q, protection(), supplier());
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.includes(code), `${code} not in ${result.errors}`);
  }
  assert.ok(caravelQuoteFromApi(quoteData(), protection(), {...supplier(), tax_inclusive: false}).errors.includes("TAX_INCLUSIVE_PRICES_REQUIRED"));
  assert.ok(caravelQuoteFromApi(quoteData(), {...protection(), excess: undefined}, supplier()).errors.includes("EXCESS_UNVERIFIED"));
  assert.equal(caravelQuoteFromApi(undefined, undefined, undefined).ok, false);
});

test("night fee is inside the provider total and never added twice", () => {
  const p = apiOffer();
  p.quoteData.line_items = p.quoteData.line_items.slice(0, 2);
  p.quoteData.totals = {...p.quoteData.totals, grand_total: eur(12000), pay_at_pickup: eur(0)};
  assert.ok(buildCaravelOfferFromApi(p).errors.includes("PICKUP_FEE_UNVERIFIED"));
});

test("fails closed on unverified or misleading card data", () => {
  const cases = [
    [o => { o.availabilityRow.plan = "basic"; }, "PREMIUM_REQUIRED"],
    [o => { o.availabilityRow.protection.excess = eur(150000); }, "ZERO_EXCESS_REQUIRED"],
    [o => { o.quoteData.deposit.amount = eur(30000); }, "QUOTE_DEPOSIT_NOT_ZERO"],
    [o => { o.policies = {}; }, "MILEAGE_UNVERIFIED"],
    [o => { o.availabilityRow.acriss = "QDMR"; }, "VEHICLE_CLASS_UNVERIFIED"],
    [o => { o.availabilityRow.supplier_id = "other"; }, "SUPPLIER_SCOPE_MISMATCH"],
    [o => { delete o.availabilityRow.seats; }, "SEATS_UNVERIFIED"],
    [o => { delete o.availabilityRow.small_bags; }, "BAGS_UNVERIFIED"],
    [o => { delete o.availabilityRow.transmission; }, "TRANSMISSION_UNVERIFIED"],
    [o => { o.availabilityRow.fuel = "lpg"; }, "FUEL_UNVERIFIED"],
    [o => { o.context.partnerCurrency = "PLN"; }, "PARTNER_CURRENCY_MISMATCH"],
    [o => { o.context.driverAge = 19; }, "DRIVER_AGE_OUT_OF_RANGE"],
    [o => { o.availabilityRow.min_driver_age = 31; }, "DRIVER_AGE_OUT_OF_RANGE"],
    [o => { o.quoteData.expires_at = new Date(NOW).toISOString(); }, "QUOTE_EXPIRED"],
    [o => { o.availabilityRow.protection.protection_id = ""; }, "PROTECTION_ID_UNVERIFIED"],
  ];
  for (const [patch, code] of cases) {
    const o = apiOffer(); patch(o);
    const result = buildCaravelOfferFromApi(o);
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.includes(code), `${code} not in ${result.errors}`);
  }
});

test("non-https images are skipped, never shown", () => {
  const o = apiOffer();
  o.availabilityRow.images = [{url: "http://img.example/x.jpg"}, {url: "https://img.example/ok.jpg", role: "side"}];
  assert.equal(buildCaravelOfferFromApi(o).value.image, "https://img.example/ok.jpg");
  o.availabilityRow.images = [{url: "http://img.example/x.jpg"}];
  assert.equal(buildCaravelOfferFromApi(o).value.image, null);
});

test("selected extras in a quote are refused until shared code supports them", () => {
  const o = apiOffer();
  o.quoteData.line_items.push({kind: "extra", code: "SEAT", label: "Seat", quantity: 3, unit_price: eur(500), total: eur(1500), payable: "at_pickup", taxable: true});
  o.quoteData.totals = {...o.quoteData.totals, grand_total: eur(16500), pay_at_pickup: eur(4500)};
  assert.ok(buildCaravelOfferFromApi(o).errors.includes("SELECTED_EXTRAS_NOT_SUPPORTED"));
});

test("plugin hybrids, limited mileage and card-hold badge follow the documented fields", () => {
  const o = apiOffer();
  o.availabilityRow.fuel = "plugin_hybrid";
  o.policies.mileage = {type: "limited", included_km_per_day: 300, source: "operator_default"};
  const built = buildCaravelOfferFromApi(o);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const [group] = normalizeGroups({groups: [built.value]});
  assert.equal(group.fuel_type, "plugin_hybrid");
  assert.equal(group.mileage_limit, 300);
  assert.equal(built.value.features.noCardHold, true); // zero deposit = no pre-authorization
  // Derived: the deposit pre-authorization is the only card requirement the API states.
  assert.equal(built.value.features.noCreditCard, true);
  assert.equal(caravelMileageFromPolicies({mileage: {type: "limited"}}), null);
});

test("missing input never throws", () => {
  assert.equal(buildCaravelOffer(undefined).ok, false);
  assert.equal(buildCaravelOffer({}).ok, false);
  assert.equal(buildCaravelOfferFromApi(undefined).ok, false);
  assert.equal(normalizeCaravelLocation(undefined, "sup-1").ok, false);
  assert.equal(normalizeCaravelLocation(caravelLocationFromApi(undefined), "sup-1").ok, false);
  assert.equal(normalizeCaravelVehicleClass(caravelVehicleFromApi(undefined, undefined), "sup-1").ok, false);
});

test("documented location passes shared normalizeLocations and maps to partner_locations row", () => {
  const loc = normalizeCaravelLocation(caravelLocationFromApi(location()), "sup-1");
  assert.equal(loc.ok, true, JSON.stringify(loc.errors));
  const [normalized] = normalizeLocations({locations: [loc.value]});
  assert.deepEqual(
    {id: normalized.external_id, country: normalized.country, region: normalized.region, city: normalized.city,
      name: normalized.location_name, type: normalized.type, fee: normalized.extra_fee, active: normalized.active},
    {id: "loc-spu", country: "Croatia", region: "Dalmatia", city: "Split", name: "Split Airport", type: "airport", fee: false, active: true},
  );
  const rows = caravelSyncRows("partner-1", [normalized], [], new Map());
  assert.equal(rows.partner_locations[0].is_api_managed, true);
  assert.equal(rows.partner_locations[0].return_fee_amount, 0);
  assert.equal(rows.partner_locations[0].type, "airport");
});

test("location types map to Ride24 types; delivery areas and unstated fields fail closed", () => {
  const typed = (type) => normalizeCaravelLocation(caravelLocationFromApi({...location(), type}), "sup-1");
  assert.equal(typed("office").value.type, "city");
  assert.equal(typed("port").value.type, "port");
  assert.equal(typed("hotel").value.type, "hotel");
  assert.ok(typed("address").errors.includes("LOCATION_TYPE_UNSUPPORTED"));
  assert.ok(typed("station").errors.includes("LOCATION_TYPE_UNVERIFIED"));
  const noCountry = {...location(), address: {city: "Split"}};
  assert.ok(normalizeCaravelLocation(caravelLocationFromApi(noCountry), "sup-1").errors.includes("COUNTRY_UNVERIFIED"));
  assert.ok(normalizeCaravelLocation(caravelLocationFromApi({...location(), supplier_id: "x"}), "sup-1").errors.includes("SUPPLIER_SCOPE_MISMATCH"));
  assert.ok(normalizeCaravelLocation(caravelLocationFromApi({...location(), timezone: "Mars/Base"}), "sup-1").errors.includes("TIMEZONE_UNVERIFIED"));
});

test("reference vehicle -> car_classes row keeps verified badges and columns", () => {
  const ref = {supplier_id: "sup-1", vehicle_id: "veh-cdmr", acriss: "CDMR", acriss_decoded: null, name: "Golf group",
    display_name: "VW Golf or similar", seats: 5, large_bags: 1, small_bags: 2, transmission: "manual", fuel: "diesel",
    air_conditioning: true, min_driver_age: 21, max_driver_age: 75, images: []};
  const cls = normalizeCaravelVehicleClass(caravelVehicleFromApi(ref, policies()), "sup-1");
  assert.equal(cls.ok, true, JSON.stringify(cls.errors));
  const [group] = normalizeGroups({groups: [cls.value]});
  // Shared normalizeGroups forces badges on; the Caravel sync keeps provider truth.
  assert.equal(group.features.noCardHold, true);
  const flags = new Map([["veh-cdmr", {noCreditCard: cls.value.features.noCreditCard, noCardHold: cls.value.features.noCardHold}]]);
  const [row] = caravelSyncRows("partner-1", [], [group], flags).car_classes;
  assert.equal(row.features.noCardHold, false); // reference vehicles carry no deposit: unknown
  assert.equal(row.features.noCreditCard, false);
  assert.equal(row.image, null);
  assert.equal(row.class_code, "C");
  assert.equal(row.min_driver_age, 21);
  assert.deepEqual(Object.keys(row).sort(), ["active", "bags", "class_code", "deposit_amount", "description", "driver_included",
    "example_model", "external_id", "features", "fuel_type", "image", "is_api_managed", "mileage_limit", "min_driver_age",
    "model", "partner_id", "public_price", "seats", "transmission"]);
});

test("documented extras map to Ride24 partner_extras shape, inactive until shared support", () => {
  const extra = (patch) => ({supplier_id: "sup-1", extra_id: "x", code: "X", name: "X", description: null, category: "child_seat",
    pricing_type: "per_day", unit_price: eur(500), price_cap: null, quantity: {min: 0, max: 2, default: 0},
    requires_quantity: true, mutually_exclusive_group: null, payable: "at_pickup", tax_rate: 0.25, active: true, ...patch});
  const {rows, rejected} = caravelExtrasCatalog([
    caravelExtraFromApi(extra({extra_id: "seat"})),
    caravelExtraFromApi(extra({extra_id: "gps", category: "navigation", pricing_type: "per_rental", unit_price: eur(2500), requires_quantity: false, quantity: {min: 0, max: 1, default: 0}})),
    caravelExtraFromApi(extra({extra_id: "wifi", category: "connectivity"})),
    caravelExtraFromApi(extra({extra_id: "drv", category: "additional_driver", price_cap: eur(9000)})),
    caravelExtraFromApi(extra({extra_id: "seat2"})),
  ], "EUR");
  assert.deepEqual(rows[0], {code: "child_seat", name_pl: "Fotelik dziecięcy", name_en: "Child seat", amount: "5.00",
    billing: "day", max_quantity: 2, active: false, external_id: "seat", payable: "at_pickup"});
  assert.equal(rows[1].code, "gps");
  assert.equal(rows[1].amount, "25.00");
  assert.equal(rows[1].billing, "rental");
  assert.deepEqual(rejected.map(r => [r.externalId, r.error]), [
    ["wifi", "EXTRA_CODE_UNMAPPED"], ["drv", "EXTRA_PRICE_CAP_UNSUPPORTED"], ["seat2", "EXTRA_CODE_DUPLICATE"]]);
});

test("minor units convert per ISO currency exponent and fail closed otherwise", () => {
  assert.equal(minorToMajor(12345, "EUR"), 123.45);
  assert.equal(minorToMajor(12345, "JPY"), 12345);
  assert.equal(minorToMajor(12345, "KWD"), 12.345);
  assert.equal(minorToMajor(100, "XXX"), null);
  assert.equal(minorToMajor(1.5, "EUR"), null);
  assert.equal(minorToMajor(-1, "EUR"), null);
});
