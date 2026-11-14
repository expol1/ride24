/**
 * Caravel booking bridge for the common Ride24 reservation flow (isolated).
 *
 * Ride24 dispatch hands every API partner the same ProviderBookingInput
 * (shared provider-adapters.ts). This module turns that input plus the stored
 * api_quotes.provider_quote_data into the documented quoted-create body
 * (OpenAPI v1.67.0 CreateQuotedBookingRequest) and checks the Ride24 partner
 * amount against Caravel's authoritative quote total, so that a changed price
 * is never booked silently.
 */
import {CARAVEL_PROVIDER} from "./caravel-normalize.ts";
import type {CaravelQuotedBookingRequest} from "./caravel-sandbox-adapter.ts";

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
  /** Spec quote_id: UUID. */
  quoteId: string;
  supplierId: string;
  /** Spec external_ref: ^[A-Za-z0-9._-]{1,64}$, unique per supplier, immutable. */
  externalRef: string;
  /** Spec Idempotency-Key: client UUID. */
  idempotencyKey: string;
  mainDriver: {firstName: string; lastName: string; age: number};
  contact: {email: string; phone: string | null};
  expectedPartnerAmount: number;
  currency: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9 ().-]{5,32}$/;
const EXTERNAL_REF = /^[A-Za-z0-9._-]{1,64}$/;
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

/**
 * Partner amount in Ride24 = provider total after the partner discount (apiPriceTotals).
 * For Caravel the discount must be 0: under pay_on_arrival Caravel collects exactly
 * grand_total at the desk, and Ride24 charges only its own booking fee via Stripe.
 */
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
  const quoteId = typeof data?.quote_id === "string" && UUID.test(data.quote_id) ? data.quote_id : null;
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
  if (Number(input?.partner_discount_percent ?? 0) !== 0) errors.push("PARTNER_DISCOUNT_NOT_ALLOWED");
  const expected = expectedPartnerAmount(total, 0);
  if (expected === null) errors.push("QUOTE_TOTAL_UNVERIFIED");
  else if (typeof input?.partner_amount !== "number" || Math.abs(input.partner_amount - expected) > 0.009)
    errors.push("PARTNER_AMOUNT_MISMATCH");
  const idem = typeof input?.idempotency_key === "string" && UUID.test(input.idempotency_key) ? input.idempotency_key : null;
  if (!idem) errors.push("IDEMPOTENCY_REQUIRED");
  const ride24Id = text(input?.ride24_booking_id, 100);
  const externalRef = ride24Id ? `ride24-sandbox-${ride24Id}` : "";
  if (!ride24Id || !EXTERNAL_REF.test(externalRef)) errors.push("BOOKING_ID_REQUIRED");
  const name = splitName(input?.main_driver?.name);
  const age = input?.main_driver?.age;
  if (!name) errors.push("DRIVER_NAME_REQUIRED");
  if (typeof age !== "number" || !Number.isSafeInteger(age) || age < 16 || age > 120) errors.push("DRIVER_AGE_REQUIRED");
  // Spec: the booking's {age, role} multiset must equal the quote's priced drivers.
  const priced = Array.isArray(data?.drivers) ? data.drivers : null;
  if (!priced || priced.length !== 1 || !isRecord(priced[0]) || priced[0].role !== "main" || priced[0].age !== age)
    errors.push("DRIVER_SET_CHANGED");
  // Additional drivers are priced; the shared API path rejects them.
  if (input?.additional_driver) errors.push("ADDITIONAL_DRIVER_NOT_SUPPORTED");
  const email = text(input?.client_email, 254);
  if (!email || !EMAIL.test(email)) errors.push("CONTACT_EMAIL_REQUIRED");
  if (errors.length) return {ok: false, errors: [...new Set(errors)]};
  const phone = text(input.client_phone, 32);
  return {ok: true, draft: {
    quoteId: quoteId!,
    supplierId: supplierId!,
    externalRef,
    idempotencyKey: idem!,
    mainDriver: {...name!, age: age as number},
    contact: {email: email!, phone: phone && PHONE.test(phone) ? phone : null},
    expectedPartnerAmount: expected!,
    currency,
  }};
}

/** Draft -> documented quoted-create body (strict request schema: documented fields only). */
export function caravelQuotedBookingRequest(draft: CaravelBookingDraft): CaravelQuotedBookingRequest {
  const customer: CaravelQuotedBookingRequest["customer"] = {
    first_name: draft.mainDriver.firstName,
    last_name: draft.mainDriver.lastName,
    email: draft.contact.email,
  };
  if (draft.contact.phone) customer.phone = draft.contact.phone;
  return {
    quote_id: draft.quoteId,
    external_ref: draft.externalRef,
    drivers: [{first_name: draft.mainDriver.firstName, last_name: draft.mainDriver.lastName, age: draft.mainDriver.age, role: "main"}],
    customer,
    // Ride24 sells Caravel only under pay_on_arrival (sandbox permits every model, so it is always sent).
    payment_model: "pay_on_arrival",
  };
}

/**
 * Caravel Booking.status (OpenAPI v1.67.0 §8.1: confirmed, pending, cancelled,
 * no_show, completed; open list) -> Ride24 canonical status. Ride24 has no
 * no_show/completed state, and unknown values are "unconfirmed" per the spec,
 * so those return null and the booking goes to manual review.
 */
const STATUS: Readonly<Record<string, "pending" | "confirmed" | "cancelled">> = Object.freeze({
  pending: "pending",
  confirmed: "confirmed",
  cancelled: "cancelled",
});

export function caravelCanonicalStatus(value: unknown): "pending" | "confirmed" | "cancelled" | null {
  const key = typeof value === "string" ? value : "";
  return Object.hasOwn(STATUS, key) ? STATUS[key] : null;
}

