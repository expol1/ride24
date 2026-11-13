/**
 * Caravel -> Ride24 standard normalization (isolated, NOT wired into dispatch).
 *
 * Input: values already mapped from provider-documented Caravel fields
 * (Verified* types). Mapping raw API JSON to these types waits for the
 * validated OpenAPI contract (isolation gate, stage B); nothing here guesses
 * a Caravel field name.
 *
 * Output: the Ride24 standard partner payload ("ride24_standard_v1") that the
 * existing shared normalizeLocations()/normalizeGroups() accept unchanged, plus
 * partner_locations / car_classes rows in exactly the shape the existing
 * API sync writes. Cards, prices, Ride24 fee and partner payable are then
 * produced by the same shared code as for every other partner.
 *
 * Fail closed: anything unverified rejects the item with an error code
 * instead of falling back to a default that the customer would see.
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
type Result<T> = {ok: true; value: T} | {ok: false; errors: string[]};
const fail = <T>(errors: string[]): Result<T> => ({ok: false, errors: [...new Set(errors)]});
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

// ---------------------------------------------------------------- money ----
/** ISO 4217 minor-unit exponents. Unlisted currencies fail closed. */
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

/** Integer minor units -> Ride24 major-unit number (exact for <= 3 decimals). */
export function minorToMajor(amountMinor: unknown, currency: unknown): number | null {
  const exp = currencyExponent(currency);
  if (exp === null || !safeInt(amountMinor) || amountMinor < 0) return null;
  const value = amountMinor / 10 ** exp;
  return Number(value.toFixed(exp));
}

/** Ride24 partner_extras.amount format (decimal string, at most 2 decimals). */
function amountString(amountMinor: number, currency: string): string | null {
  const exp = currencyExponent(currency);
  const major = minorToMajor(amountMinor, currency);
  if (exp === null || major === null || exp > 2) return null;
  return major.toFixed(2);
}

// ------------------------------------------------------------ locations ----
export type VerifiedCaravelLocation = {
  locationId: string;
  supplierId: string;
  name: string;
  /** ISO 3166-1 alpha-2; rendered in English like other API partners. */
  countryCode: string;
  region: string | null;
  city: string | null;
  type: "airport" | "city" | "port" | "station" | "hotel" | null;
  timezone: string;
  active: boolean;
};

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
  active: boolean;
};

