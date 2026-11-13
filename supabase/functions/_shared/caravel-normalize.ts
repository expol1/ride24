/**
 * Caravel Channel API v1.67.0 -> Ride24 standard normalization
 * (isolated, NOT wired into dispatch).
 *
 * Two layers:
 *  1. `*FromApi` readers take response objects exactly as documented in the
 *     official OpenAPI v1.67.0 (`GET /v1/openapi.json` on the sandbox host):
 *     Location, Vehicle, AvailabilityItem, meta.policies, Extra and
 *     QuoteResponseData. Optional fields that the spec says mean "not stated"
 *     are never defaulted.
 *  2. Verified* -> Ride24: the Ride24 standard partner payload
 *     ("ride24_standard_v1") accepted unchanged by the shared
 *     normalizeLocations()/normalizeGroups(), plus partner_locations /
 *     car_classes rows in the shape the existing API sync writes. Cards, prices,
 *     Ride24 fee and partner payable then come from the same shared code as for
 *     every other partner.
 *
 * Fail closed: anything unverified rejects the item with an error code.
 */
import {
  verifyCaravelMandatoryCharges,
  verifyCaravelQuote,
  type CaravelMandatoryCharge,
  type VerifiedCaravelQuote,
} from "./caravel-quote-verification.ts";
import {
  validateCaravelSelection,
  type VerifiedCaravelExtra,
  type VerifiedCaravelRules,
} from "./caravel-verified-rules.ts";

export const CARAVEL_PROVIDER = "caravel";
type Json = Record<string, unknown>;
export type Result<T> = {ok: true; value: T} | {ok: false; errors: string[]};
const fail = <T>(errors: string[]): Result<T> => ({ok: false, errors: [...new Set(errors)]});
const okv = <T>(value: T): Result<T> => ({ok: true, value});
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const rec = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- money ----
/** ISO 4217 minor-unit exponents (spec §1.6: Money is integer minor units). Unlisted currencies fail closed. */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  EUR: 2, PLN: 2, USD: 2, GBP: 2, CHF: 2, CZK: 2, HUF: 2, RON: 2, BGN: 2,
  DKK: 2, NOK: 2, SEK: 2, TRY: 2, AED: 2, MAD: 2, GEL: 2, ALL: 2, RSD: 2,
  BAM: 2, MKD: 2, UAH: 2, ILS: 2, EGP: 2, CAD: 2, AUD: 2, NZD: 2, ZAR: 2,
  THB: 2, MXN: 2, BRL: 2, ISK: 0, JPY: 0, KRW: 0, TND: 3, JOD: 3, KWD: 3,
  BHD: 3, OMR: 3,
});

export function currencyExponent(currency: unknown): number | null {
  return typeof currency === "string" && Object.hasOwn(CURRENCY_EXPONENT, currency)
    ? CURRENCY_EXPONENT[currency]
    : null;
}

/** Integer minor units -> Ride24 major-unit number. */
export function minorToMajor(amountMinor: unknown, currency: unknown): number | null {
  const exp = currencyExponent(currency);
  if (exp === null || !safeInt(amountMinor) || amountMinor < 0) return null;
  return Number((amountMinor / 10 ** exp).toFixed(exp));
}

function amountString(amountMinor: number, currency: string): string | null {
  const exp = currencyExponent(currency);
  const major = minorToMajor(amountMinor, currency);
  if (exp === null || major === null || exp > 2) return null;
  return major.toFixed(2);
}

/** OpenAPI Money {amount: integer minor units, currency: ISO 4217}. */
function money(v: unknown, allowNegative = false): {amount: number; currency: string} | null {
  const m = rec(v);
  if (!m || !safeInt(m.amount) || (!allowNegative && (m.amount as number) < 0) ||
      typeof m.currency !== "string" || !/^[A-Z]{3}$/.test(m.currency)) return null;
  return {amount: m.amount as number, currency: m.currency};
}

// ------------------------------------------------------------ locations ----
/** OpenAPI Location.type values. */
export type CaravelLocationType = "airport" | "port" | "office" | "city" | "hotel" | "address";
export type VerifiedCaravelLocation = {
  locationId: string;
  supplierId: string;
  name: string;
  /** Location.address.country (ISO 3166-1 alpha-2, optional in the spec). */
  countryCode: string | null;
  region: string | null;
  city: string | null;
  type: CaravelLocationType;
  timezone: string;
};

/** Read one `GET /v1/reference/locations` record. */
export function caravelLocationFromApi(raw: unknown): VerifiedCaravelLocation {
  const r = rec(raw) ?? {};
  const address = rec(r.address) ?? {};
  return {
    locationId: r.location_id as string,
    supplierId: r.supplier_id as string,
    name: r.name as string,
    countryCode: typeof address.country === "string" ? address.country : null,
    region: typeof address.region === "string" ? address.region : null,
    city: typeof address.city === "string" ? address.city : null,
    type: r.type as CaravelLocationType,
    timezone: r.timezone as string,
  };
}

