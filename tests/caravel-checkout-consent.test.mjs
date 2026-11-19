import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {computeCaravelTermsContentHash} from "../supabase/functions/_shared/caravel-terms-canonical.ts";
import {loadCaravelRelease, reviewedTermsFromRow} from "../supabase/functions/_shared/caravel-release.ts";
import {buildCaravelConsentView, buildCaravelCommitPayload} from "../supabase/functions/_shared/caravel-consent.ts";
import {handleCaravelBookingRequest, nbpRateStrict} from "../supabase/functions/_shared/caravel-booking-request.ts";
import {caravelLocalInstant, searchCaravelOffers} from "../supabase/functions/_shared/caravel-search.ts";
import {PARTNER, NOW, body, termsRow, fakeDb, releasedState, quoteRow} from "./fixtures/caravel/checkout-fixtures.mjs";

const QROW = "4da4d7ca-7244-4416-ab7b-2632bd5f882a";
const CAR = "d20bbca4-678c-4abf-bf4d-cf5356220170";
const USER = "0a1b2c3d-4e5f-4a6b-8c7d-1234567890ab";
const PICK = "0aa18fda-4e7c-4b31-98b9-480d53e086e8";
const ctx = (patch = {}) => ({clientId: USER, clientEmail: "sandbox@example.test", clientPhone: "+48000000000",
  mainDriverName: "Jan Kowalski", mainDriverAge: 30, pickupLocationId: PICK, dropoffLocationId: PICK,
  pickupLocationName: "Athens Airport", returnLocationName: "Athens Airport", pickupTime: "10:00", returnTime: "10:00",
  exchangeRate: 4.3, ...patch});

test("release gate: closed by default (production today), opens only with certification + reviewed, re-hashed terms", async () => {
  const closed = {caravel_release_control: [{singleton: true, certified: false, allow_customer_checkout: false}]};
  assert.deepEqual(await loadCaravelRelease(fakeDb(closed)), {open: false, reason: "CARAVEL_NOT_CERTIFIED"});
  const s = await releasedState(); s.caravel_release_control[0].allow_customer_checkout = false;
  assert.equal((await loadCaravelRelease(fakeDb(s))).reason, "CARAVEL_CHECKOUT_NOT_RELEASED");
  const p = await releasedState(); p.partners[0].api_enabled = false;
  assert.equal((await loadCaravelRelease(fakeDb(p))).reason, "CARAVEL_PARTNER_NOT_ACTIVE");
  const tampered = await releasedState(); tampered.caravel_reviewed_terms[0].body.clauses[2].clauses[0].paragraphs[0][0].text = "No fee.";
  assert.equal((await loadCaravelRelease(fakeDb(tampered))).reason, "CARAVEL_REVIEWED_TERMS_HASH_MISMATCH");
  const missing = await releasedState({caravel_reviewed_terms: []});
  assert.equal((await loadCaravelRelease(fakeDb(missing))).reason, "CARAVEL_REVIEWED_TERMS_MISSING");
  const open = await loadCaravelRelease(fakeDb(await releasedState()));
  assert.equal(open.open, true);
  assert.equal(open.review.damageAdministrationFeeMinor, 10000);
  assert.equal(reviewedTermsFromRow({...(await termsRow()), format: "html"}), null);
});