function countryName(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null;
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
 * Location fees are deliberately null: Caravel prices pickup/return charges in
 * its authoritative quote, and Ride24 refuses API partners that also carry
 * local location fees (assertApiPricingCompatible).
 */
export function normalizeCaravelLocation(
  loc: VerifiedCaravelLocation,
  scopeSupplierId: string,
): Result<Ride24StandardLocation> {
  const errors: string[] = [];
  const id = text(loc?.locationId, 200);
  const name = text(loc?.name, 250);
  const country = countryName(String(loc?.countryCode ?? ""));
  if (!id) errors.push("LOCATION_ID_UNVERIFIED");
  if (!name) errors.push("LOCATION_NAME_UNVERIFIED");
  if (!country) errors.push("COUNTRY_UNVERIFIED");
  if (!text(scopeSupplierId, 128) || loc?.supplierId !== scopeSupplierId) errors.push("SUPPLIER_SCOPE_MISMATCH");
  if (!validTimezone(loc?.timezone)) errors.push("TIMEZONE_UNVERIFIED");
  if (typeof loc?.active !== "boolean") errors.push("LOCATION_STATUS_UNVERIFIED");
  if (errors.length) return fail(errors);
  return {ok: true, value: {
    external_id: id!,
    country: country!,
    region: text(loc.region, 150) || text(loc.city, 150) || country!,
    city: text(loc.city, 150),
    location_name: name!,
    type: loc.type ?? "city",
    extra_fee: false,
    extra_fee_amount: null,
    return_fee_amount: null,
    contact_required: false,
    active: loc.active,
  }};
}

// ------------------------------------------------------------- vehicles ----
export type VerifiedCaravelVehicle = {
  vehicleId: string;
  supplierId: string;
  /** ACRISS/SIPP code; first letter is the Ride24 class letter. */
  acrissCode: string;
  makeModel: string;
  orSimilar: boolean;
  transmission: "manual" | "automatic";
  fuelType: "petrol" | "diesel" | "hybrid" | "electric" | "lpg";
  seats: number;
  bags: number;
  imageUrl: string | null;
  mileage: {unlimited: true} | {unlimited: false; limitKm: number; period: "day" | "rental"};
  creditCardRequired: boolean | null;
  cardHoldRequired: boolean | null;
  roadsideAssistance: boolean | null;
  airConditioning: boolean | null;
  minDriverAge: number;
  maxDriverAge: number;
  active: boolean;
};

const ACRISS_CATEGORY = /^[MNEHCDIJSRFGPULWOX]$/;

/** Card fields shared by the class catalog (car_classes) and live offers. */
function vehicleCard(v: VerifiedCaravelVehicle, scopeSupplierId: string): Result<Json> {
  const errors: string[] = [];
  const id = text(v?.vehicleId, 200);
  const acriss = typeof v?.acrissCode === "string" ? v.acrissCode.trim().toUpperCase() : "";
  const model = text(v?.makeModel, 230);
  if (!id) errors.push("VEHICLE_ID_UNVERIFIED");
  if (!text(scopeSupplierId, 128) || v?.supplierId !== scopeSupplierId) errors.push("SUPPLIER_SCOPE_MISMATCH");
  if (!/^[A-Z]{4}$/.test(acriss) || !ACRISS_CATEGORY.test(acriss[0])) errors.push("VEHICLE_CLASS_UNVERIFIED");
  if (!model || typeof v?.orSimilar !== "boolean") errors.push("VEHICLE_MODEL_UNVERIFIED");
  if (!["manual", "automatic"].includes(v?.transmission)) errors.push("TRANSMISSION_UNVERIFIED");
  if (!["petrol", "diesel", "hybrid", "electric", "lpg"].includes(v?.fuelType)) errors.push("FUEL_UNVERIFIED");
  if (!safeInt(v?.seats) || v.seats < 1 || v.seats > 99) errors.push("SEATS_UNVERIFIED");
  if (!safeInt(v?.bags) || v.bags < 0 || v.bags > 99) errors.push("BAGS_UNVERIFIED");
  if (v?.imageUrl !== null && !(typeof v?.imageUrl === "string" && /^https:\/\/[^\s]+$/i.test(v.imageUrl)))
    errors.push("IMAGE_UNVERIFIED");
  // Ride24 cards render mileage_limit as km/day and null as "unlimited":
  // a per-rental limit cannot be shown truthfully, so it fails closed.
  const m = v?.mileage as Json | undefined;
  let mileageLimit: number | null = null;
  if (!m || typeof m.unlimited !== "boolean") errors.push("MILEAGE_UNVERIFIED");
  else if (m.unlimited === false) {
    if (m.period !== "day") errors.push("MILEAGE_PERIOD_UNSUPPORTED");
    else if (!safeInt(m.limitKm) || (m.limitKm as number) < 1) errors.push("MILEAGE_UNVERIFIED");
    else mileageLimit = m.limitKm as number;
  }
  for (const key of ["creditCardRequired", "cardHoldRequired", "roadsideAssistance", "airConditioning"] as const) {
    if (v?.[key] !== null && typeof v?.[key] !== "boolean") errors.push("FEATURE_FLAG_UNVERIFIED");
  }
  if (!safeInt(v?.minDriverAge) || !safeInt(v?.maxDriverAge) || v.minDriverAge < 16 || v.maxDriverAge < v.minDriverAge)
    errors.push("DRIVER_AGE_LIMITS_UNVERIFIED");
  if (typeof v?.active !== "boolean") errors.push("VEHICLE_STATUS_UNVERIFIED");
  if (errors.length) return fail(errors);
  const displayModel = v.orSimilar ? `${model} or similar` : model!;
  return {ok: true, value: {
    external_id: id,
    class_code: acriss[0],
    example_model: displayModel,
    model: displayModel,
    transmission: v.transmission,
    fuel_type: v.fuelType,
    seats: v.seats,
    bags: v.bags,
    image: v.imageUrl,
    description: displayModel,
    mileage_limit: mileageLimit,
    driver_included: false,
    active: v.active,
    features: {
      provider: CARAVEL_PROVIDER,
      acriss,
      supplier_id: v.supplierId,
      minimum_driver_age: v.minDriverAge,
      maximum_driver_age: v.maxDriverAge,
      unlimited_mileage: mileageLimit === null,
      // Only an explicit provider "false" may produce the Ride24 badge.
      noCreditCard: v.creditCardRequired === false && v.cardHoldRequired === false,
      noCardHold: v.cardHoldRequired === false,
      roadsideAssistance: v.roadsideAssistance === true,
      airConditioning: v.airConditioning === true,
    },
  }};
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
  return {ok: true, value: {...card.value, public_price: 0, deposit_amount: 0,
    features: {...(card.value.features as Json), fullInsurance: false}}};
}

// --------------------------------------------------------------- offers ----
export type CaravelOfferInput = {
  vehicle: VerifiedCaravelVehicle;
  quote: VerifiedCaravelQuote;
  protectionId: string;
  mandatoryCharges: CaravelMandatoryCharge[];
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
    /** Provider-confirmed chargeable days, required for selected daily extras. */
    providerChargeableDays?: number;
    driverAge: number;
    nowEpochMs: number;
  };
};