/** Ride24 standard location item, accepted by shared normalizeLocations(). */
export type Ride24StandardLocation = {
  external_id: string;
  country: string;
  region: string;
  city: string | null;
  location_name: string;
  type: string;
  extra_fee: false;
  extra_fee_amount: null;
  return_fee_amount: null;
  contact_required: false;
  active: true;
};

function countryName(code: unknown): string | null {
  if (typeof code !== "string" || !/^[A-Z]{2}$/.test(code)) return null;
  try {
    const name = new Intl.DisplayNames(["en"], {type: "region"}).of(code);
    return name && name !== code && name !== "Unknown Region" ? name : null;
  } catch {
    return null;
  }
}

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", {timeZone: tz});
    return true;
  } catch {
    return false;
  }
}

/**
 * Caravel type -> Ride24 partner_locations.type (airport, city, port, station, hotel).
 * `office` (a downtown/standalone branch) is shown as a city location; `address`
 * is an operator-defined delivery area, not a desk, so it is not listed.
 */
const LOCATION_TYPE_MAP: Readonly<Record<string, string | null>> = Object.freeze({
  airport: "airport", port: "port", office: "city", city: "city", hotel: "hotel", address: null,
});

/**
 * Location fees are deliberately null: Caravel prices pickup/return charges in
 * its authoritative quote, and Ride24 refuses API partners that also carry
 * local location fees (assertApiPricingCompatible). The spec has no `active`
 * flag: withdrawn desks are simply not served, so every served desk is active.
 */
export function normalizeCaravelLocation(
  loc: VerifiedCaravelLocation,
  scopeSupplierId: string,
): Result<Ride24StandardLocation> {
  const errors: string[] = [];
  const id = text(loc?.locationId, 200);
  const name = text(loc?.name, 250);
  const country = countryName(loc?.countryCode);
  const type = typeof loc?.type === "string" && Object.hasOwn(LOCATION_TYPE_MAP, loc.type) ? LOCATION_TYPE_MAP[loc.type] : undefined;
  if (!id) errors.push("LOCATION_ID_UNVERIFIED");
  if (!name) errors.push("LOCATION_NAME_UNVERIFIED");
  if (!country) errors.push("COUNTRY_UNVERIFIED");
  if (type === undefined) errors.push("LOCATION_TYPE_UNVERIFIED");
  else if (type === null) errors.push("LOCATION_TYPE_UNSUPPORTED");
  if (!text(scopeSupplierId, 128) || loc?.supplierId !== scopeSupplierId) errors.push("SUPPLIER_SCOPE_MISMATCH");
  if (!validTimezone(loc?.timezone)) errors.push("TIMEZONE_UNVERIFIED");
  if (errors.length) return fail(errors);
  return okv({
    external_id: id!,
    country: country!,
    region: text(loc.region, 150) || text(loc.city, 150) || country!,
    city: text(loc.city, 150),
    location_name: name!,
    type: type as string,
    extra_fee: false,
    extra_fee_amount: null,
    return_fee_amount: null,
    contact_required: false,
    active: true,
  });
}

// ------------------------------------------------------------- vehicles ----
export type CaravelFuel = "petrol" | "diesel" | "hybrid" | "plugin_hybrid" | "electric";
export type VerifiedCaravelVehicle = {
  vehicleId: string;
  supplierId: string;
  /** ACRISS code; first letter is the Ride24 class letter. Nullable on reference vehicles. */
  acrissCode: string | null;
  /** Customer-facing name, already in "model or similar" form (spec display_name). */
  displayName: string;
  transmission: "manual" | "automatic" | null;
  fuelType: CaravelFuel | null;
  seats: number | null;
  largeBags: number | null;
  smallBags: number | null;
  imageUrl: string | null;
  /** meta.policies.mileage / reference policies mileage. */
  mileage: {unlimited: true} | {unlimited: false; limitKm: number} | null;
  /** protection.deposit / quote deposit: a card pre-authorization at pickup. null = not known. */
  depositAmountMinor: number | null;
  airConditioning: boolean | null;
  minDriverAge: number;
  maxDriverAge: number;
};

/** policies.mileage {type: unlimited|limited, included_km_per_day}. */
export function caravelMileageFromPolicies(policies: unknown): VerifiedCaravelVehicle["mileage"] {
  const m = rec(rec(policies)?.mileage);
  if (m?.type === "unlimited") return {unlimited: true};
  if (m?.type === "limited" && safeInt(m.included_km_per_day) && (m.included_km_per_day as number) > 0)
    return {unlimited: false, limitKm: m.included_km_per_day as number};
  return null;
}

