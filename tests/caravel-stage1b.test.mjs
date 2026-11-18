// Stage 1b: protection_options, Premium confirmation by the final quote, rental bounds,
// EUR/GBP, incomplete or wrong amounts, configurable extras mapping, acceptance flow with a
// protection ladder. Synthetic data shaped like OpenAPI v1.67.0 — NOT the live API.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaravelOfferFromApi, buildRide24SellableCaravelOfferFromApi, caravelExtraFromApi, caravelExtrasCatalog, caravelProtectionCandidates, describeCaravelProtection,
  selectCaravelPremiumProtection, validateCaravelExtrasMapping, caravelQuoteFromApi,
} from "../supabase/functions/_shared/caravel-normalize.ts";
import {normalizeGroups} from "../supabase/functions/_shared/partner-api.ts";
import {verifyCaravelRide24PaymentContract} from "../supabase/functions/_shared/caravel-payment-contract.ts";
import {runCaravelAcceptance} from "../supabase/functions/_shared/caravel-acceptance.mjs";
import {evaluateCaravelPremium,CARAVEL_PREMIUM_TERMS,caravelConditionsOfHire,reconcileCaravelTerms,checkCaravelLicenceEligibility} from "../supabase/functions/_shared/caravel-premium.ts";
import {evaluateCaravelPremiumForRide24} from "../supabase/functions/_shared/caravel-exclusion-policy.ts";

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
const supplier = (c = "EUR") => ({supplier_id: "sup-1", currency: c, tax_inclusive: true, payment_models: ["pay_on_arrival"]});
const policies = {mileage: {type: "unlimited"}, min_rental_days: 1, max_rental_days: 30};
const offer = (patch = {}, c = "EUR") => ({availabilityRow: row(c), protectionId: "prot-zero", policies, quoteData: quote(c), supplier: supplier(c),
  pickupLocation: desk, dropoffLocation: desk,
  context: {scopeSupplierId: "sup-1", partnerCurrency: c, pickupLocationId: "loc", dropoffLocationId: "loc", pickupEpochMs: pickup, dropoffEpochMs: pickup + 3 * 86400000,
    rentalDays: 3, driverAge: 30, nowEpochMs: NOW}, ...patch});

test("Caravel API supports partial payments, but Ride24 only publishes zero-prepayment quotes", () => {
  // The raw Caravel API reader must still parse non-Ride24 sandbox examples.
  const partial=offer();
  assert.equal(buildCaravelOfferFromApi(partial).ok,true);
  const generic=buildCaravelOfferFromApi(partial).value;
  assert.equal(generic.features.payment_model,null);
  assert.equal(generic.features.supplier_collects_grand_total,false);
  assert.equal(generic.provider_quote_data.payment_model,null);
  const blocked=buildRide24SellableCaravelOfferFromApi(partial);
  assert.equal(blocked.ok,false);
  assert.ok(blocked.errors.includes("CARAVEL_PREPAYMENT_NOT_ALLOWED"));
  assert.ok(blocked.errors.includes("CARAVEL_PICKUP_AMOUNT_MISMATCH"));

  const full=offer({quoteData:quote("EUR",{totals:{
    grand_total:mny(17700),pay_now:mny(0),pay_at_pickup:mny(17700),
  }})});
  const sellable=buildRide24SellableCaravelOfferFromApi(full);
  assert.equal(sellable.ok,true,JSON.stringify(sellable.errors));
  assert.equal(sellable.value.features.fullInsurance,false);
  assert.equal(sellable.value.features.premiumProtectionIncluded,true);
  assert.equal(sellable.value.features.premiumProtectionWithExclusions,true);
  assert.equal(sellable.value.features.payment_model,"pay_on_arrival");
  assert.equal(sellable.value.features.supplier_collects_grand_total,true);
  assert.deepEqual(
    [sellable.value.provider_quote_data.amounts_minor.pay_now,
     sellable.value.provider_quote_data.amounts_minor.pay_at_pickup],
    [0,17700],
  );
  const gbp=offer({quoteData:quote("GBP",{totals:{
    grand_total:mny(17700,"GBP"),pay_now:mny(0,"GBP"),
    pay_at_pickup:mny(17700,"GBP"),
  }})},"GBP");
  assert.equal(buildRide24SellableCaravelOfferFromApi(gbp).ok,true);
});
test("no false pay-on-arrival label can override provider's quoted money split", () => {
  const compliant={provider:"caravel",payment_model:"pay_on_arrival",currency:"EUR",
    amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},amounts:{total:150}};
  assert.deepEqual(verifyCaravelRide24PaymentContract(compliant),
    {ok:true,currency:"EUR",totalMinor:15000});
  const cases=[
    [{amounts_minor:{total:15000,pay_now:12000,pay_at_pickup:3000}},"CARAVEL_PREPAYMENT_NOT_ALLOWED"],
    [{amounts_minor:{total:15000,pay_now:0,pay_at_pickup:14900}},"CARAVEL_PICKUP_AMOUNT_MISMATCH"],
    [{amounts_minor:{total:15000,pay_now:null,pay_at_pickup:15000}},"CARAVEL_PAYMENT_SPLIT_UNVERIFIED"],
    [{payment_model:"prepaid"},"PAY_ON_ARRIVAL_NOT_VERIFIED"],
    [{amounts:{total:149}},"CARAVEL_PAYMENT_MAJOR_MINOR_MISMATCH"],
  ];
  for(const [patch,error] of cases) {
    const verdict=verifyCaravelRide24PaymentContract({...compliant,...patch});
    assert.equal(verdict.ok,false);
    assert.ok(verdict.errors.includes(error),error);
  }
});

