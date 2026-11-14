// Stage 1b: protection_options, Premium confirmation by the final quote, rental bounds,
// EUR/GBP, incomplete or wrong amounts, configurable extras mapping, acceptance flow with a
// protection ladder. Synthetic data shaped like OpenAPI v1.67.0 — NOT the live API.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaravelOfferFromApi, caravelExtraFromApi, caravelExtrasCatalog, caravelProtectionCandidates, describeCaravelProtection,
  selectCaravelPremiumProtection, validateCaravelExtrasMapping, caravelQuoteFromApi,
} from "../supabase/functions/_shared/caravel-normalize.ts";
import {normalizeGroups} from "../supabase/functions/_shared/partner-api.ts";
import {runCaravelAcceptance} from "../supabase/functions/_shared/caravel-acceptance.mjs";

const NOW = 1900000000000;
const pickup = Date.UTC(2027, 0, 11, 10, 0); // Monday 11:00 Zagreb, inside desk hours
const QID = "3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const mny = (amount, currency = "EUR") => ({amount, currency});
const included = (c = "EUR") => ({protection_id: "prot-incl", vehicle_id: "veh-1", code: "INS_PREMIUM", tier: "premium", excess: mny(100000, c), deposit: mny(30000, c),
  price: mny(0, c), pricing_type: "included", payable: "prepaid"});
const zeroRisk = (c = "EUR", patch = {}) => ({protection_id: "prot-zero", vehicle_id: "veh-1", code: "SCDW_ZERO", tier: "premium", excess: mny(0, c), deposit: mny(0, c),
  theft_excess: mny(0, c), product_type: "waiver", covers: ["theft", "fire", "glass", "tyres_and_wheels", "undercarriage"], excludes: ["mirrors", "keys"],
  price: mny(1500, c), pricing_type: "per_day", payable: "at_pickup", totals_for_window: {grand_total: mny(17700, c)}, ...patch});
const row = (c = "EUR", options = [zeroRisk(c)]) => ({supplier_id: "sup-1", vehicle_id: "veh-1", display_name: "VW Golf or similar", acriss: "CDMR", plan: "premium",
  protection: included(c), protection_options: options, min_driver_age: 21, max_driver_age: 75, seats: 5, large_bags: 1, small_bags: 1,
  transmission: "manual", fuel: "petrol", images: []});
const quote = (c = "EUR", patch = {}) => ({currency: c, rental_days: 3, quote_id: QID, plan: "premium", status: "active", expires_at: new Date(NOW + 600000).toISOString(),
  line_items: [{kind: "base_rate", code: "TIME_MILEAGE", total: mny(13200, c)}, {kind: "protection", code: "SCDW_ZERO", total: mny(4500, c)}],
  totals: {grand_total: mny(17700, c), pay_now: mny(13200, c), pay_at_pickup: mny(4500, c)}, deposit: {amount: mny(0, c), type: "pre_authorization"}, ...patch});
const desk = {timezone: "Europe/Zagreb", hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => ({day, open: "08:00", close: "20:00"}))};
const supplier = (c = "EUR") => ({supplier_id: "sup-1", currency: c, tax_inclusive: true});
const policies = {mileage: {type: "unlimited"}, min_rental_days: 1, max_rental_days: 30};
const offer = (patch = {}, c = "EUR") => ({availabilityRow: row(c), protectionId: "prot-zero", policies, quoteData: quote(c), supplier: supplier(c),
  pickupLocation: desk, dropoffLocation: desk,
  context: {scopeSupplierId: "sup-1", partnerCurrency: c, pickupLocationId: "loc", dropoffLocationId: "loc", pickupEpochMs: pickup, dropoffEpochMs: pickup + 3 * 86400000,
    rentalDays: 3, driverAge: 30, nowEpochMs: NOW}, ...patch});

test("candidates: included package plus protection_options, de-duplicated", () => {
  const c = caravelProtectionCandidates({...row(), protection_options: [zeroRisk(), included(), {no_id: true}]});
  assert.deepEqual(c.map(x => [x.source, x.protection.protection_id]), [["included", "prot-incl"], ["option", "prot-zero"]]);
});

test("selection picks a protection_options package when the included one fails Premium", () => {
  const sel = selectCaravelPremiumProtection(row());
  assert.equal(sel.source, "option");
  assert.equal(sel.protection.protection_id, "prot-zero");
  assert.equal(selectCaravelPremiumProtection({...row(), plan: "medium"}), null); // never outside the Premium plan
  assert.equal(selectCaravelPremiumProtection(row("EUR", [zeroRisk("EUR", {theft_excess: undefined})])), null);
  assert.equal(selectCaravelPremiumProtection(row("EUR", [zeroRisk("EUR", {covers: ["theft", "fire", "glass", "tyres_and_wheels"]})])), null);
  assert.equal(selectCaravelPremiumProtection(row("EUR", [])), null);
});