/**
 * Read a `GET /v1/reference/vehicles` record or an availability row (same
 * vehicle fields). `policies` comes from availability `meta.policies` or
 * `GET /v1/reference/policies`; the deposit from the row's `protection`.
 */
export function caravelVehicleFromApi(raw: unknown, policies: unknown): VerifiedCaravelVehicle {
  const r = rec(raw) ?? {};
  const images = Array.isArray(r.images) ? r.images : [];
  const firstImage = images.map((i) => rec(i)?.url).find((u) => typeof u === "string" && /^https:\/\/\S+$/i.test(u));
  const deposit = money(rec(r.protection)?.deposit);
  const opt = <T>(v: unknown, guard: (x: unknown) => boolean): T | null => (v === undefined || v === null ? null : guard(v) ? v as T : null);
  return {
    vehicleId: r.vehicle_id as string,
    supplierId: r.supplier_id as string,
    acrissCode: typeof r.acriss === "string" ? r.acriss : null,
    displayName: r.display_name as string,
    transmission: opt(r.transmission, (x) => x === "manual" || x === "automatic"),
    fuelType: opt(r.fuel, (x) => ["petrol", "diesel", "hybrid", "plugin_hybrid", "electric"].includes(x as string)),
    seats: opt(r.seats, safeInt),
    largeBags: opt(r.large_bags, safeInt),
    smallBags: opt(r.small_bags, safeInt),
    imageUrl: (firstImage as string | undefined) ?? null,
    mileage: caravelMileageFromPolicies(policies),
    depositAmountMinor: deposit ? deposit.amount : null,
    airConditioning: opt(r.air_conditioning, (x) => typeof x === "boolean"),
    minDriverAge: r.min_driver_age as number,
    maxDriverAge: r.max_driver_age as number,
  };
}

const ACRISS_CATEGORY = /^[MNEHCDIJSRFGPULWOX]$/;

/** Card fields shared by the class catalog (car_classes) and live offers. */
function vehicleCard(v: VerifiedCaravelVehicle, scopeSupplierId: string): Result<Json> {
  const errors: string[] = [];
  const id = text(v?.vehicleId, 200);
  const acriss = typeof v?.acrissCode === "string" ? v.acrissCode.trim().toUpperCase() : "";
  const name = text(v?.displayName, 250);
  if (!id) errors.push("VEHICLE_ID_UNVERIFIED");
  if (!text(scopeSupplierId, 128) || v?.supplierId !== scopeSupplierId) errors.push("SUPPLIER_SCOPE_MISMATCH");
  if (!/^[A-Z]{4}$/.test(acriss) || !ACRISS_CATEGORY.test(acriss[0])) errors.push("VEHICLE_CLASS_UNVERIFIED");
  if (!name) errors.push("VEHICLE_NAME_UNVERIFIED");
  // Optional spec fields are "not stated" when absent: a Ride24 card cannot show them truthfully.
  if (v?.transmission !== "manual" && v?.transmission !== "automatic") errors.push("TRANSMISSION_UNVERIFIED");
  if (!["petrol", "diesel", "hybrid", "plugin_hybrid", "electric"].includes(v?.fuelType as string)) errors.push("FUEL_UNVERIFIED");
  if (!safeInt(v?.seats) || v.seats < 1 || v.seats > 99) errors.push("SEATS_UNVERIFIED");
  if (!safeInt(v?.largeBags) || !safeInt(v?.smallBags) || v.largeBags < 0 || v.smallBags < 0 || v.largeBags + v.smallBags > 99)
    errors.push("BAGS_UNVERIFIED");
  if (v?.imageUrl !== null && !(typeof v?.imageUrl === "string" && /^https:\/\/\S+$/i.test(v.imageUrl)))
    errors.push("IMAGE_UNVERIFIED");
  // Ride24 cards render mileage_limit as km/day and 0/null as unlimited.
  const m = v?.mileage as Json | null | undefined;
  let mileageLimit: number | null = null;
  if (!m || typeof m.unlimited !== "boolean") errors.push("MILEAGE_UNVERIFIED");
  else if (m.unlimited === false) {
    if (!safeInt(m.limitKm) || (m.limitKm as number) < 1) errors.push("MILEAGE_UNVERIFIED");
    else mileageLimit = m.limitKm as number;
  }
  if (v?.depositAmountMinor !== null && (!safeInt(v?.depositAmountMinor) || v.depositAmountMinor < 0)) errors.push("DEPOSIT_UNVERIFIED");
  if (v?.airConditioning !== null && typeof v?.airConditioning !== "boolean") errors.push("FEATURE_FLAG_UNVERIFIED");
  if (!safeInt(v?.minDriverAge) || !safeInt(v?.maxDriverAge) || v.minDriverAge < 16 || v.maxDriverAge < v.minDriverAge)
    errors.push("DRIVER_AGE_LIMITS_UNVERIFIED");
  if (errors.length) return fail(errors);
  return okv({
    external_id: id,
    class_code: acriss[0],
    example_model: name,
    model: name,
    transmission: v.transmission,
    fuel_type: v.fuelType,
    seats: v.seats,
    bags: (v.largeBags as number) + (v.smallBags as number),
    image: v.imageUrl,
    description: name,
    mileage_limit: mileageLimit,
    driver_included: false,
    active: true,
    features: {
      provider: CARAVEL_PROVIDER,
      acriss,
      supplier_id: v.supplierId,
      large_bags: v.largeBags,
      small_bags: v.smallBags,
      minimum_driver_age: v.minDriverAge,
      maximum_driver_age: v.maxDriverAge,
      unlimited_mileage: mileageLimit === null,
      // Spec: deposit is a card pre-authorization at pickup. Zero deposit = no card hold.
      noCardHold: v.depositAmountMinor === 0,
      // The API states no "credit card required" fact; the badge waits for commercial confirmation.
      noCreditCard: false,
      airConditioning: v.airConditioning === true,
    },
  });
}

