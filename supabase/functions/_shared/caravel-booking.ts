/**
 * Caravel booking bridge for the common Ride24 reservation flow (isolated).
 *
 * Ride24 dispatch hands every API partner the same ProviderBookingInput
 * (shared provider-adapters.ts). This module turns that input plus the stored
 * api_quotes.provider_quote_data into a Caravel booking draft, and checks the
 * Ride24 partner amount against Caravel's authoritative quote total so that a
 * changed price is never booked silently.
 *
 * The final Caravel JSON field names for customer and drivers are NOT
 * assumed here; the draft is converted after the OpenAPI contract is
 * validated (isolation gate, stage B).
 */
import {CARAVEL_PROVIDER} from "./caravel-normalize.ts";

type Json = Record<string, unknown>;

/** Structural subset of shared ProviderBookingInput (provider-adapters.ts). */
export type Ride24BookingInput = {
  idempotency_key: string;
  ride24_booking_id: string;
  reservation_code?: string | null;
  vehicle_group_id: string | null;
  pickup_location_id?: string | null;
  dropoff_location_id?: string | null;
  main_driver?: {name?: string | null; age?: number | null} | null;
  additional_driver?: {name?: string | null; age?: number | null} | null;
  client_email?: string | null;
  client_phone?: string | null;
  currency?: string | null;
  partner_discount_percent?: number | null;
  partner_amount?: number | null;
  quote_reference?: string | null;
  provider_quote_data?: unknown;
};

export type CaravelBookingDraft = {
  quoteId: string;
  supplierId: string;
  externalRef: string;
  idempotencyKey: string;
  mainDriver: {firstName: string; lastName: string; age: number};
  contact: {email: string; phone: string | null};
  expectedPartnerAmount: number;
  currency: string;
};

const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;

function splitName(value: unknown): {firstName: string; lastName: string} | null {
  const full = text(value, 200);
  if (!full) return null;
  const parts = full.split(/\s+/);
  if (parts.length < 2) return null;
  return {firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1]};
}

/** Partner amount in Ride24 = provider total after the partner discount (apiPriceTotals). */
export function expectedPartnerAmount(totalMajor: number, discountPercent: number): number | null {
  if (!Number.isFinite(totalMajor) || totalMajor <= 0 || !Number.isFinite(discountPercent) ||
      discountPercent < 0 || discountPercent > 50) return null;
  const exact = totalMajor * (1 - discountPercent / 100);
  return Math.round((exact + Number.EPSILON) * 100) / 100;
}

export function buildCaravelBookingDraft(
  input: Ride24BookingInput,
  nowEpochMs: number,
): {ok: true; draft: CaravelBookingDraft} | {ok: false; errors: string[]} {
  const errors: string[] = [];
  const data = isRecord(input?.provider_quote_data) ? input.provider_quote_data : null;
  const amounts = data && isRecord(data.amounts) ? data.amounts : null;
  if (!data || data.provider !== CARAVEL_PROVIDER) errors.push("CARAVEL_QUOTE_REQUIRED");
  const quoteId = text(data?.quote_id, 500);
  if (!quoteId || (input?.quote_reference && input.quote_reference !== quoteId)) errors.push("QUOTE_REFERENCE_MISMATCH");
  if (data?.plan !== "premium") errors.push("PREMIUM_REQUIRED");
  if (!text(data?.vehicle_id, 200) || data?.vehicle_id !== input?.vehicle_group_id) errors.push("VEHICLE_MISMATCH");
  const supplierId = text(data?.supplier_id, 128);
  if (!supplierId) errors.push("SUPPLIER_REQUIRED");
  const expires = Date.parse(String(data?.expires_at ?? ""));
  if (!Number.isFinite(expires) || !Number.isSafeInteger(nowEpochMs) || expires <= nowEpochMs) errors.push("QUOTE_EXPIRED");
  const currency = typeof data?.currency === "string" ? data.currency : "";
  if (!/^[A-Z]{3}$/.test(currency) || input?.currency !== currency) errors.push("CURRENCY_MISMATCH");
  const total = typeof amounts?.total === "number" ? amounts.total : NaN;
  const expected = expectedPartnerAmount(total, Number(input?.partner_discount_percent ?? 0));
  if (expected === null) errors.push("QUOTE_TOTAL_UNVERIFIED");
  else if (typeof input?.partner_amount !== "number" || Math.abs(input.partner_amount - expected) > 0.009)
    errors.push("PARTNER_AMOUNT_MISMATCH");
  const idem = text(input?.idempotency_key, 200);
  const ride24Id = text(input?.ride24_booking_id, 100);
  if (!idem) errors.push("IDEMPOTENCY_REQUIRED");
  if (!ride24Id || !/^[A-Za-z0-9-]+$/.test(ride24Id)) errors.push("BOOKING_ID_REQUIRED");
  const name = splitName(input?.main_driver?.name);
  const age = input?.main_driver?.age;
  if (!name) errors.push("DRIVER_NAME_REQUIRED");
  if (typeof age !== "number" || !Number.isSafeInteger(age) || age < 16 || age > 120) errors.push("DRIVER_AGE_REQUIRED");
  // Additional drivers are a priced extra; the shared API path rejects them.
  if (input?.additional_driver) errors.push("ADDITIONAL_DRIVER_NOT_SUPPORTED");
  const email = text(input?.client_email, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("CONTACT_EMAIL_REQUIRED");
  if (errors.length) return {ok: false, errors: [...new Set(errors)]};
  return {ok: true, draft: {
    quoteId: quoteId!,
    supplierId: supplierId!,
    // Matches the sandbox client guard; production prefix is decided at wiring time.
    externalRef: `ride24-sandbox-${ride24Id}`,
    idempotencyKey: idem!,
    mainDriver: {...name!, age: age as number},
    contact: {email: email!, phone: text(input.client_phone, 40)},
    expectedPartnerAmount: expected!,
    currency,
  }};
}

/**
 * Caravel booking status -> Ride24 canonical status. The value table must be
 * confirmed against the OpenAPI enum (stage B). Unknown values return null so
 * the caller keeps the booking for manual review instead of guessing.
 */
const STATUS: Readonly<Record<string, "pending" | "confirmed" | "rejected" | "cancelled">> = Object.freeze({
  pending: "pending",
  on_request: "pending",
  confirmed: "confirmed",
  rejected: "rejected",
  declined: "rejected",
  cancelled: "cancelled",
  canceled: "cancelled",
});

export function caravelCanonicalStatus(value: unknown): "pending" | "confirmed" | "rejected" | "cancelled" | null {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.hasOwn(STATUS, key) ? STATUS[key] : null;
}