test("an option is published only when the final quote confirms it", () => {
  const ok = buildCaravelOfferFromApi(offer());
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const [group] = normalizeGroups({groups: [ok.value]});
  assert.equal(group.public_price_total, 177); // base 132 + Premium option 45, Caravel's grand_total
  assert.equal(group.provider_quote_data.protection_id, "prot-zero");
  assert.equal(group.features.noCardHold, true);
  const cases = [
    [{quoteData: quote("EUR", {deposit: {amount: mny(30000)}})}, "QUOTE_DEPOSIT_NOT_ZERO"],
    [{quoteData: quote("EUR", {line_items: [{kind: "base_rate", code: "T", total: mny(17700)}]})}, "PROTECTION_NOT_IN_QUOTE"],
    [{protectionId: "prot-unknown"}, "PROTECTION_NOT_OFFERED_ON_ROW"],
    [{protectionId: undefined}, "ZERO_EXCESS_REQUIRED"], // default = included package, which is not zero-risk
    [{availabilityRow: {...row(), plan: "medium"}}, "PREMIUM_REQUIRED"],
    [{policies: {...policies, min_rental_days: 4}}, "RENTAL_LENGTH_OUT_OF_BOUNDS"],
    [{policies: {...policies, max_rental_days: 2}}, "RENTAL_LENGTH_OUT_OF_BOUNDS"],
  ];
  for (const [patch, code] of cases) {
    const r = buildCaravelOfferFromApi(offer(patch));
    assert.equal(r.ok, false, code);
    assert.ok(r.errors.includes(code), `${code} not in ${r.errors}`);
  }
});

test("GBP supplier: same rules, GBP amounts, currency must match the partner", () => {
  const gbp = buildCaravelOfferFromApi(offer({}, "GBP"));
  assert.equal(gbp.ok, true, JSON.stringify(gbp.errors));
  assert.equal(gbp.value.currency, "GBP");
  const mismatch = buildCaravelOfferFromApi({...offer({}, "GBP"), context: {...offer({}, "GBP").context, partnerCurrency: "EUR"}});
  assert.ok(mismatch.errors.includes("PARTNER_CURRENCY_MISMATCH"));
});

test("incomplete or wrong amounts and surcharges fail closed; Caravel fees are not added twice", () => {
  const q = (patch) => caravelQuoteFromApi(quote("EUR", patch), zeroRisk(), supplier());
  assert.ok(q({totals: undefined}).errors.includes("TOTALS_UNVERIFIED"));
  assert.ok(q({line_items: [{kind: "base_rate", code: "T", total: {amount: 132.5, currency: "EUR"}}]}).errors.includes("LINE_AMOUNT_UNVERIFIED"));
  assert.ok(q({line_items: [{kind: "fee", type: "young_driver", code: "YD", total: mny(-100)}]}).errors.includes("LINE_AMOUNT_UNVERIFIED"));
  assert.ok(q({line_items: [{kind: "base_rate", code: "T", total: mny(13200, "GBP")}]}).errors.includes("LINE_AMOUNT_UNVERIFIED"));
  assert.ok(q({rental_days: 0}).errors.includes("RENTAL_DAYS_UNVERIFIED"));
  // Young-driver + one-way surcharges priced by Caravel reconcile into the provider total.
  const withFees = quote("EUR", {
    line_items: [...quote().line_items, {kind: "fee", type: "young_driver", code: "YD", fee_id: "f1", label: "Young driver", total: mny(2000)},
      {kind: "fee", type: "one_way", code: "OW", fee_id: "f2", label: "One way", total: mny(5000)}],
    totals: {grand_total: mny(24700), pay_now: mny(13200), pay_at_pickup: mny(11500)}});
  const r = caravelQuoteFromApi(withFees, zeroRisk(), supplier());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.quote.mandatoryFeesAmountMinor, 7000);
  const built = buildCaravelOfferFromApi(offer({quoteData: withFees}));
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.value.public_price_total, 247); // = grand_total, nothing added on top
  // Night pickup with no Caravel out-of-hours line is refused.
  const night = buildCaravelOfferFromApi(offer({context: {...offer().context, pickupEpochMs: Date.UTC(2027, 0, 11, 21, 30), dropoffEpochMs: Date.UTC(2027, 0, 14, 21, 30)}}));
  assert.ok(night.errors.includes("PICKUP_FEE_UNVERIFIED"));
});