/** Ride24 standard group item for the class catalog (sync -> car_classes). */
export function normalizeCaravelVehicleClass(
  v: VerifiedCaravelVehicle,
  scopeSupplierId: string,
): Result<Json> {
  const card = vehicleCard(v, scopeSupplierId);
  if ("errors" in card) return card;
  // Catalog price is a placeholder the shared sync stores; search always
  // replaces it with the authoritative quote (price_is_total).
  return okv({...card.value, public_price: 0, deposit_amount: 0,
    features: {...(card.value.features as Json), fullInsurance: false}});
}

// ---------------------------------------------------------------- quote ----
export type CaravelQuoteRead = {
  quote: VerifiedCaravelQuote;
  mandatoryCharges: CaravelMandatoryCharge[];
  rentalDays: number;
  payNowMinor: number;
  payAtPickupMinor: number;
  discountMinor: number;
};

const LINE_KINDS = new Set(["base_rate", "protection", "extra", "fee", "discount"]);

/**
 * Read `POST /v1/quote` data (QuoteResponseData) with the protection it priced
 * (availability row `protection`, whose `excess` the quote does not repeat).
 * Components come from `line_items` by `kind` (base_rate + protection +
 * discount = rental; extra = extras; fee = mandatory fees) and must add up to
 * `totals.grand_total`; `pay_now + pay_at_pickup` must too.
 * Only tax-inclusive suppliers are accepted (spec: `Supplier.tax_inclusive`).
 */
export function caravelQuoteFromApi(data: unknown, protection: unknown, supplier: unknown): Result<CaravelQuoteRead> {
  const errors: string[] = [];
  const d = rec(data) ?? {};
  const s = rec(supplier) ?? {};
  const p = rec(protection) ?? {};
  const currency = typeof d.currency === "string" ? d.currency : "";
  if (s.tax_inclusive !== true) errors.push("TAX_INCLUSIVE_PRICES_REQUIRED");
  if (d.status !== "active") errors.push("QUOTE_NOT_ACTIVE");
  if (typeof d.quote_id !== "string" || !UUID.test(d.quote_id)) errors.push("QUOTE_ID_REQUIRED");
  if (!safeInt(d.rental_days) || (d.rental_days as number) < 1) errors.push("RENTAL_DAYS_UNVERIFIED");
  const expires = Date.parse(String(d.expires_at ?? ""));
  if (!Number.isFinite(expires)) errors.push("QUOTE_EXPIRY_UNVERIFIED");
  const totals = rec(d.totals) ?? {};
  const grand = money(totals.grand_total), payNow = money(totals.pay_now), payAt = money(totals.pay_at_pickup);
  if (!grand || !payNow || !payAt || [grand, payNow, payAt].some((m) => m.currency !== currency)) errors.push("TOTALS_UNVERIFIED");
  const deposit = money(rec(rec(d.deposit)?.amount) ?? rec(d.deposit)?.amount);
  const excess = money(p.excess);
  if (!deposit || deposit.currency !== currency) errors.push("DEPOSIT_UNVERIFIED");
  if (!excess || excess.currency !== currency) errors.push("EXCESS_UNVERIFIED");
  if (p.protection_id === undefined) errors.push("PROTECTION_UNVERIFIED");
  const sums = {base_rate: 0, protection: 0, extra: 0, fee: 0, discount: 0};
  const charges: CaravelMandatoryCharge[] = [];
  const lines = Array.isArray(d.line_items) ? d.line_items : null;
  if (!lines || !lines.length) errors.push("LINE_ITEMS_UNVERIFIED");
  for (const raw of lines ?? []) {
    const l = rec(raw);
    const kind = typeof l?.kind === "string" ? l.kind : "";
    const total = money(l?.total, kind === "discount");
    if (!LINE_KINDS.has(kind)) { errors.push("LINE_KIND_UNSUPPORTED"); continue; }
    if (!total || total.currency !== currency || (kind === "discount" ? total.amount > 0 : total.amount < 0)) {
      errors.push("LINE_AMOUNT_UNVERIFIED"); continue;
    }
    sums[kind as keyof typeof sums] += total.amount;
    if (kind === "fee") {
      charges.push({
        externalId: String((l as Json).fee_id ?? (l as Json).code ?? ""),
        label: String((l as Json).label ?? ""),
        category: String((l as Json).type ?? ""),
        amountMinor: total.amount,
        currency: total.currency,
      });
    }
  }
  const rental = sums.base_rate + sums.protection + sums.discount;
  if (rental < 0) errors.push("DISCOUNT_EXCEEDS_RENTAL");
  if (grand && rental + sums.extra + sums.fee !== grand.amount) errors.push("LINE_TOTAL_MISMATCH");
  if (grand && payNow && payAt && payNow.amount + payAt.amount !== grand.amount) errors.push("PAYMENT_SPLIT_MISMATCH");
  if (errors.length) return fail(errors);
  return okv({
    quote: {
      currency,
      rentalAmountMinor: rental,
      extrasAmountMinor: sums.extra,
      mandatoryFeesAmountMinor: sums.fee,
      totalAmountMinor: grand!.amount,
      quoteId: d.quote_id as string,
      expiresAtEpochMs: expires,
      plan: typeof d.plan === "string" ? d.plan : "",
      depositAmountMinor: deposit!.amount,
      excessAmountMinor: excess!.amount,
    },
    mandatoryCharges: charges,
    rentalDays: d.rental_days as number,
    payNowMinor: payNow!.amount,
    payAtPickupMinor: payAt!.amount,
    discountMinor: sums.discount,
  });
}