test("Caravel corrected production Premium is not publishable under Ride24 full-insurance policy", () => {
  // Partner confirmation 17 Nov: zero deposit/excess but glass, wheels and undercarriage excluded.
  const p = zeroRisk("EUR", {
    covers: ["bodywork", "theft", "fire", "third_party_liability", "roadside_assistance", "towing_and_recovery"],
    excludes: ["tyres_and_wheels", "glass", "mirrors", "undercarriage", "interior", "roof", "keys", "wrong_fuel", "administration_fee"]
  });
  const verdict = evaluateCaravelPremium("premium", p, {amount:mny(0)});
  assert.equal(verdict.ok, false);
  for (const code of ["COVER_MISSING_GLASS", "COVER_MISSING_TYRES_AND_WHEELS", "COVER_MISSING_UNDERCARRIAGE"]) {
    assert.ok(verdict.errors.includes(code), code);
  }
  assert.equal(selectCaravelPremiumProtection(row("EUR", [p])), null);
});

test("approved Premium exclusions can be sold only with an exact authoritative review",()=>{
 const corrected=zeroRisk("EUR",{
   covers:["bodywork","theft","fire","third_party_liability","roadside_assistance","towing_and_recovery"],
   excludes:["glass","tyres_and_wheels","undercarriage","mirrors","interior","roof","keys","administration_fee"],
 });
 const review={
   termsDocumentId:"caravel-en-v4",termsContentHash:"a".repeat(64),
   documentedExcludedCodes:[...corrected.excludes],
   damageAdministrationFeeMinor:10000,currency:"EUR",
   approvedByRide24:true,canonicalHashVerified:true,
 };
 const basic=evaluateCaravelPremium("premium",corrected,{amount:mny(0)});
 assert.equal(basic.ok,false);
 const approved=evaluateCaravelPremiumForRide24("premium",corrected,{amount:mny(0)},review);
 assert.equal(approved.ok,true,JSON.stringify(approved.errors));
 assert.equal(approved.fullInsuranceClaimAllowed,false);
 assert.equal(approved.disclosureRequired,true);
 assert.equal(approved.damageAdministrationFeeMinor,10000);
 const missingQuoteDeposit=evaluateCaravelPremiumForRide24("premium",corrected,undefined,review);
 assert.ok(missingQuoteDeposit.errors.includes("CARAVEL_QUOTE_DEPOSIT_UNVERIFIED"));
 assert.equal(selectCaravelPremiumProtection(row("EUR",[corrected])),null);
 assert.equal(selectCaravelPremiumProtection(row("EUR",[corrected]),review)?.source,"option");
 const quoted=quote("EUR",{totals:{
   grand_total:mny(17700),pay_now:mny(0),pay_at_pickup:mny(17700),
 }});
 const sellable=buildRide24SellableCaravelOfferFromApi(offer({
   availabilityRow:row("EUR",[corrected]),
   exclusionReview:review,
   quoteData:quoted,
 }));
 assert.equal(sellable.ok,true,JSON.stringify(sellable.errors));
 assert.equal(sellable.value.features.fullInsurance,false);
 assert.equal(sellable.value.features.premiumProtectionIncluded,true);
 assert.equal(sellable.value.features.premiumProtectionWithExclusions,true);
 assert.equal(sellable.value.features.damageAdministrationFeeMinor,10000);
 assert.equal(sellable.value.features.protectionTermsDocumentId,"caravel-en-v4");
 assert.deepEqual(sellable.value.features.caravelExclusions,corrected.excludes);
 const [ride24Group]=normalizeGroups({groups:[sellable.value]});
 assert.equal(ride24Group.features.fullInsurance,false);
 assert.equal(ride24Group.features.premiumProtectionIncluded,true);
 assert.equal(ride24Group.features.premiumProtectionWithExclusions,true);
 assert.equal(ride24Group.features.damageAdministrationFeeMinor,10000);
 assert.deepEqual(ride24Group.features.caravelExclusions,corrected.excludes);
 assert.equal(sellable.value.provider_quote_data.coverage_review_terms_document_id,"caravel-en-v4");
 assert.equal(sellable.value.provider_quote_data.damage_administration_fee_minor,10000);
 const changed=evaluateCaravelPremiumForRide24("premium",{
   ...corrected,excludes:[...corrected.excludes,"battery"],
 },{amount:mny(0)},review);
 assert.equal(changed.ok,false);
 assert.ok(changed.errors.includes("CARAVEL_EXCLUSIONS_CHANGED_OR_NOT_DISCLOSED"));
 const unverified=evaluateCaravelPremiumForRide24("premium",corrected,{amount:mny(0)},{
   ...review,canonicalHashVerified:false,
 });
 assert.ok(unverified.errors.includes("CARAVEL_TERMS_REVIEW_UNVERIFIED"));
 const badFee=evaluateCaravelPremiumForRide24("premium",corrected,{amount:mny(0)},{
   ...review,damageAdministrationFeeMinor:-1,
 });
 assert.ok(badFee.errors.includes("CARAVEL_DAMAGE_ADMIN_FEE_UNVERIFIED"));
 const notActuallyExcluded=evaluateCaravelPremiumForRide24("premium",{
   ...corrected,excludes:corrected.excludes.filter(x=>x!=="glass"),
 },{amount:mny(0)},{...review,documentedExcludedCodes:corrected.excludes.filter(x=>x!=="glass")});
 assert.ok(notActuallyExcluded.errors.includes("COVER_MISSING_GLASS"));
 const noBodywork=evaluateCaravelPremiumForRide24("premium",{
   ...corrected,covers:["theft","fire"],
 },{amount:mny(0)},review);
 assert.ok(noBodywork.errors.includes("CARAVEL_BODYWORK_COVER_NOT_CONFIRMED"));
});