test("diagnostic description: exact amounts, stated terms and missing fields", () => {
  const d = describeCaravelProtection("premium", included(), "included", {amount: mny(30000)});
  assert.deepEqual([d.excess_minor, d.deposit_minor, d.theft_excess_minor, d.currency, d.code], [100000, 30000, null, "EUR", "INS_PREMIUM"]);
  assert.deepEqual(d.missing_fields, ["theft_excess", "product_type", "covers", "excludes"]);
  assert.ok(d.premium.includes("ZERO_DEPOSIT_REQUIRED") && d.premium.includes("QUOTE_DEPOSIT_NOT_ZERO"));
  const z = describeCaravelProtection("premium", zeroRisk(), "option");
  assert.equal(z.premium, "PUBLISHABLE");
  assert.equal(z.window_total_minor, 17700);
  assert.deepEqual(z.missing_fields, []);
  assert.equal(JSON.stringify(d).match(/@|first_name|last_name|email|phone/), null); // no personal data fields
});

test("extras: 'other' is never guessed; only confirmed mappings assign it", () => {
  const raw = (patch) => ({supplier_id: "sup-1", extra_id: "e1", code: "CHILD", supplier_code: "CS", name: "Child seat", category: "other",
    pricing_type: "per_day", unit_price: mny(500), price_cap: null, quantity: {min: 0, max: 2, default: 0}, requires_quantity: true, payable: "at_pickup", ...patch});
  const unmapped = caravelExtraFromApi(raw());
  assert.deepEqual([unmapped.ride24Code, unmapped.mappingSource], [null, "unmapped"]); // name "Child seat" is NOT used to guess
  assert.deepEqual([caravelExtraFromApi(raw({category: "child_seat"})).ride24Code, caravelExtraFromApi(raw({category: "child_seat"})).mappingSource], ["child_seat", "category"]);
  const confirmed = {"sup-1:e1": "child_seat"};
  assert.deepEqual([caravelExtraFromApi(raw(), confirmed).ride24Code, caravelExtraFromApi(raw(), confirmed).mappingSource], ["child_seat", "confirmed"]);
  assert.equal(caravelExtraFromApi(raw(), {"sup-1:code:CHILD": "booster_seat"}).ride24Code, "booster_seat");
  assert.equal(caravelExtraFromApi(raw(), {"sup-1:supplier_code:CS": "child_seat"}).ride24Code, "child_seat");
  assert.equal(caravelExtraFromApi(raw({supplier_id: "sup-2"}), confirmed).ride24Code, null); // scoped to its supplier
  assert.equal(caravelExtraFromApi(raw({category: "navigation"}), {"sup-1:e1": null}).ride24Code, null); // confirmed "keep unmapped"
  const {rows} = caravelExtrasCatalog([caravelExtraFromApi(raw(), confirmed)], "EUR");
  assert.deepEqual([rows[0].code, rows[0].billing, rows[0].max_quantity, rows[0].active], ["child_seat", "day", 2, false]);
  assert.deepEqual(validateCaravelExtrasMapping({"sup-1:e1": "child_seat", "sup-1:code:X": null}), {ok: true});
  assert.equal(validateCaravelExtrasMapping({"sup-1:e1": "snow_chains"}).ok, false);
  assert.equal(validateCaravelExtrasMapping({"no-colon": "gps"}).ok, false);
  assert.equal(validateCaravelExtrasMapping(null).ok, false);
});