// --------------------------------------------------------------- offers ----
export type CaravelOfferInput = {
  vehicle: VerifiedCaravelVehicle;
  quote: VerifiedCaravelQuote;
  protectionId: string;
  mandatoryCharges: CaravelMandatoryCharge[];
  payment?: {payNowMinor: number; payAtPickupMinor: number};
  operatingHours: {
    pickupLocalTime: string; returnLocalTime: string;
    pickupTimezone: string; returnTimezone: string;
    pickupOutsideHours: boolean | null; returnOutsideHours: boolean | null;
  };
  rules: VerifiedCaravelRules;
  extras: VerifiedCaravelExtra[];
  context: {
    scopeSupplierId: string;
    partnerCurrency: string;
    pickupLocationId: string;
    dropoffLocationId: string;
    pickupEpochMs: number;
    dropoffEpochMs: number;
    /** Ride24 rental days for the same period (search-api `days`). */
    rentalDays: number;
    /** Provider billed days (quote `rental_days`); required for selected daily extras. */
    providerChargeableDays?: number;
    driverAge: number;
    nowEpochMs: number;
  };
};

/**
 * Build one Ride24 standard offer from a verified Caravel vehicle and its
 * authoritative quote. The result goes through shared normalizeGroups() and
 * apiPriceTotals(): the provider grand total is the partner public price, then
 * the partner discount and the Ride24 margin apply as for other partners.
 *
 * Extras: the shared Ride24 API booking path rejects selected extras
 * (assertApiRequestedOptions), so a quote that includes extras is refused
 * here until shared code supports provider-priced extras.
 */
