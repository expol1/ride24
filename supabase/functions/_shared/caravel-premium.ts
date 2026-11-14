/**
 * Ride24 publishes Caravel offers on the Premium plan ONLY (business decision,
 * 13 Nov 2026). An offer is publishable only when the supplier's own data
 * (OpenAPI v1.67.0 Protection, QuoteResponseData.deposit, Policy) confirms every
 * Ride24 Premium guarantee. Anything absent or unstated fails closed.
 *
 * Mapping of the Ride24 guarantees to documented fields:
 *  - plan premium                      -> availability row `plan` / quote `plan` === "premium"
 *  - deposit 0                         -> protection.deposit.amount === 0 AND quote deposit.amount === 0
 *  - excess 0 for covered damage       -> protection.excess.amount === 0
 *  - CDW/SCDW                          -> protection.product_type === "waiver" (damage waiver) with excess 0
 *  - theft and fire with zero excess   -> covers includes "theft" and "fire"; theft_excess stated and 0
 *  - glass, tyres, undercarriage       -> covers includes "glass", "tyres_and_wheels", "undercarriage"
 *  - no credit card required           -> zero deposit: the deposit is the only card requirement the API
 *                                         states (deposit.type "pre_authorization" = a hold on a card)
 */
type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : null);
const zeroMoney = (v: unknown): boolean => {
  const m = rec(v);
  return !!m && m.amount === 0 && typeof m.currency === "string" && /^[A-Z]{3}$/.test(m.currency);
};

export const REQUIRED_PREMIUM_COVERS = Object.freeze(["theft", "fire", "glass", "tyres_and_wheels", "undercarriage"]);

export type CaravelPremiumEvaluation =
  | {ok: true; covers: string[]; excludes: string[] | null; productType: "waiver"; noCreditCard: true; noCardHold: true}
  | {ok: false; errors: string[]};

/**
 * @param plan        availability row `plan` (or quote `plan`)
 * @param protection  the row's `protection` object (Protection schema)
 * @param quoteDeposit QuoteResponseData.deposit (optional before quoting; required for publishing)
 */
export function evaluateCaravelPremium(plan: unknown, protection: unknown, quoteDeposit?: unknown): CaravelPremiumEvaluation {
  const errors: string[] = [];
  const p = rec(protection);
  if (plan !== "premium") errors.push("PREMIUM_PLAN_REQUIRED");
  if (!p) return {ok: false, errors: [...errors, "PROTECTION_UNVERIFIED"]};
  if (p.tier !== undefined && p.tier !== "premium") errors.push("PREMIUM_TIER_REQUIRED");
  if (!zeroMoney(p.deposit)) errors.push("ZERO_DEPOSIT_REQUIRED");
  if (!zeroMoney(p.excess)) errors.push("ZERO_EXCESS_REQUIRED");
  // theft_excess absent means "unstated", never equal to excess (spec): fail closed.
  if (!zeroMoney(p.theft_excess)) errors.push("ZERO_THEFT_EXCESS_UNCONFIRMED");
  if (p.product_type !== "waiver") errors.push("DAMAGE_WAIVER_UNCONFIRMED");
  const covers = Array.isArray(p.covers) ? p.covers.filter((c): c is string => typeof c === "string") : null;
  if (!covers) errors.push("COVERS_UNSTATED");
  else for (const code of REQUIRED_PREMIUM_COVERS) if (!covers.includes(code)) errors.push(`COVER_MISSING_${code.toUpperCase()}`);
  const excludes = Array.isArray(p.excludes) ? p.excludes.filter((c): c is string => typeof c === "string") : null;
  if (excludes && covers && excludes.some((c) => covers.includes(c))) errors.push("COVERS_CONTRADICT_EXCLUDES");
  if (quoteDeposit !== undefined) {
    const d = rec(quoteDeposit);
    if (!d || !zeroMoney(d.amount)) errors.push("QUOTE_DEPOSIT_NOT_ZERO");
  }
  if (errors.length) return {ok: false, errors: [...new Set(errors)]};
  return {ok: true, covers: covers!, excludes, productType: "waiver", noCreditCard: true, noCardHold: true};
}

// ------------------------------------------------- conditions of hire ----
export type CaravelConditionsOfHire = {
  minLicenceYears: number | null;
  internationalPermitRequiredFor: string[] | null;
  restrictions: string[] | null;
  depositCardRules: Json | null;
  depositPaymentMethods: string[] | null;
  mileage: Json | null;
  fuel: Json | null;
  cancellation: Json | null;
  minRentalDays: number | null;
  maxRentalDays: number | null;
};