// ---- acceptance flow on a mocked sandbox with a protection ladder ----
const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });
function ladderMock({optionZero = true} = {}) {
  const calls = [];
  const opt = optionZero ? zeroRisk("EUR", {vehicle_id: "veh-1"}) : {...zeroRisk("EUR"), deposit: mny(10000)};
  const r = {...row("EUR", [opt]), supplier_id: "sup-1"};
  const quotes = new Map(), bookings = new Map(), idem = new Map();
  let n = 0; const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  globalThis.fetch = async (url, options) => {
    const u = new URL(String(url)); const h = options?.headers ?? {}; const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({method: options?.method, path: u.pathname, body});
    const ok = (data, status = 200) => new Response(JSON.stringify({request_id: "m", data, meta: {}}), {status});
    const err = (code, status) => new Response(JSON.stringify({error: {code, request_id: "m"}}), {status});
    const p = u.pathname;
    if (p === "/v1/capabilities") return ok({environment: "sandbox", api_version: "1.67.0"});
    if (p === "/v1/whoami") return ok({scopes: []});
    if (p === "/v1/suppliers") return ok([{supplier_id: "sup-1", currency: "EUR", tax_inclusive: true, payment_models: ["pay_on_arrival"]}]);
    if (p === "/v1/reference/constants") return ok({});
    if (p === "/v1/reference/locations") return ok([{supplier_id: "sup-1", location_id: "loc", type: "airport", name: "A", address: {country: "HR"}, timezone: "Europe/Zagreb", hours: desk.hours}]);
    if (p === "/v1/reference/policies") return ok([policies]);
    if (p === "/v1/reference/vehicles") return ok([r]);
    if (p === "/v1/reference/protections") return ok([included()]);
    if (p === "/v1/reference/extras" || p === "/v1/reference/fees") return ok([]);
    if (p === "/v1/availability") return ok([r]);
    if (p === "/v1/quote") {
      const key = h["Idempotency-Key"], sig = JSON.stringify(body);
      if (idem.has(key)) return idem.get(key).sig === sig ? ok(quotes.get(idem.get(key).id)) : err("idempotency_key_reused", 422);
      if (body.vehicle_id !== "veh-1") return err("validation_error", 422);
      const usesOption = body.protection_id === opt.protection_id;
      const q = {...quote("EUR"), quote_id: uuid(),
        line_items: [{kind: "base_rate", code: "T", total: mny(13200)}, {kind: "protection", code: usesOption ? opt.code : "INS_PREMIUM", total: mny(usesOption ? 4500 : 0)}],
        totals: {grand_total: mny(usesOption ? 17700 : 13200), pay_now: mny(13200), pay_at_pickup: mny(usesOption ? 4500 : 0)},
        deposit: {amount: mny(usesOption ? opt.deposit.amount : 30000), type: "pre_authorization"}};
      quotes.set(q.quote_id, q); idem.set(key, {sig, id: q.quote_id});
      return ok(q, 201);
    }
    if (p === "/v1/bookings" && options?.method === "POST") {
      if (idem.has(h["Idempotency-Key"])) return ok(bookings.get(idem.get(h["Idempotency-Key"]).id));
      if ([...bookings.values()].some(b => b.quote_id === body.quote_id)) return err("quote_consumed", 409);
      const q = quotes.get(body.quote_id);
      const b = {booking_id: uuid(), quote_id: body.quote_id, status: "confirmed", revision: 1, price: {totals: {grand_total: q.totals.grand_total}},
        protection: {excess: mny(0), deposit: mny(0)}, payment: {model: body.payment_model, amount_on_arrival: q.totals.grand_total}};
      bookings.set(b.booking_id, b); idem.set(h["Idempotency-Key"], {id: b.booking_id});
      return ok(b, 201);
    }
    const g = p.match(/^\/v1\/bookings\/([^/]+)$/); if (g) return ok(bookings.get(g[1]));
    const c = p.match(/^\/v1\/bookings\/([^/]+)\/cancel$/);
    if (c) { const b = bookings.get(c[1]); if (b.status === "cancelled") return body.expected_revision === b.revision ? ok(b) : err("invalid_transition", 409);
      Object.assign(b, {status: "cancelled", revision: b.revision + 1, cancellation: {fee: mny(0), refund: mny(0)}}); return ok(b); }
    return err("not_found", 404);
  };
  return {calls, bookings};
}

test("acceptance books the zero-risk protection_options package, never the included one", async () => {
  const {calls, bookings} = ladderMock();
  const r = await runCaravelAcceptance("FAKE-KEY-unit-ladder", {booking: true, supplierId: "sup-1"});
  assert.equal(r.failed, false, JSON.stringify(r.results.filter(x => !x.outcome.startsWith("OK"))));
  const premiumQuote = calls.find(c => c.path === "/v1/quote" && c.body.plan === "premium" && c.body.vehicle_id === "veh-1");
  assert.equal(premiumQuote.body.protection_id, "prot-zero");
  assert.equal(bookings.size, 1);
  assert.ok([...bookings.values()].every(b => b.status === "cancelled"));
  const avail = r.results.find(x => x.endpoint.includes("availability (3 days"));
  const prots = avail.summary.premium_rows[0].protections;
  assert.deepEqual(prots.map(p => [p.source, p.premium === "PUBLISHABLE"]), [["included", false], ["option", true]]);
  assert.equal(prots[0].deposit_minor, 30000);
});

test("acceptance books nothing when no package (included or option) passes Premium", async () => {
  const {calls, bookings} = ladderMock({optionZero: false});
  const r = await runCaravelAcceptance("FAKE-KEY-unit-ladder", {booking: true, supplierId: "sup-1"});
  assert.equal(bookings.size, 0);
  assert.equal(calls.some(c => c.method === "POST" && c.path === "/v1/bookings"), false);
  assert.ok(r.results.some(x => x.outcome === "NOT RUN" && String(x.summary).includes("premiumOnly")));
});