test("corrected Caravel public text warns of uncovered damage and EUR 100 fee", () => {
  const t = CARAVEL_PREMIUM_TERMS;
  assert.equal(t.included.some(i => i.code === "glass_tyres_undercarriage"), false);
  assert.ok(t.exclusions.some(i => i.code === "glass_tyres_undercarriage" && i.en.includes("NOT covered")));
  assert.ok(t.other.some(i => i.code === "damage_administration_fee" && i.amountMinor === 10000));
  assert.ok(t.included.some(i => i.code === "premium_waiver" && i.en.includes("exclusions apply")));
  assert.equal(t.included.some(i => i.code === "cdw_scdw"), false);
  const downtime=t.other.find(i => i.code === "repair_downtime");
  assert.ok(downtime && downtime.en.includes("No downtime charge") && downtime.en.includes("excluded or uninsured"));
  assert.ok(t.exclusions.find(i => i.code === "keys")?.en.includes("delivery cost"));
  assert.ok(t.other.some(i => i.code === "idp_non_eu_eea" && i.en.includes("EU/EEA")));
});

test("supplier-specific licence policies are read separately and contradictions surfaced", () => {
  const first=caravelConditionsOfHire({
    licence_rules:{min_years_held:1,international_permit_required_for:["non_eu_eea"]},
    restrictions:["paved_roads_only"],deposit_card_rules:{required:false}
  });
  const second=caravelConditionsOfHire({
    licence_rules:{min_years_held:2,international_permit_required_for:["non_eu_eea"]},
    restrictions:["paved_roads_only"],deposit_card_rules:{required:false}
  });
  assert.equal(first.minLicenceYears,1);
  assert.equal(second.minLicenceYears,2);
  assert.equal(reconcileCaravelTerms(first).conflicts.length,0);
  assert.ok(reconcileCaravelTerms(second).conflicts.includes("LICENCE_YEARS_2_VS_RIDE24_1"));
});