export function buildCaravelOffer(input: CaravelOfferInput): Result<Json> {
  const errors: string[] = [];
  const card = vehicleCard(input?.vehicle, input?.context?.scopeSupplierId);
  if ("errors" in card) errors.push(...card.errors);
  const ctx = (input?.context ?? {}) as CaravelOfferInput["context"];
  const q = (input?.quote ?? {}) as VerifiedCaravelQuote;
  const quote = verifyCaravelQuote(q, ctx.nowEpochMs);
  if ("errors" in quote) errors.push(...quote.errors);
  const charges = verifyCaravelMandatoryCharges({
    charges: input?.mandatoryCharges,
    quoteCurrency: q?.currency,
    quoteMandatoryFeesMinor: q?.mandatoryFeesAmountMinor,
    ...input?.operatingHours,
  });
  if ("errors" in charges) errors.push(...charges.errors);
  const selection = validateCaravelSelection({
    pickupEpochMs: ctx?.pickupEpochMs,
    dropoffEpochMs: ctx?.dropoffEpochMs,
    driverAge: ctx?.driverAge,
    rules: (input?.rules ?? {}) as VerifiedCaravelRules,
    extras: Array.isArray(input?.extras) ? input.extras : [],
    rentalDaysForPricing: ctx?.providerChargeableDays,
  });
  if ("errors" in selection) errors.push(...selection.errors);
  if (!Array.isArray(input?.extras)) errors.push("EXTRAS_UNVERIFIED");
  else if (input.extras.some((e) => e?.selectedQuantity > 0) || q?.extrasAmountMinor !== 0)
    errors.push("SELECTED_EXTRAS_NOT_SUPPORTED");
  if ("extrasAmountMinor" in selection && selection.extrasAmountMinor !== q.extrasAmountMinor) errors.push("EXTRAS_TOTAL_MISMATCH");
  if (!ctx || q?.currency !== ctx.partnerCurrency || input?.rules?.currency !== q?.currency)
    errors.push("PARTNER_CURRENCY_MISMATCH");
  if (!safeInt(ctx?.rentalDays) || ctx.rentalDays < 1 || ctx.rentalDays > 366) errors.push("RENTAL_DAYS_UNVERIFIED");
  if (!text(ctx?.pickupLocationId, 200) || !text(ctx?.dropoffLocationId, 200)) errors.push("LOCATION_ID_UNVERIFIED");
  if (!text(input?.protectionId, 200)) errors.push("PROTECTION_ID_UNVERIFIED");
  const pay = input?.payment;
  if (pay !== undefined && (!safeInt(pay?.payNowMinor) || !safeInt(pay?.payAtPickupMinor) ||
      pay.payNowMinor < 0 || pay.payAtPickupMinor < 0 || pay.payNowMinor + pay.payAtPickupMinor !== q?.totalAmountMinor))
    errors.push("PAYMENT_SPLIT_MISMATCH");
  if ("value" in card && quote.ok) {
    const f = card.value.features as Json;
    const age = ctx.driverAge;
    if (age < (f.minimum_driver_age as number) || age > (f.maximum_driver_age as number)) errors.push("DRIVER_AGE_OUT_OF_RANGE");
    // The deposit on the card must be the deposit the quote states.
    if (input.vehicle.depositAmountMinor !== null && input.vehicle.depositAmountMinor !== q.depositAmountMinor)
      errors.push("DEPOSIT_MISMATCH");
  }
  const total = minorToMajor(q?.totalAmountMinor, q?.currency);
  if (total === null || total <= 0) errors.push("QUOTE_TOTAL_UNVERIFIED");
  if (errors.length) return fail(errors);

  const c = (card as {value: Json}).value;
  const amounts = {
    rental: minorToMajor(q.rentalAmountMinor, q.currency),
    extras: minorToMajor(q.extrasAmountMinor, q.currency),
    mandatory_fees: minorToMajor(q.mandatoryFeesAmountMinor, q.currency),
    out_of_hours: minorToMajor((charges as {outOfHoursAmountMinor: number}).outOfHoursAmountMinor, q.currency),
    total,
    pay_now: pay ? minorToMajor(pay.payNowMinor, q.currency) : null,
    pay_at_pickup: pay ? minorToMajor(pay.payAtPickupMinor, q.currency) : null,
  };
  return okv({
    ...c,
    public_price: Number((total! / ctx.rentalDays).toFixed(6)),
    price_is_total: true,
    public_price_total: total,
    currency: q.currency,
    deposit_amount: 0,
    location_external_ids: [...new Set([ctx.pickupLocationId, ctx.dropoffLocationId])],
    quote_reference: q.quoteId,
    quote_expires_at: new Date(q.expiresAtEpochMs).toISOString(),
    features: {
      ...(c.features as Json),
      noCardHold: q.depositAmountMinor === 0,
      plan: "premium",
      fullInsurance: true,
      excess_amount: 0,
      deposit_amount: 0,
      mandatory_fees_amount: amounts.mandatory_fees,
      out_of_hours_amount: amounts.out_of_hours,
    },
    provider_quote_data: {
      provider: CARAVEL_PROVIDER,
      quote_id: q.quoteId,
      supplier_id: input.vehicle.supplierId,
      vehicle_id: input.vehicle.vehicleId,
      protection_id: input.protectionId,
      plan: "premium",
      currency: q.currency,
      // The quote's priced driver set: the booking must restate it exactly (spec).
      drivers: [{age: ctx.driverAge, role: "main"}],
      amounts_minor: {
        rental: q.rentalAmountMinor, extras: q.extrasAmountMinor,
        mandatory_fees: q.mandatoryFeesAmountMinor, total: q.totalAmountMinor,
        pay_now: pay?.payNowMinor ?? null, pay_at_pickup: pay?.payAtPickupMinor ?? null,
      },
      amounts,
      mandatory_charges: input.mandatoryCharges.map((fee) => ({
        external_id: fee.externalId, label: fee.label, type: fee.category,
        amount: minorToMajor(fee.amountMinor, fee.currency),
      })),
      expires_at: new Date(q.expiresAtEpochMs).toISOString(),
    },
  });
}

