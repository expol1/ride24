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
 *  - glass, tyres, undercarriage       -> required by Ride24; explicitly excluded in production by Caravel (17 Nov 2026): keep fail-closed
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

// -------------------------- licence eligibility (isolated, not yet wired) ----
/**
 * Caravel checks first issue of the driving licence, not the driver's age or
 * profile.country. Per-supplier licence_rules must be used: the Ride24 drivers
 * table does not currently store first-issue dates or issuing countries.
 * This helper is deliberately NOT wired into the shared booking UI/dispatch.
 */
export type CaravelLicenceEvidence = {
  /** Original first issue date (local YYYY-MM-DD), not current card renewal. */
  firstIssuedOn: string;
  /** Local pickup date YYYY-MM-DD. */
  pickupOn: string;
  /** Derived from the LICENCE ISSUING COUNTRY, not nationality or home address. */
  issuedInEuEea: boolean;
  /** Original International Driving Permit will be shown at the desk. */
  hasInternationalDrivingPermit: boolean;
};
const ymd = (value: unknown): {year: number; month: number; day: number; epoch: number} | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year,month,day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day)
    return null;
  return {year,month,day,epoch:date.getTime()};
};

/** Strict pre-booking eligibility; unknown policy or missing evidence = no booking. */
export function checkCaravelLicenceEligibility(
  policy: unknown, evidence: unknown,
): {ok: true; minLicenceYears: number} | {ok: false; errors: string[]} {
  const e = rec(evidence) ?? {};
  const rules = caravelConditionsOfHire(policy);
  const errors: string[] = [];
  const min = rules.minLicenceYears;
  const first = ymd(e.firstIssuedOn), pickup = ymd(e.pickupOn);
  if (min === null || min < 1 || min > 100) errors.push("LICENCE_MIN_YEARS_UNVERIFIED");
  if (!first || !pickup || first.epoch > pickup.epoch) errors.push("LICENCE_DATES_INVALID");
  else if (min !== null && min >= 1 && min <= 100) {
    const anniversary = Date.UTC(first.year + min,first.month-1,first.day);
    if (pickup.epoch < anniversary) errors.push("LICENCE_NOT_HELD_LONG_ENOUGH");
  }
  if (typeof e.issuedInEuEea !== "boolean") errors.push("LICENCE_ISSUING_REGION_REQUIRED");
  if (!Array.isArray(rules.internationalPermitRequiredFor)) {
    errors.push("IDP_POLICY_UNVERIFIED");
  } else {
    // The confirmed 17-Nov contract uses non_eu_eea; never silently interpret
    // unknown future provider rule codes as "no IDP required".
    const known = new Set(["non_eu_eea"]);
    if (rules.internationalPermitRequiredFor.some(code => !known.has(code)))
      errors.push("IDP_POLICY_CODE_UNRECOGNIZED");
    if (e.issuedInEuEea === false) {
      if (!rules.internationalPermitRequiredFor.includes("non_eu_eea"))
        errors.push("NON_EU_EEA_IDP_RULE_UNCONFIRMED");
      else if (e.hasInternationalDrivingPermit !== true)
        errors.push("IDP_REQUIRED_FOR_NON_EU_EEA_LICENCE");
    }
  }
  if (errors.length) return {ok: false, errors: [...new Set(errors)]};
  return {ok: true, minLicenceYears: min!};
}

// ------------------------------------------- Ride24 Premium display copy ----
/**
 * Ride24's customer-facing Premium terms for Caravel (partner correction
 * 17 Nov 2026), prepared for later display. Not wired into WWW/APK.
 * These summaries never supersede GET /v1/reference/terms: Caravel rental
 * terms take precedence and must be shown before Stripe payment. Current
 * Caravel exclusions still fail Ride24's full-coverage publish gate.
 */
export const CARAVEL_PREMIUM_TERMS = Object.freeze({
  scope: {
    pl: "Ochrona Premium obowiązuje podczas jazdy po drogach utwardzonych.",
    en: "Premium protection applies while driving on paved roads.",
  },
  included: [
    {code: "deposit_zero", pl: "Depozyt 0", en: "Zero deposit"},
    {code: "excess_zero", pl: "Udział własny 0 dla szkód objętych ochroną", en: "Zero excess for covered damage"},
    {code: "premium_waiver", pl: "Ochrona szkód objętych Premium (z wyłączeniami)", en: "Premium damage waiver for covered incidents (exclusions apply)"},
    {code: "theft_fire_zero", pl: "Zerowy udział własny przy kradzieży i pożarze", en: "Zero excess for theft and fire"},
    {code: "no_credit_card", pl: "Brak wymogu karty kredytowej", en: "No credit card required"},
  ],
  exclusions: [
    {code: "glass_tyres_undercarriage", pl: "Szyby, koła, opony i podwozie NIE są objęte ochroną Premium", en: "Glass, wheels, tyres and undercarriage are NOT covered by Premium"},
    {code: "off_road", pl: "Jazda poza drogami utwardzonymi", en: "Driving off paved roads"},
    {code: "exterior_mirrors", pl: "Lusterka zewnętrzne", en: "Exterior mirrors"},
    {code: "interior_roof_engine_locks", pl: "Wnętrze, dach, silnik i zamki", en: "Interior, roof, engine and locks"},
    {code: "keys", pl: "Zgubione lub uszkodzone klucze: 200 EUR plus koszt dostarczenia", en: "Lost or damaged keys: EUR 200 plus replacement delivery cost", amountMinor: 20000, currency: "EUR"},
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
    {code: "damage_administration_fee", pl: "Opłata administracyjna 100 EUR za wynajem, w którym wystąpi szkoda lub kradzież, także w Premium", en: "EUR 100 administration fee per rental with damage or theft, including Premium", amountMinor: 10000, currency: "EUR"},
    {code: "traffic_fines_handling", pl: "Mandaty drogowe i parkingowe obciążają najemcę, dodatkowo naliczana jest opłata manipulacyjna (sprawdź regulamin)", en: "Traffic and parking fines remain the renter's responsibility, plus a handling fee (see rental terms)"},
    {code: "repair_downtime", pl: "Brak opłaty za przestój przy szkodach objętych Premium; przy wyłączeniu lub utracie ochrony do 20 dni stawki Premium", en: "No downtime charge for Premium-covered incidents; excluded or uninsured incidents may incur up to 20 days at the Premium daily rate", maxDays: 20},
    {code: "police_report", pl: "Wypadek lub kradzież wymaga raportu policyjnego", en: "An accident or theft requires a police report"},
    {code: "licence_one_year", pl: "Prawo jazdy posiadane co najmniej rok", en: "Driving licence held for at least one year", minYears: 1},
    {code: "id_document", pl: "Wymagany dokument tożsamości", en: "An identity document is required"},
    {code: "idp_non_eu_eea", pl: "Prawo jazdy wydane poza UE/EOG wymaga międzynarodowego prawa jazdy", en: "Licences issued outside the EU/EEA require an International Driving Permit"},
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