test("consent view: verified terms, every exclusion, exact admin fee, money split, no full-insurance claim", async () => {
  const release = await loadCaravelRelease(fakeDb(await releasedState()));
  const v = buildCaravelConsentView(await quoteRow(), release, "pl", NOW);
  assert.equal(v.terms.document_id, "caravel-en-v5");
  assert.match(v.terms.html, /<strong>An administration fee of EUR 100/);
  assert.deepEqual(v.coverage.excluded.map((x) => x.label), ["szyby", "opony i koła", "podwozie"]);
  assert.equal(v.coverage.full_insurance_claim_allowed, false);
  assert.equal(v.coverage.damage_admin_fee_minor, 10000);
  assert.equal(v.money.rental_at_pickup, "150.00 EUR");
  assert.equal(v.money.customer_total,"165.00 EUR");
  assert.equal(v.money.customer_total_minor,16500);
  assert.equal(v.money.ride24_fee_minor,1500);
  assert.equal(v.money.charged_by_stripe, "ride24_fee_only");
  const all = v.statements.join(" ");
  assert.match(all, /płacisz Caravel przy odbiorze/);
  assert.match(all, /Stripe pobiera wyłącznie osobną opłatę rezerwacyjną Ride24/);
  assert.match(all, /NIE obejmuje: szyby, opony i koła, podwozie/);
  assert.match(all, /100\.00 EUR za wynajem \(nie za każde zdarzenie\), także przy pakiecie Premium \(pkt 7\.1/);
  assert.match(all, /kategorię pojazdu, nie konkretny model/);
  // EN v5 key clauses (Caravel 18 Nov 2026): 17, 27.1, 7.4, 13 and the no-double-payment guarantee.
  assert.match(all, /gotówką lub kartą Visa\/Mastercard/);
  assert.match(all, /Karta kredytowa ani depozyt nie są wymagane przy pakiecie Premium \(pkt 17\)/);
  assert.match(all, /płacisz przy zwrocie gotówką lub kartą; kwoty ustalone później Caravel fakturuje .* \(pkt 27\.1\)/);
  assert.match(all, /Mandaty, parkingi, opłaty drogowe .* \(pkt 7\.4\)/);
  assert.match(all, /bezpłatnie anulować do momentu odbioru \(pkt 13\)/);
  assert.match(all, /nie płacisz dwa razy/);
  assert.match(all, /udział własny przy kradzieży 0/);
  assert.doesNotMatch(all, /pełne ubezpieczenie(?! bez wyłączeń)/);
  const en = buildCaravelConsentView(await quoteRow(), release, "en", NOW);
  assert.match(en.statements.join(" "), /not full cover without exclusions/);
});

test("consent price breakdown translates provider fees and reconciles exact total",async()=>{
 const release=await loadCaravelRelease(fakeDb(await releasedState()));
 const row=await quoteRow({}, {price_breakdown:{
   version:1,currency:"EUR",rental_minor:10000,mandatory_fees_minor:5000,
   extras_minor:0,total_minor:15000,fees:[
    {code:"fee-1",type:"young_driver",label:"Young driver 3 days",amount_minor:3300},
    {code:"fee-2",type:"one_way",label:"One-way return",amount_minor:1700},
   ],
 }});
 const v=buildCaravelConsentView(row,release,"pl",NOW);
 assert.deepEqual(v.money.breakdown,{
  rental_base:"100.00 EUR",fee_total:"50.00 EUR",extras_total:"0.00 EUR",partner_total:"150.00 EUR",extras:[],
  fees:[
   {label:"Młody kierowca",original_label:"Young driver 3 days",type:"young_driver",amount:"33.00 EUR"},
   {label:"Zwrot w innym punkcie",original_label:"One-way return",type:"one_way",amount:"17.00 EUR"},
  ],
 });
 assert.equal(v.money.rental_at_pickup,"150.00 EUR");
 assert.equal(v.money.ride24_fee,"15.00 EUR");
 assert.equal(v.money.customer_total,"165.00 EUR");
 assert.equal(buildCaravelConsentView(await quoteRow({final_total:164}),release,"pl",NOW),null,"gross must reconcile provider and platform charges");
 for(const broken of [
  {version:1,currency:"EUR",rental_minor:10000,mandatory_fees_minor:4900,extras_minor:0,total_minor:15000,fees:[]},
  {version:1,currency:"USD",rental_minor:15000,mandatory_fees_minor:0,extras_minor:0,total_minor:15000,fees:[]},
 ]) {
  const q=await quoteRow({}, {price_breakdown:broken});
  assert.equal(buildCaravelConsentView(q,release,"pl",NOW),null,"incorrect breakdown must fail closed");
 }
});
test("consent view refuses: release closed, quote of other terms version, prepayment, expiring or used quote", async () => {
  const release = await loadCaravelRelease(fakeDb(await releasedState()));
  assert.equal(buildCaravelConsentView(await quoteRow(), {open: false, reason: "x"}, "pl", NOW), null);
  assert.equal(buildCaravelConsentView(await quoteRow({}, {terms_document_id: "caravel-en-v4"}), release, "pl", NOW), null);
  assert.equal(buildCaravelConsentView(await quoteRow({}, {amounts_minor: {total: 15000, pay_now: 5000, pay_at_pickup: 10000}}), release, "pl", NOW), null);
  assert.equal(buildCaravelConsentView(await quoteRow({expires_at: new Date(NOW + 5 * 60000).toISOString()}), release, "pl", NOW), null);
  assert.equal(buildCaravelConsentView(await quoteRow({used_at: "2026-12-01T09:00:00Z"}), release, "pl", NOW), null);
  assert.equal(buildCaravelConsentView(await quoteRow({}, {damage_administration_fee_minor: undefined}), release, "pl", NOW), null);
});

test("commit payload: echo must match what was shown; terms version change invalidates old consent", async () => {
  const release = await loadCaravelRelease(fakeDb(await releasedState()));
  const row = await quoteRow();
  const echo = {...buildCaravelConsentView(row, release, "pl", NOW).echo, accepted: true, coverage_acknowledged: true};
  const ok = buildCaravelCommitPayload(row, release, echo, ctx(), NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.online_payment_pln, 64.5, "Ride24 fee 15 EUR x 4.3 PLN; rental never prepaid");
  assert.deepEqual(ok.payload.caravel_coverage_excluded_codes, ["glass", "tyres_and_wheels", "undercarriage"]);
  assert.equal(ok.payload.caravel_coverage_damage_admin_fee_minor, 10000);
  assert.equal(ok.payload.terms_accepted, true);
  for (const bad of [{...echo, accepted: false}, {...echo, coverage_acknowledged: undefined},
    {...echo, terms_content_hash: "b".repeat(64)}, {...echo, terms_document_id: "caravel-en-v4"},
    {...echo, excluded_codes: ["glass"]}, {...echo, damage_admin_fee_minor: 0}])
    assert.deepEqual(buildCaravelCommitPayload(row, release, bad, ctx(), NOW), {ok: false, code: "CARAVEL_TERMS_CONSENT_STALE_OR_MISSING"});
  // New document approved after the customer saw v4: the old echo no longer matches.
  const v5Body = {...body(), title: "Caravel Rental Terms v6"};
  const v5 = await releasedState({caravel_reviewed_terms: [await termsRow({document_id: "caravel-en-v6", version: 6, title: "Caravel Rental Terms v6", body: v5Body, content_hash: await computeCaravelTermsContentHash(v5Body)})]});
  v5.caravel_release_control[0].terms_document_id = "caravel-en-v6"; v5.caravel_release_control[0].terms_content_hash = v5.caravel_reviewed_terms[0].content_hash;
  const r5 = await loadCaravelRelease(fakeDb(v5));
  assert.equal(r5.open, true);
  assert.equal(buildCaravelCommitPayload(row, r5, echo, ctx(), NOW).ok, false);
  assert.deepEqual(buildCaravelCommitPayload(row, release, echo, ctx({mainDriverAge: 22}), NOW), {ok: false, code: "CARAVEL_DRIVER_AGE_REQUOTE_REQUIRED"});
  assert.deepEqual(buildCaravelCommitPayload(row, release, echo, ctx({exchangeRate: 0}), NOW), {ok: false, code: "CARAVEL_CUSTOMER_INVALID"});
});

async function requestState() {
  const s = await releasedState();
  s.api_quotes = [await quoteRow()];
  s.profiles = [{id: USER, name: "Jan Kowalski", phone: "+48000000000", age: 30}];
  s.drivers = [{id: "9d9d9d9d-1111-4222-8333-444455556666", user_id: USER, name: "Anna Nowak", age: 22}];
  s.partner_locations = [{id: PICK, partner_id: PARTNER, external_id: "ath-airport", location_name: "Athens Airport", active: true, is_api_managed: true}];
  return s;
}
const deps = (s, patch = {}) => ({admin: fakeDb(s), userId: USER, userEmail: "sandbox@example.test", exchangeRate: async () => 4.3, nowMs: NOW, ...patch});

test("endpoint: closed release -> 409 before reading the quote (today's production)", async () => {
  const s = {caravel_release_control: [{singleton: true, certified: false}]};
  const r = await handleCaravelBookingRequest(deps(s), {action: "consent-view", api_quote_id: QROW});
  assert.equal(r.status, 409); assert.equal(r.body.code, "CARAVEL_CERTIFICATION_PENDING");
});

test("endpoint: consent-view then book -> atomic RPC with verified payload; no FX fallback", async () => {
  const s = await requestState();
  const view = await handleCaravelBookingRequest(deps(s), {action: "consent-view", api_quote_id: QROW, lang: "en"});
  assert.equal(view.status, 200);
  const consent = {...view.body.consent.echo, accepted: true, coverage_acknowledged: true};
  const r = await handleCaravelBookingRequest(deps(s), {action: "book", api_quote_id: QROW, consent});
  assert.equal(r.status, 200); assert.equal(r.body.payment_required, true);
  assert.equal(s.rpc[0].name, "caravel_commit_pending_booking");
  assert.equal(s.rpc[0].args.p_payload.pickup_location_id, PICK);
  const fx = await handleCaravelBookingRequest(deps(s, {exchangeRate: async () => { throw new Error("down"); }}), {action: "book", api_quote_id: QROW, consent});
  assert.equal(fx.status, 503);
  const stale = await handleCaravelBookingRequest(deps(s), {action: "book", api_quote_id: QROW, consent: {...consent, terms_content_hash: "c".repeat(64)}});
  assert.equal(stale.body.code, "CARAVEL_TERMS_CONSENT_STALE_OR_MISSING");
  const extra = await handleCaravelBookingRequest(deps(s), {action: "book", api_quote_id: QROW, consent, additional_driver_id: "x"});
  assert.equal(extra.body.code, "CARAVEL_ADDITIONAL_DRIVER_UNSUPPORTED");
  await assert.rejects(nbpRateStrict("EUR", async () => new Response("", {status: 500})), /FX_UNAVAILABLE/);
  assert.equal(await nbpRateStrict("EUR", async () => Response.json({rates: [{mid: 4.31}]})), 4.31);
});

test("endpoint: other driver age -> server re-quotes and requires a fresh confirmation (never books old price)", async () => {
  const s = await requestState();
  const fresh = await quoteRow({id: "5ea5e8db-7244-4416-ab7b-2632bd5f882a", partner_net_total: 180, final_total: 198, commission_total: 18},
    {drivers: [{age: 22, role: "main"}], amounts_minor: {total: 18000, pay_now: 0, pay_at_pickup: 18000}});
  s.api_quotes.push(fresh);
  const consent = {...buildCaravelConsentView(s.api_quotes[0], await loadCaravelRelease(fakeDb(s)), "pl", NOW).echo, accepted: true, coverage_acknowledged: true};
  const r = await handleCaravelBookingRequest(deps(s, {requote: async (_q, age) => { assert.equal(age, 22); return {ok: true, apiQuoteId: fresh.id}; }}),
    {action: "book", api_quote_id: QROW, driver_id: "9d9d9d9d-1111-4222-8333-444455556666", consent});
  assert.equal(r.status, 409); assert.equal(r.body.code, "CARAVEL_REQUOTED_FOR_DRIVER_AGE");
  assert.equal(r.body.api_quote_id, fresh.id);
  assert.equal(r.body.consent.money.rental_at_pickup, "180.00 EUR");
  assert.equal((s.rpc ?? []).length, 0);
});

test("local station time -> offset instant (Athens winter/summer, DST gap refused)", () => {
  assert.equal(caravelLocalInstant("2027-01-10", "10:00", "Europe/Athens"), "2027-01-10T10:00:00+02:00");
  assert.equal(caravelLocalInstant("2027-07-10", "10:00", "Europe/Athens"), "2027-07-10T10:00:00+03:00");
  assert.equal(caravelLocalInstant("2027-03-28", "03:30", "Europe/Athens"), null);
  assert.equal(caravelLocalInstant("2027-01-10", "10:00", "Europe/London"), "2027-01-10T10:00:00+00:00");
});

test("search: only Premium rows passing Ride24 policy are quoted; production only; release closed -> nothing", async () => {
  const release = await loadCaravelRelease(fakeDb(await releasedState()));
  const calls = [];
  const prot = (id, patch = {}) => ({protection_id: id, tier: "premium", product_type: "waiver", deposit: {amount: 0, currency: "EUR"},
    excess: {amount: 0, currency: "EUR"}, theft_excess: {amount: 0, currency: "EUR"}, covers: ["bodywork", "theft", "fire"],
    excludes: ["glass", "tyres_and_wheels", "undercarriage"], ...patch});
  const client = {environment: "production",
    async locations() { return {data: [{location_id: "ath-airport", timezone: "Europe/Athens"}]}; },
    async availability(p) { calls.push(p); return {data: [
      {vehicle_id: "opaque-group", plan: "premium", protection: prot("pro-premium")},
      {vehicle_id: "opaque-group", plan: "medium", protection: prot("pro-medium", {tier: "medium", excess: {amount: 50000, currency: "EUR"}})},
      {vehicle_id: "risky", plan: "premium", protection: prot("pro-risky", {deposit: {amount: 30000, currency: "EUR"}})},
      {vehicle_id: "unsynced", plan: "premium", protection: prot("pro-x")}]}; },
    async suppliers() { throw new Error("issuance mocked by admin rejection"); }, async referenceTerms() { return {data: []}; },
    async quote() { throw new Error("not reached"); }};
  const r = await searchCaravelOffers({admin: {from() { throw new Error("db"); }}, client, release,
    pickup: {id: PICK, external_id: "ath-airport"}, dropoff: {id: PICK, external_id: "ath-airport"},
    pickupDate: "2027-01-10", returnDate: "2027-01-13", pickupTime: "10:00", returnTime: "10:00", days: 3, driverAge: 30,
    currency: "EUR", maxOffers: 5, nowMs: NOW,
    loadCarClasses: async () => new Map([["opaque-group", {id: CAR, active: true}], ["risky", {id: CAR, active: true}]])});
  assert.equal(calls[0].pickup, "2027-01-10T10:00:00+02:00");
  assert.equal(r.offers.length, 0);
  assert.equal(r.rejected.NOT_PREMIUM_ROW, 1);
  assert.equal(r.rejected.PREMIUM_POLICY_NOT_MET, 1);
  assert.equal(r.rejected.CATEGORY_NOT_SYNCED, 1);
  assert.equal(r.rejected.CARAVEL_QUOTE_DB_CONTEXT_FAILED, 1, "the policy-passing row reached strict issuance");
  assert.deepEqual((await searchCaravelOffers({client, release: {open: false, reason: "x"}})).rejected, {CARAVEL_RELEASE_CLOSED: 1});
  assert.deepEqual((await searchCaravelOffers({client: {...client, environment: "sandbox"}, release})).rejected, {CARAVEL_PRODUCTION_ONLY: 1});
});

test("search-api / checkout / web wiring keeps every other partner path and fails closed for Caravel", () => {
  const search = readFileSync(new URL("../supabase/functions/search-api/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(search, /caravelRelease \?\?= await loadCaravelRelease\(admin\);\n\s+if \(!caravelRelease\.open\) uniquePartners\.delete\(partnerId\);/);
  assert.match(search, /if \(caravelRelease\?\.open && isCaravelBooking\(/);
  assert.match(search, /noCreditCard: release\.terms\.noCardRequired === true,/);
  const checkout = readFileSync(new URL("../supabase/functions/create_checkout_session/index.ts", import.meta.url), "utf8");
  assert.match(checkout, /if \(isCaravelBooking\(booking\)\) \{\s+const release = await loadCaravelRelease\(admin\);/);
  assert.match(checkout, /booking\.caravel_terms_document_id !== release\.terms\.documentId/);
  const generic = readFileSync(new URL("../supabase/functions/create-booking-request/index.ts", import.meta.url), "utf8");
  assert.match(generic, /code: CARAVEL_PRE_CERTIFICATION_ERROR/, "generic handler still refuses Caravel");
  const html = readFileSync(new URL("../klient.html", import.meta.url), "utf8");
  assert.match(html, /<script src="assets\/caravel-consent\.js(?:\?v=[^"]+)?"><\/script>/);
  assert.match(html, /id="caravelConsent" hidden/);
  assert.match(html, /window\.Ride24CaravelConsent\.canSubmit\(\)/);
});