/** Read cancellation outcome from a cancelled Booking (spec: cancellation.fee; refund is always zero). */
export function caravelCancellationFromApi(booking: unknown): {ok: true; feeMinor: number; currency: string; revision: number} | {ok: false; errors: string[]} {
  const b = isRecord(booking) ? booking : {};
  const c = isRecord(b.cancellation) ? b.cancellation : null;
  const fee = c && isRecord(c.fee) ? c.fee : null;
  const errors: string[] = [];
  if (b.status !== "cancelled") errors.push("NOT_CANCELLED");
  if (!fee || !Number.isSafeInteger(fee.amount) || (fee.amount as number) < 0 || typeof fee.currency !== "string" || !/^[A-Z]{3}$/.test(fee.currency))
    errors.push("CANCELLATION_FEE_UNVERIFIED");
  if (!Number.isSafeInteger(b.revision) || (b.revision as number) < 1) errors.push("REVISION_UNVERIFIED");
  if (errors.length) return {ok: false, errors};
  return {ok: true, feeMinor: fee!.amount as number, currency: fee!.currency as string, revision: b.revision as number};
}

export type CaravelStatusView = {
  caravel: string;
  /** Ride24 canonical status, or null when Ride24 has no equivalent / the value is unknown. */
  ride24: "pending" | "confirmed" | "cancelled" | null;
  terminal: boolean;
  /** Needs a person: never auto-treated as confirmed or finished. */
  review: boolean;
  known: boolean;
};

/** Full lifecycle view; an unknown future status is never confirmed or terminal. */
export function caravelBookingStatus(value: unknown): CaravelStatusView {
  const v = typeof value === "string" ? value : "";
  switch (v) {
    case "pending": return {caravel: v, ride24: "pending", terminal: false, review: false, known: true};
    case "confirmed": return {caravel: v, ride24: "confirmed", terminal: false, review: false, known: true};
    case "cancelled": return {caravel: v, ride24: "cancelled", terminal: true, review: false, known: true};
    case "no_show": return {caravel: v, ride24: null, terminal: true, review: true, known: true};
    case "completed": return {caravel: v, ride24: null, terminal: true, review: true, known: true};
    default: return {caravel: v || "missing", ride24: null, terminal: false, review: true, known: false};
  }
}

/**
 * Check a created booking against the quote it consumed: same quote_id, same
 * grand_total and currency, confirmed, pay_on_arrival, zero deposit/excess.
 */
export function verifyCaravelBookingAgainstQuote(
  booking: unknown,
  quote: {quoteId: string; totalAmountMinor: number; currency: string},
): {ok: true; bookingId: string; revision: number} | {ok: false; errors: string[]} {
  const b = isRecord(booking) ? booking : {};
  const errors: string[] = [];
  const price = isRecord(b.price) ? b.price : null;
  const totals = price && isRecord(price.totals) ? price.totals : null;
  const grand = totals && isRecord(totals.grand_total) ? totals.grand_total : null;
  const protection = isRecord(b.protection) ? b.protection : null;
  const payment = isRecord(b.payment) ? b.payment : null;
  const zero = (m: unknown) => isRecord(m) && m.amount === 0;
  if (typeof b.booking_id !== "string" || !UUID.test(b.booking_id)) errors.push("BOOKING_ID_MISSING");
  if (!Number.isSafeInteger(b.revision) || (b.revision as number) < 1) errors.push("REVISION_MISSING");
  if (b.quote_id !== quote?.quoteId) errors.push("QUOTE_ID_MISMATCH");
  if (b.status !== "confirmed") errors.push("NOT_CONFIRMED");
  if (!grand || grand.amount !== quote?.totalAmountMinor || grand.currency !== quote?.currency) errors.push("BOOKED_PRICE_DIFFERS_FROM_QUOTE");
  if (!protection || !zero(protection.excess) || !zero(protection.deposit)) errors.push("BOOKED_PROTECTION_NOT_ZERO_RISK");
  if (payment) {
    if (payment.model !== "pay_on_arrival") errors.push("PAYMENT_MODEL_NOT_PAY_ON_ARRIVAL");
    const onArrival = isRecord(payment.amount_on_arrival) ? payment.amount_on_arrival.amount : undefined;
    if (onArrival !== undefined && onArrival !== quote?.totalAmountMinor) errors.push("AMOUNT_ON_ARRIVAL_DIFFERS");
  }
  if (errors.length) return {ok: false, errors};
  return {ok: true, bookingId: b.booking_id as string, revision: b.revision as number};
}

export type CaravelErrorAction = "requote" | "refetch_then_retry" | "retry_same_key" | "stop";

/**
 * What the booking flow does on a Caravel error (documented codes, OpenAPI v1.67.0
 * error catalogue). Unknown codes stop safely (certification: degrade generically).
 */
export function caravelErrorAction(error: unknown): {action: CaravelErrorAction; code: string; status: number | null} {
  const e = isRecord(error) ? error : {};
  const code = typeof e.code === "string" ? e.code : "UNKNOWN";
  const status = typeof e.status === "number" ? e.status : null;
  const requote = ["availability_changed", "price_changed", "quote_expired", "quote_consumed", "no_availability"];
  const retry = ["idempotency_in_progress", "rate_limited", "service_unavailable"];
  if (requote.includes(code)) return {action: "requote", code, status};
  if (code === "revision_conflict") return {action: "refetch_then_retry", code, status};
  if (retry.includes(code) || status === 429 || status === 503) return {action: "retry_same_key", code, status};
  return {action: "stop", code, status};
}