/**
 * Full path from documented API objects: one availability row (vehicle fields,
 * `plan`, `protection`), the availability `meta.policies`, the `POST /v1/quote`
 * data for that row, and the supplier record.
 */
export function buildCaravelOfferFromApi(input: {
  availabilityRow: unknown;
  policies: unknown;
  quoteData: unknown;
  supplier: unknown;
  operatingHours: CaravelOfferInput["operatingHours"];
  context: Omit<CaravelOfferInput["context"], "providerChargeableDays">;
}): Result<Json> {
  const row = rec(input?.availabilityRow) ?? {};
  const errors: string[] = [];
  if (row.plan !== "premium") errors.push("PREMIUM_REQUIRED");
  const protection = rec(row.protection);
  const read = caravelQuoteFromApi(input?.quoteData, protection, input?.supplier);
  if ("errors" in read) errors.push(...read.errors);
  if (errors.length) return fail(errors);
  const r = (read as {value: CaravelQuoteRead}).value;
  const vehicle = caravelVehicleFromApi(row, input.policies);
  return buildCaravelOffer({
    vehicle,
    quote: r.quote,
    protectionId: String(protection?.protection_id ?? ""),
    mandatoryCharges: r.mandatoryCharges,
    payment: {payNowMinor: r.payNowMinor, payAtPickupMinor: r.payAtPickupMinor},
    operatingHours: input.operatingHours,
    // Rental-length bounds are enforced by Caravel itself (unsellable_window /
    // quote 422), so only the age limits are re-checked here.
    rules: {minRentalMinutes: 1, minDriverAge: vehicle.minDriverAge, maxDriverAge: vehicle.maxDriverAge, currency: r.quote.currency},
    extras: [],
    context: {...input.context, providerChargeableDays: r.rentalDays},
  });
}

/** Wrap normalized items as the Ride24 standard payload the shared normalizers read. */
export function ride24StandardPayload(
  items: {locations?: Ride24StandardLocation[]; groups?: Json[]},
): {locations: Ride24StandardLocation[]; groups: Json[]} {
  return {locations: items.locations ?? [], groups: items.groups ?? []};
}

// ------------------------------------------------------- extras catalog ----
export type VerifiedCaravelExtraDefinition = VerifiedCaravelExtra & {
  /** Provider category mapped to a Ride24 catalog code, or null. */
  ride24Code: "child_seat" | "booster_seat" | "gps" | "additional_driver" | null;
  /** Extra.price_cap per unit per rental; null = uncapped. */
  priceCapMinor: number | null;
  payable: "prepaid" | "at_pickup";
};

/** Extra.category -> Ride24 code. Boosters are inside `child_seat` in the spec. */
const EXTRA_CATEGORY_MAP: Readonly<Record<string, VerifiedCaravelExtraDefinition["ride24Code"]>> = Object.freeze({
  child_seat: "child_seat", navigation: "gps", additional_driver: "additional_driver",
});

/** Read one `GET /v1/reference/extras` record (or availability meta.extras entry). */
export function caravelExtraFromApi(raw: unknown): VerifiedCaravelExtraDefinition {
  const r = rec(raw) ?? {};
  const unit = money(r.unit_price);
  const cap = r.price_cap === null ? null : money(r.price_cap);
  const qty = rec(r.quantity) ?? {};
  const max = safeInt(qty.max) ? Math.min(qty.max as number, 9) : NaN;
  const countable = r.requires_quantity === true;
  return {
    externalId: r.extra_id as string,
    name: r.name as string,
    unitAmountMinor: unit ? unit.amount : NaN,
    currency: unit ? unit.currency : "",
    chargingUnit: r.pricing_type === "per_day" ? "day" : r.pricing_type === "per_rental" ? (countable ? "quantity" : "rental") : ("" as "day"),
    maxQuantity: countable ? max : 1,
    selectedQuantity: 0,
    ride24Code: typeof r.category === "string" && Object.hasOwn(EXTRA_CATEGORY_MAP, r.category) ? EXTRA_CATEGORY_MAP[r.category] : null,
    priceCapMinor: r.price_cap === null ? null : cap ? cap.amount : NaN,
    payable: r.payable as "prepaid" | "at_pickup",
  };
}

const EXTRA_NAMES_PL: Readonly<Record<string, string>> = Object.freeze({
  child_seat: "Fotelik dziecięcy", booster_seat: "Podstawka dla dziecka",
  gps: "Nawigacja GPS", additional_driver: "Dodatkowy kierowca",
});
const EXTRA_NAMES_EN: Readonly<Record<string, string>> = Object.freeze({
  child_seat: "Child seat", booster_seat: "Booster seat",
  gps: "GPS navigation", additional_driver: "Additional driver",
});

/**
 * Map provider extras to the Ride24 partner_extras shape (code, names,
 * amount, billing, max_quantity). Rows are returned with active=false: the
 * shared API pricing guard refuses API partners with active local extras until
 * provider-priced extras are reconciled in shared code (proposal for Work).
 * A capped daily extra is refused: Ride24's local day x price formula has no cap.
 */