/**
 * Build one Ride24 standard offer from a verified Caravel availability row and
 * its authoritative quote. The result goes through shared normalizeGroups() and
 * apiPriceTotals(): the provider total is the partner public price, then the
 * partner discount and the Ride24 margin apply exactly as for other partners.
 *
 * Extras: the shared Ride24 API booking path rejects selected extras
 * (assertApiRequestedOptions), so a quote that includes selected extras is
 * refused here until shared code supports provider-priced extras.
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
  if ("value" in card && quote.ok) {
    const f = card.value.features as Json;
    const age = ctx.driverAge;
    if (age < (f.minimum_driver_age as number) || age > (f.maximum_driver_age as number)) errors.push("DRIVER_AGE_OUT_OF_RANGE");
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
  };
  return {ok: true, value: {
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
      plan: "premium",
      fullInsurance: true,
      excess_amount: 0,
      deposit_amount: 0,
      min_rental_minutes: input.rules.minRentalMinutes,
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
      amounts_minor: {
        rental: q.rentalAmountMinor, extras: q.extrasAmountMinor,
        mandatory_fees: q.mandatoryFeesAmountMinor, total: q.totalAmountMinor,
      },
      amounts,
      mandatory_charges: input.mandatoryCharges.map((fee) => ({
        external_id: fee.externalId, label: fee.label, category: fee.category,
        amount: minorToMajor(fee.amountMinor, fee.currency),
      })),
      expires_at: new Date(q.expiresAtEpochMs).toISOString(),
    },
  }};
}

/** Wrap normalized items as the Ride24 standard payload the shared normalizers read. */
export function ride24StandardPayload(
  items: {locations?: Ride24StandardLocation[]; groups?: Json[]},
): {locations: Ride24StandardLocation[]; groups: Json[]} {
  return {locations: items.locations ?? [], groups: items.groups ?? []};
}

// ------------------------------------------------------- extras catalog ----
export type VerifiedCaravelExtraDefinition = VerifiedCaravelExtra & {
  /** Provider-confirmed category; only Ride24 catalog codes are mapped. */
  ride24Code: "child_seat" | "booster_seat" | "gps" | "additional_driver" | null;
};

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
    const max = e?.chargingUnit === "quantity" ? e.maxQuantity : 1;
    let error: string | null = null;
    if (!e?.ride24Code || !Object.hasOwn(EXTRA_NAMES_PL, e.ride24Code)) error = "EXTRA_CODE_UNMAPPED";
    else if (codes.has(e.ride24Code)) error = "EXTRA_CODE_DUPLICATE";
    else if (amount === null || billing === null) error = "EXTRA_PRICE_UNVERIFIED";
    else if (!safeInt(max) || max < 1 || max > 10) error = "EXTRA_QUANTITY_UNSUPPORTED";
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
    });
  }
  return {rows, rejected};
}

// ---------------------------------------------------- sync row builders ----
const LOCATION_TYPES = new Set(["airport", "city", "port", "station", "hotel"]);

/**
 * Same column mapping as the existing API partner sync (api-partner-admin),
 * except card badges: Caravel badges come only from verified provider flags.
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
        driver_included: g.driver_included === true,
        active: g.active !== false,
      };
    }),
  };
}