test("Caravel licence validator respects each supplier's policy, first issue and IDP", () => {
  const policy=(years,permit=["non_eu_eea"])=>({licence_rules:{
    min_years_held:years,international_permit_required_for:permit
  }});
  const evidence={firstIssuedOn:"2025-12-01",pickupOn:"2027-01-05",
    issuedInEuEea:true,hasInternationalDrivingPermit:false};
  assert.deepEqual(checkCaravelLicenceEligibility(policy(1),evidence),{ok:true,minLicenceYears:1});
  assert.ok(checkCaravelLicenceEligibility(policy(2),evidence).errors.includes("LICENCE_NOT_HELD_LONG_ENOUGH"));
  assert.ok(checkCaravelLicenceEligibility(policy(1),{...evidence,issuedInEuEea:false}).errors.includes("IDP_REQUIRED_FOR_NON_EU_EEA_LICENCE"));
  assert.equal(checkCaravelLicenceEligibility(policy(1),{...evidence,issuedInEuEea:false,hasInternationalDrivingPermit:true}).ok,true);
  assert.ok(checkCaravelLicenceEligibility(policy(1),{...evidence,firstIssuedOn:"2026-02-29"}).errors.includes("LICENCE_DATES_INVALID"));
  assert.ok(checkCaravelLicenceEligibility(policy(1),{...evidence,firstIssuedOn:"2026-02-01",pickupOn:"2027-01-31"}).errors.includes("LICENCE_NOT_HELD_LONG_ENOUGH"));
  assert.ok(checkCaravelLicenceEligibility(policy(1,["unknown_future_scope"]),evidence).errors.includes("IDP_POLICY_CODE_UNRECOGNIZED"));
  assert.ok(checkCaravelLicenceEligibility({licence_rules:{}},evidence).errors.includes("LICENCE_MIN_YEARS_UNVERIFIED"));
  assert.ok(checkCaravelLicenceEligibility(policy(1),{...evidence,issuedInEuEea:null}).errors.includes("LICENCE_ISSUING_REGION_REQUIRED"));
});

test("Premium selection does not infer a named group from opaque vehicle ID", () => {
  const x={...row(),vehicle_id:"opaque-L2A"};
  assert.equal(selectCaravelPremiumProtection(x)?.protection.protection_id,"prot-zero");
});

test("current sandbox extras: child_seat and additional_driver map, other stays unmapped", () => {
  const base={supplier_id:"sup-1",extra_id:"test-ex",code:"TEST",name:"Extra",
    pricing_type:"per_day",unit_price:mny(500),price_cap:null,
    quantity:{min:0,max:1,default:0},requires_quantity:false,payable:"at_pickup"};
  const seat=caravelExtraFromApi({...base,category:"child_seat"});
  const driver=caravelExtraFromApi({...base,category:"additional_driver",extra_id:"driver"});
  const other=caravelExtraFromApi({...base,category:"other",extra_id:"other",name:"Child seat"});
  assert.deepEqual([seat.ride24Code,seat.mappingSource],["child_seat","category"]);
  assert.deepEqual([driver.ride24Code,driver.mappingSource],["additional_driver","category"]);
  assert.deepEqual([other.ride24Code,other.mappingSource],[null,"unmapped"]);
});

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

test("supplier must explicitly support Ride24's pay-on-arrival model", () => {
  for (const models of [undefined,[],["prepaid"],["partial"]]){
    const s=supplier();
    if(models===undefined) delete s.payment_models;
    else s.payment_models=models;
    const result=buildCaravelOfferFromApi(offer({supplier:s}));
    assert.equal(result.ok,false);
    assert.ok(result.errors.includes("PAY_ON_ARRIVAL_NOT_CONFIRMED"));
  }
  assert.equal(buildCaravelOfferFromApi(offer()).ok,true);
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
    if (c) { const b = bookings.get(c[1]); if (b.status === "cancelled") return ok(b); // real Caravel: repeated cancel is 200 even with prior revision
      if (body.expected_revision !== b.revision) return err("revision_conflict", 409);
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

test("Caravel extras mapping accepts supplier opaque codes containing s and keeps other unmapped",()=>{
 const valid={"sup-1:code:seat_standard":"child_seat",
   "sup-2:supplier_code:second_driver":"additional_driver"};
 assert.deepEqual(validateCaravelExtrasMapping(valid),{ok:true});
 const ex={supplier_id:"sup-1",extra_id:"extraseat1",code:"seat_standard",
  category:"other",name:"Unmapped generic label",
  pricing_type:"per_day",unit_price:mny(300),price_cap:null,
  quantity:{min:0,max:1,default:0},requires_quantity:false,
  payable:"at_pickup"};
 const mapped=caravelExtraFromApi(ex,valid);
 assert.equal(mapped.ride24Code,"child_seat");
 assert.equal(mapped.mappingSource,"confirmed");
 assert.equal(caravelExtraFromApi({...ex,code:"unknown_s"},valid).ride24Code,null);
 assert.equal(caravelExtraFromApi({...ex,category:"child_seat",code:"unknown_s"},valid).ride24Code,"child_seat");
 assert.equal(caravelExtraFromApi({...ex,category:"additional_driver",code:"unknown_s"},valid).ride24Code,"additional_driver");
 assert.ok(validateCaravelExtrasMapping({"sup-1:code:bad:colon":"child_seat"}).errors.length);
});
