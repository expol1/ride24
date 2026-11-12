/**
 * Caravel pre-publication validation. Pure, isolated logic: no API field guesses.
 * Call only AFTER a documented Caravel->Ride24 mapper supplies these values.
 * Unknown mandatory conditions fail closed; amounts are integer minor units.
 */
export type VerifiedCaravelRules = {
  minRentalMinutes: number;
  minDriverAge: number;
  maxDriverAge: number;
  currency: string;
};
export type VerifiedCaravelExtra = {
  externalId: string;
  name: string;
  unitAmountMinor: number;
  currency: string;
  chargingUnit: "rental" | "day" | "quantity";
  maxQuantity: number;
  selectedQuantity: number;
};
export type CaravelValidation = {ok: true; rentalMinutes: number; extrasAmountMinor: number} |
  {ok: false; errors: string[]};
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
export function validateCaravelSelection(input: {
  pickupEpochMs: number;
  dropoffEpochMs: number;
  driverAge: number;
  rules: VerifiedCaravelRules;
  extras: VerifiedCaravelExtra[];
  rentalDaysForPricing?: number;
}): CaravelValidation {
  const errors: string[] = [];
  const {rules, extras} = input;
  const duration = (input.dropoffEpochMs - input.pickupEpochMs) / 60000;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(duration)) errors.push("INVALID_RENTAL_PERIOD");
  if (!integer(rules.minRentalMinutes) || rules.minRentalMinutes < 1) errors.push("MIN_RENTAL_UNVERIFIED");
  else if (duration < rules.minRentalMinutes) errors.push("BELOW_MIN_RENTAL");
  if (!integer(rules.minDriverAge) || !integer(rules.maxDriverAge) ||
      rules.minDriverAge < 16 || rules.maxDriverAge < rules.minDriverAge) errors.push("DRIVER_AGE_LIMITS_UNVERIFIED");
  else if (!integer(input.driverAge) || input.driverAge < rules.minDriverAge || input.driverAge > rules.maxDriverAge) errors.push("DRIVER_AGE_OUT_OF_RANGE");
  if (!/^[A-Z]{3}$/.test(rules.currency)) errors.push("CURRENCY_UNVERIFIED");
  const ids = new Set<string>();
  let total = 0;
  for (const extra of extras) {
    if (!extra.externalId || ids.has(extra.externalId)) errors.push("INVALID_EXTRA_ID");
    ids.add(extra.externalId);
    if (!extra.name.trim() || !integer(extra.unitAmountMinor) || extra.unitAmountMinor < 0 ||
        extra.currency !== rules.currency || !integer(extra.maxQuantity) || extra.maxQuantity < 0 ||
        !integer(extra.selectedQuantity) || extra.selectedQuantity < 0 || extra.selectedQuantity > extra.maxQuantity ||
        !["rental", "day", "quantity"].includes(extra.chargingUnit)) {
      errors.push("EXTRA_UNVERIFIED");
      continue;
    }
    // Day-based charging requires the provider-confirmed number of chargeable days.
    const units = extra.chargingUnit === "day" ? input.rentalDaysForPricing :
      extra.chargingUnit === "rental" ? (extra.selectedQuantity > 0 ? 1 : 0) : extra.selectedQuantity;
    if (!integer(units) || units < 0 || (extra.chargingUnit === "day" && extra.selectedQuantity > 1)) {
      errors.push("EXTRA_CHARGE_UNVERIFIED");
      continue;
    }
    const charge = extra.unitAmountMinor * units;
    if (!Number.isSafeInteger(charge) || !Number.isSafeInteger(total + charge)) errors.push("EXTRA_AMOUNT_OVERFLOW");
    else total += charge;
  }
  if (errors.length) return {ok:false, errors:[...new Set(errors)]};
  return {ok:true,rentalMinutes:duration,extrasAmountMinor:total};
}