export function caravelExtrasCatalog(
  extras: VerifiedCaravelExtraDefinition[],
  currency: string,
): {rows: Json[]; rejected: Array<{externalId: unknown; error: string}>} {
  const rows: Json[] = [];
  const rejected: Array<{externalId: unknown; error: string}> = [];
  const codes = new Set<string>();
  for (const e of Array.isArray(extras) ? extras : []) {
    const amount = e?.currency === currency ? amountString(e.unitAmountMinor, currency) : null;
    const billing = e?.chargingUnit === "day" ? "day" : e?.chargingUnit === "rental" || e?.chargingUnit === "quantity" ? "rental" : null;
    // Countable extras keep their quantity limit (Ride24 bills quantity x unit, x days for "day").
    const max = e?.maxQuantity;
    let error: string | null = null;
    if (!e?.ride24Code || !Object.hasOwn(EXTRA_NAMES_PL, e.ride24Code)) error = "EXTRA_CODE_UNMAPPED";
    else if (codes.has(e.ride24Code)) error = "EXTRA_CODE_DUPLICATE";
    else if (amount === null || billing === null) error = "EXTRA_PRICE_UNVERIFIED";
    else if (e.priceCapMinor !== null && (billing === "day" || !safeInt(e.priceCapMinor))) error = "EXTRA_PRICE_CAP_UNSUPPORTED";
    else if (e.payable !== "prepaid" && e.payable !== "at_pickup") error = "EXTRA_PAYABLE_UNVERIFIED";
    else if (!safeInt(max) || max < 1 || max > 9) error = "EXTRA_QUANTITY_UNSUPPORTED";
    if (error) { rejected.push({externalId: e?.externalId ?? null, error}); continue; }
    codes.add(e.ride24Code!);
    rows.push({
      code: e.ride24Code,
      name_pl: EXTRA_NAMES_PL[e.ride24Code!],
      name_en: EXTRA_NAMES_EN[e.ride24Code!],
      amount,
      billing,
      max_quantity: max,
      active: false,
      external_id: e.externalId,
      payable: e.payable,
    });
  }
  return {rows, rejected};
}

// ---------------------------------------------------- sync row builders ----
const LOCATION_TYPES = new Set(["airport", "city", "port", "station", "hotel"]);

/**
 * Same column mapping as the existing API partner sync (api-partner-admin),
 * except card badges: Caravel badges come only from verified provider data.
 * Input must already be the output of shared normalizeLocations()/normalizeGroups().
 */
export function caravelSyncRows(
  partnerId: string,
  locations: Json[],
  groups: Json[],
  verifiedFlags: Map<string, {noCreditCard: boolean; noCardHold: boolean}>,
): {partner_locations: Json[]; car_classes: Json[]} {
  if (!text(partnerId, 64)) throw new Error("PARTNER_ID_REQUIRED");
  return {
    partner_locations: locations.map((l) => ({
      partner_id: partnerId,
      external_id: l.external_id,
      is_api_managed: true,
      country: l.country,
      region: l.region,
      city: l.city || null,
      location_name: l.location_name,
      type: LOCATION_TYPES.has(String(l.type || "").toLowerCase()) ? String(l.type).toLowerCase() : "city",
      extra_fee: l.extra_fee === true,
      extra_fee_amount: l.extra_fee_amount ?? null,
      return_fee_amount: l.return_fee_amount ?? 0,
      contact_required: l.contact_required === true,
      active: l.active !== false,
    })),
    car_classes: groups.map((g) => {
      const flags = verifiedFlags.get(String(g.external_id));
      return {
        partner_id: partnerId,
        external_id: g.external_id,
        is_api_managed: true,
        class_code: g.class_code,
        public_price: g.public_price,
        example_model: g.example_model || g.model || null,
        model: g.model || g.example_model || null,
        transmission: g.transmission || null,
        fuel_type: g.fuel_type || null,
        seats: g.seats ?? 5,
        bags: g.bags ?? 2,
        image: g.image || null,
        description: g.description || g.example_model || g.class_code,
        features: {
          ...((g.features as Json) || {}),
          api_location_external_ids: g.location_external_ids || [],
          noCreditCard: flags?.noCreditCard === true,
          noCardHold: flags?.noCardHold === true,
        },
        mileage_limit: g.mileage_limit ?? null,
        deposit_amount: g.deposit_amount ?? 0,
        // search-api reads car_classes.min_driver_age for the card/booking check.
        min_driver_age: Number.isSafeInteger((g.features as Json)?.minimum_driver_age)
          ? (g.features as Json).minimum_driver_age : null,
        driver_included: g.driver_included === true,
        active: g.active !== false,
      };
    }),
  };
}
