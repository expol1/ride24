/**
 * Ride24 rental-day billing: started 24-hour periods using the local wall clock
 * at the rental location (dates and times have no timezone offset).
 * A day starts at pick-up time; a partially started subsequent day is billable.
 */
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

function dateUtc(value: string): number {
  if (typeof value !== "string" || !DATE.test(value)) throw new Error("INVALID_RENTAL_DATE");
  const valueMs = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(valueMs) || new Date(valueMs).toISOString().slice(0, 10) !== value) {
    throw new Error("INVALID_RENTAL_DATE");
  }
  return valueMs;
}

function timeOffset(value: string): number {
  if (typeof value !== "string") throw new Error("INVALID_RENTAL_TIME");
  const match = TIME.exec(value);
  if (!match) throw new Error("INVALID_RENTAL_TIME");
  return (+match[1] * 3600 + +match[2] * 60 + +(match[3] || 0)) * 1000;
}

export function rentalDuration(
  pickupDate: string, returnDate: string,
  pickupTime: string, returnTime: string,
): { billedDays: number; fullDays: number; elapsedMs: number; pricingEndDate: string } {
  const elapsedMs = dateUtc(returnDate) - dateUtc(pickupDate)
    + timeOffset(returnTime) - timeOffset(pickupTime);
  if (elapsedMs <= 0 || elapsedMs > 366 * DAY_MS) throw new Error("INVALID_RENTAL_DURATION");
  const billedDays = Math.ceil(elapsedMs / DAY_MS);
  const fullDays = Math.floor(elapsedMs / DAY_MS);
  const pricingEndDate = new Date(dateUtc(pickupDate) + billedDays * DAY_MS).toISOString().slice(0, 10);
  return {billedDays, fullDays, elapsedMs, pricingEndDate};
}

/** One day is the default (no extra restriction); 2+ require complete 24-hour units. */
export function meetsMinimumRental(duration: {fullDays: number}, minimum: unknown): boolean {
  const value = Number(minimum);
  const days = Number.isInteger(value) && value >= 1 && value <= 366 ? value : 1;
  return days <= 1 || duration.fullDays >= days;
}