/** Read the documented Policy terms for display (absent = not stated, never "none"). */
export function caravelConditionsOfHire(policy: unknown): CaravelConditionsOfHire {
  const p = rec(policy) ?? {};
  const licence = rec(p.licence_rules);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  return {
    minLicenceYears: licence ? int(licence.min_years_held) : null,
    internationalPermitRequiredFor: licence ? strings(licence.international_permit_required_for) : null,
    restrictions: strings(p.restrictions),
    depositCardRules: rec(p.deposit_card_rules),
    depositPaymentMethods: strings(p.deposit_payment_methods),
    mileage: rec(p.mileage),
    fuel: rec(p.fuel),
    cancellation: rec(p.cancellation),
    minRentalDays: int(p.min_rental_days),
    maxRentalDays: int(p.max_rental_days),
  };
}

// ------------------------------------------- Ride24 Premium display copy ----
/**
 * Ride24's customer-facing Premium terms for Caravel (supplied by Ride24,
 * 13 Nov 2026), prepared for later display. Not wired into WWW/APK. The binding
 * words remain the supplier's rental terms (GET /v1/reference/terms).
 */
export const CARAVEL_PREMIUM_TERMS = Object.freeze({
  scope: {
    pl: "Ochrona Premium obowiązuje podczas jazdy po drogach utwardzonych.",
    en: "Premium protection applies while driving on paved roads.",
  },
  included: [
    {code: "deposit_zero", pl: "Depozyt 0", en: "Zero deposit"},
    {code: "excess_zero", pl: "Udział własny 0 dla szkód objętych ochroną", en: "Zero excess for covered damage"},
    {code: "cdw_scdw", pl: "Ochrona CDW/SCDW", en: "CDW/SCDW protection"},
    {code: "theft_fire_zero", pl: "Zerowy udział własny przy kradzieży i pożarze", en: "Zero excess for theft and fire"},
    {code: "glass_tyres_undercarriage", pl: "Ochrona szyb, opon i podwozia", en: "Glass, tyre and undercarriage cover"},
    {code: "no_credit_card", pl: "Brak wymogu karty kredytowej", en: "No credit card required"},
  ],
  exclusions: [
    {code: "off_road", pl: "Jazda poza drogami asfaltowymi", en: "Driving off paved roads"},
    {code: "exterior_mirrors", pl: "Lusterka zewnętrzne", en: "Exterior mirrors"},
    {code: "interior_roof_engine_locks", pl: "Wnętrze, dach, silnik i zamki", en: "Interior, roof, engine and locks"},
    {code: "keys", pl: "Zgubione lub uszkodzone klucze — 200 EUR", en: "Lost or damaged keys — EUR 200", amountMinor: 20000, currency: "EUR"},
    {code: "accessories", pl: "Akcesoria, np. foteliki i GPS", en: "Accessories such as child seats and GPS"},
  ],
  voids: [
    {code: "alcohol_drugs", pl: "Alkohol lub narkotyki", en: "Alcohol or drugs"},
    {code: "racing", pl: "Wyścigi", en: "Racing"},
    {code: "commercial_use", pl: "Użytek komercyjny", en: "Commercial use"},
    {code: "overloading", pl: "Przeciążenie pojazdu", en: "Overloading"},
    {code: "serious_offences", pl: "Poważne wykroczenia drogowe", en: "Serious traffic offences"},
    {code: "unauthorised_ferry_border", pl: "Nieautoryzowany prom lub przekroczenie granicy", en: "Unauthorised ferry or border crossing"},
  ],
  other: [
    {code: "repair_downtime", pl: "Przestój naprawczy może być naliczany do 20 dni", en: "Repair downtime may be charged for up to 20 days", maxDays: 20},
    {code: "police_report", pl: "Wypadek lub kradzież wymaga raportu policyjnego", en: "An accident or theft requires a police report"},
    {code: "licence_one_year", pl: "Prawo jazdy posiadane co najmniej rok", en: "Driving licence held for at least one year", minYears: 1},
    {code: "id_document", pl: "Wymagany dokument tożsamości", en: "An identity document is required"},
    {code: "idp_non_eu", pl: "Kierowcy z prawem jazdy spoza UE potrzebują międzynarodowego prawa jazdy", en: "Drivers with a non-EU licence need an international driving permit"},
  ],
});

/**
 * Cross-check Ride24's terms against what the supplier states. Returns the
 * statements to show next to the Ride24 copy and any contradiction to resolve
 * with Caravel before publishing (e.g. a licence minimum above one year).
 */
export function reconcileCaravelTerms(conditions: CaravelConditionsOfHire): {conflicts: string[]; unstated: string[]} {
  const conflicts: string[] = [];
  const unstated: string[] = [];
  if (conditions.minLicenceYears === null) unstated.push("licence_rules.min_years_held");
  else if (conditions.minLicenceYears !== 1) conflicts.push(`LICENCE_YEARS_${conditions.minLicenceYears}_VS_RIDE24_1`);
  if (conditions.internationalPermitRequiredFor === null) unstated.push("licence_rules.international_permit_required_for");
  if (conditions.restrictions === null) unstated.push("restrictions");
  if (conditions.depositCardRules === null) unstated.push("deposit_card_rules");
  return {conflicts, unstated};
}
