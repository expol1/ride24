/**
 * Caravel adapter for Ride24's SHARED Stripe-first API fulfilment
 * (api-payment-flow.mjs / api-payment-runtime.ts / api-provider-fulfillment.ts).
 * This is NOT a second booking system: the shared workflow owns payment
 * evidence, the single atomic dispatch claim (api_claim_paid_dispatch),
 * unknown-outcome manual review, refunds and voucher finalisation.
 *
 * Contract of the three hooks (same as Renteon/Arvent):
 *  - revalidate: pure checks + read-only supplier calls; a DefiniteApiFailure
 *    means "never book, refund the Ride24 fee"; any other throw means
 *    "retry revalidation later". Never writes to Caravel.
 *  - create: exactly one POST /v1/bookings with a booking-derived, stable
 *    Idempotency-Key and external_ref (ride24-<uuid>). Any throw is treated by
 *    the shared flow as UNKNOWN (manual review) — never re-sent with a new key.
 *  - status: read-only GET; confirmed only when price, payment model and zero
 *    deposit/excess still match the accepted quote.
 *
 * Disabled unless BOTH server flags are set (like Arvent), on top of the
 * independent DB/partner/checkout holds:
 *   CARAVEL_PRODUCTION_WRITES_ALLOWED=true and CARAVEL_STRIPE_FIRST_APPROVED=true
 * Production only: the sandbox never goes through the paid flow.
 */
import {CaravelClient, CARAVEL_BASE_URLS, isUuid, type CaravelQuoteRequest} from "./caravel-sandbox-adapter.ts";
import {verifyCaravelBookingAgainstQuote, caravelBookingStatus} from "./caravel-booking.ts";
import {caravelQuoteFromApi} from "./caravel-normalize.ts";
import {DefiniteApiFailure} from "./api-payment-flow.mjs";

type Rec = Record<string, unknown>;
export const CARAVEL_PARTNER_ID = "78721481-7619-44df-a9b7-5faa344b69bb";
const SUPPLIER = /^[A-Za-z0-9_-]{1,128}$/;
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const fail = (code: string): never => { throw new DefiniteApiFailure(code); };
// deno-lint-ignore no-explicit-any
const env = (k: string): string | undefined => (globalThis as any).Deno?.env?.get(k);

export function caravelPaidFulfillmentApproved(read: (k: string) => string | undefined = env): boolean {
  return read("CARAVEL_PRODUCTION_WRITES_ALLOWED") === "true" && read("CARAVEL_STRIPE_FIRST_APPROVED") === "true";
}

/** Stable UUID per (booking, purpose): replays reuse the same Idempotency-Key. */
export async function caravelBookingUuid(bookingId: string, purpose: "quote" | "book"): Promise<string> {
  if (!isUuid(bookingId)) throw new Error("CARAVEL_BOOKING_ID_INVALID");
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`ride24-caravel:${purpose}:${bookingId.toLowerCase()}`)));
  d[6] = (d[6] & 0x0f) | 0x50; d[8] = (d[8] & 0x3f) | 0x80;
  const h = [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export type CaravelClientFactory = (apiKey: string, writes: boolean) => Pick<CaravelClient,
  "environment" | "quote" | "book" | "bookingStatusSandbox" | "suppliers" | "referenceTerms" | "cancel">;
const defaultFactory: CaravelClientFactory = (apiKey, writes) => new CaravelClient({
  apiKey, environment: "production", allowProduction: true, allowProductionBookingWrites: writes});

function productionKey(credentials: unknown): string {
  const c = rec(credentials);
  const key = typeof c?.api_key === "string" ? c.api_key.trim() : "";
  if (!key || c?.api_url !== CARAVEL_BASE_URLS.production) fail("CARAVEL_PRODUCTION_CREDENTIALS_INVALID");
  return key;
}
const cents = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) : null;
};
const splitName = (full: unknown): {first: string; last: string} | null => {
  const parts = typeof full === "string" ? full.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length < 2) return null;
  return {first: parts.slice(0, -1).join(" ").slice(0, 100), last: parts[parts.length - 1].slice(0, 100)};
};

/** Accepted, server-issued Caravel quote data (see caravel-quote-issuance.ts). */
function acceptedQuote(booking: Rec, quote: Rec | null) {
  if (!quote || quote.booking_id !== booking.id || quote.partner_id !== booking.partner_id ||
      quote.partner_id !== CARAVEL_PARTNER_ID || quote.car_class_id !== booking.car_class_id ||
      booking.api_quote_id !== quote.id || quote.start_date !== booking.start_date || quote.end_date !== booking.end_date)
    fail("ACCEPTED_QUOTE_MISMATCH");
  const data = rec(rec(quote!.raw_response)?.provider_quote_data);
  const minor = rec(data?.amounts_minor);
  const total = minor?.total, payNow = minor?.pay_now, atPickup = minor?.pay_at_pickup;
  if (!data || data.provider !== "caravel" || typeof data.supplier_id !== "string" || !SUPPLIER.test(data.supplier_id) ||
      !isUuid(data.quote_id) || data.plan !== "premium" || data.payment_model !== "pay_on_arrival" ||
      (data.currency !== "EUR" && data.currency !== "GBP") || typeof data.vehicle_id !== "string" ||
      data.vehicle_id !== quote!.external_group_id || typeof data.protection_id !== "string" ||
      !Number.isSafeInteger(total) || (total as number) <= 0 || payNow !== 0 || atPickup !== total ||
      typeof data.pickup_at !== "string" || typeof data.dropoff_at !== "string" ||
      !Number.isFinite(Date.parse(data.pickup_at)) || !Number.isFinite(Date.parse(data.dropoff_at)))
    fail("ACCEPTED_QUOTE_MISMATCH");
  // Rental is paid at the desk to Caravel; Stripe only ever took the separate Ride24 fee.
  if (booking.partner_currency !== data!.currency || cents(booking.partner_net_price_snapshot) !== total ||
      (cents(booking.online_payment_pln) ?? 0) <= 0)
    fail("ACCEPTED_QUOTE_MISMATCH");
  return {data: data!, totalMinor: total as number};
}

/** Customer terms and coverage consent captured BEFORE Stripe must match the quote exactly. */
function acceptedConsent(booking: Rec, data: Rec) {
  // Same rule as public.caravel_commit_pending_booking: the disclosed codes are the
  // quote's protection.excludes; coverage consent exists exactly when something is excluded.
  const excludes = rec(data.protection)?.excludes;
  if (!Array.isArray(excludes)) fail("CARAVEL_TERMS_CONSENT_MISSING_OR_STALE");
  const excluded = [...(excludes as string[])].sort();
  if (typeof data.terms_document_id !== "string" || !data.terms_document_id ||
      typeof data.terms_content_hash !== "string" || !/^[0-9a-f]{64}$/.test(data.terms_content_hash) ||
      booking.caravel_terms_document_id !== data.terms_document_id ||
      booking.caravel_terms_content_hash !== data.terms_content_hash ||
      booking.caravel_terms_language !== data.terms_language || booking.terms_accepted === false)
    fail("CARAVEL_TERMS_CONSENT_MISSING_OR_STALE");
  if (excluded.length === 0) {
    if (booking.caravel_coverage_excluded_codes != null || booking.caravel_coverage_accepted_at != null)
      fail("CARAVEL_TERMS_CONSENT_MISSING_OR_STALE");
    return;
  }
  const accepted = Array.isArray(booking.caravel_coverage_excluded_codes)
    ? [...booking.caravel_coverage_excluded_codes as string[]].sort() : [];
  if (typeof booking.caravel_coverage_accepted_at !== "string" ||
      booking.caravel_coverage_quote_id !== data.quote_id ||
      booking.caravel_coverage_supplier_id !== data.supplier_id ||
      booking.caravel_coverage_terms_document_id !== data.terms_document_id ||
      booking.caravel_coverage_terms_content_hash !== data.terms_content_hash ||
      JSON.stringify(excluded) !== JSON.stringify(accepted) ||
      (booking.caravel_coverage_damage_admin_fee_minor ?? null) !== (data.damage_administration_fee_minor ?? null))
    fail("CARAVEL_TERMS_CONSENT_MISSING_OR_STALE");
}

export async function revalidatePaidCaravel(credentials: unknown, booking: Rec, quote: Rec | null,
  opts: {factory?: CaravelClientFactory; nowMs?: number} = {}) {
  if (!caravelPaidFulfillmentApproved()) fail("ADAPTER_NOT_READY");
  if (booking.cancelled_at || ["cancelled", "rejected", "expired", "payment_expired"].includes(String(booking.status)))
    fail("CANCELLED_BEFORE_DISPATCH");
  const {data, totalMinor} = acceptedQuote(booking, quote);
  acceptedConsent(booking, data);
  const main = splitName(booking.main_driver_name), age = Number(booking.main_driver_age);
  if (!main || !Number.isInteger(age) || age < 18 || age > 99 || booking.add_driver_name || booking.add_driver_age ||
      typeof booking.client_email !== "string" || !booking.client_email.includes("@"))
    fail("CARAVEL_DRIVER_DETAILS_UNSUPPORTED");
  const client = (opts.factory ?? defaultFactory)(productionKey(credentials), false);
  const supplierId = data.supplier_id as string;
  // Live terms: the accepted document must still be the current one (a new
  // document_id invalidates the customer's consent: refund, never book).
  const terms = (await client.referenceTerms(supplierId)).data;
  const current = terms.filter((t) => t.language === data.terms_language && t.withdrawn_at === null);
  if (current.length !== 1 || current[0].document_id !== data.terms_document_id ||
      current[0].content_hash !== data.terms_content_hash)
    fail("CARAVEL_TERMS_CHANGED_AFTER_CONSENT");
  // Re-quote with the identical selection and a booking-derived key; book on the
  // fresh quote only when money, plan and zero-risk cover are unchanged.
  const request: CaravelQuoteRequest = {
    pickup: {location_id: String(quote!.pickup_location_external_id), at: data.pickup_at as string},
    dropoff: {location_id: String(quote!.dropoff_location_external_id), at: data.dropoff_at as string},
    vehicle_id: data.vehicle_id as string, protection_id: data.protection_id as string, plan: "premium",
    currency: data.currency as string, drivers: [{age, role: "main"}],
  };
  const suppliers = (await client.suppliers()).data as Rec[];
  const supplier = suppliers.find((s) => s.supplier_id === supplierId);
  if (!supplier || supplier.status !== "active" || supplier.currency !== data.currency || supplier.tax_inclusive !== true)
    fail("CARAVEL_SUPPLIER_NOT_ACTIVE");
  const fresh = (await client.quote(request, await caravelBookingUuid(String(booking.id), "quote"), supplierId)).data;
  const parsed = caravelQuoteFromApi(fresh, data.protection, supplier);
  if ("errors" in parsed || parsed.value.quote.plan !== "premium" || parsed.value.quote.currency !== data.currency ||
      // totals.pay_now is a price-line split, not the schedule (contract §6.2): only the
      // total is compared; booking.payment proves nothing is prepaid.
      parsed.value.quote.totalAmountMinor !== totalMinor || parsed.value.quote.depositAmountMinor !== 0 ||
      parsed.value.quote.excessAmountMinor !== 0 ||
      parsed.value.quote.expiresAtEpochMs < (opts.nowMs ?? Date.now()) + 60_000)
    fail("PROVIDER_PRICE_OR_TERMS_CHANGED");
  if ("errors" in parsed) throw new DefiniteApiFailure("PROVIDER_PRICE_OR_TERMS_CHANGED");
  const key = await caravelBookingUuid(String(booking.id), "book");
  return {
    provider: "caravel", idempotency_key: key, external_ref: `ride24-${key}`,
    ride24_booking_id: booking.id, reservation_code: booking.reservation_code,
    supplier_id: supplierId, quote_id: parsed.value.quote.quoteId, accepted_quote_id: data.quote_id,
    total_minor: totalMinor, currency: data.currency, partner_amount: totalMinor / 100,
    terms_document_id: data.terms_document_id, terms_content_hash: data.terms_content_hash,
    main_driver: {first_name: main!.first, last_name: main!.last, age},
    customer: {first_name: main!.first, last_name: main!.last, email: booking.client_email,
      ...(typeof booking.client_phone === "string" && booking.client_phone ? {phone: booking.client_phone} : {})},
  };
}

function resultFromBooking(raw: unknown, prepared: Rec) {
  const b = rec(raw);
  const status = caravelBookingStatus(b?.status);
  const reference = typeof b?.booking_id === "string" ? b.booking_id : null;
  if (status.ride24 === "cancelled")
    return {status: "rejected", definitive_rejection: true, booking_reference: reference, reference};
  if (status.ride24 === "pending") return {status: "pending", booking_reference: reference, reference};
  const verified = verifyCaravelBookingAgainstQuote(b, {quoteId: String(prepared.quote_id),
    totalAmountMinor: Number(prepared.total_minor), currency: String(prepared.currency)}, {strictProductionPayment: true});
  if (!reference || "errors" in verified || b?.external_ref !== prepared.external_ref)
    return {status: status.caravel, booking_reference: reference, reference, needs_manual_review: true};
  return {status: "confirmed", booking_reference: reference, reference,
    provider_payload: {booking_id: reference, quote_id: prepared.quote_id, revision: verified.revision,
      payment_model: "pay_on_arrival", supplier_id: prepared.supplier_id}};
}

export async function createPaidCaravel(credentials: unknown, prepared: Rec, opts: {factory?: CaravelClientFactory} = {}) {
  if (!caravelPaidFulfillmentApproved()) fail("ADAPTER_NOT_READY");
  if (prepared?.provider !== "caravel" || !isUuid(prepared.idempotency_key) ||
      prepared.external_ref !== `ride24-${prepared.idempotency_key}` || !isUuid(prepared.quote_id) ||
      typeof prepared.supplier_id !== "string" || !SUPPLIER.test(prepared.supplier_id))
    fail("CARAVEL_PREPARED_BOOKING_INVALID");
  const client = (opts.factory ?? defaultFactory)(productionKey(credentials), true);
  const main = rec(prepared.main_driver)!, customer = rec(prepared.customer)!;
  const response = await client.book({
    quote_id: prepared.quote_id as string, external_ref: prepared.external_ref as string,
    drivers: [{first_name: main.first_name as string, last_name: main.last_name as string, age: main.age as number, role: "main"}],
    customer: customer as never, payment_model: "pay_on_arrival",
  }, prepared.idempotency_key as string, prepared.supplier_id as string);
  return resultFromBooking(response.data, prepared);
}

export async function readPaidCaravelStatus(credentials: unknown, reference: string, prepared: Rec,
  opts: {factory?: CaravelClientFactory} = {}) {
  if (!caravelPaidFulfillmentApproved()) fail("ADAPTER_NOT_READY");
  if (typeof reference !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(reference)) fail("CARAVEL_REFERENCE_INVALID");
  const client = (opts.factory ?? defaultFactory)(productionKey(credentials), false);
  const response = await client.bookingStatusSandbox(reference, String(prepared?.supplier_id));
  return resultFromBooking(response.data, prepared);
}

/** Read-only production client from partner_api_credentials (search, consent re-quote). */
export function caravelProductionReadClient(credentials: unknown) {
  return defaultFactory(productionKey(credentials), false) as CaravelClient;
}

/** Stable UUID for any Ride24 idempotency string (e.g. "ride24:cancel:<booking id>"). */
async function uuidFromKey(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ride24-caravel:${key}`)));
  d[6] = (d[6] & 0x0f) | 0x50; d[8] = (d[8] & 0x3f) | 0x80;
  const h = [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Cancel a confirmed Caravel booking from the EXISTING Ride24 cancellation flows
 * (client-cancel-booking, api-booking-dispatch, api-booking-status-sync via
 * cancelProviderBooking). Free until pickup under the Ride24 agreement (clause 13);
 * any fee Caravel reports is returned for the existing refund logic, never hidden.
 * Reads the current revision, cancels with a stable Idempotency-Key, refetches once
 * on 409 revision_conflict. Needs CARAVEL_PRODUCTION_WRITES_ALLOWED=true; otherwise
 * it throws and the existing flow queues manual review.
 */
export async function cancelCaravelBooking(credentials: unknown, reference: string, body: Rec = {},
  opts: {factory?: CaravelClientFactory; read?: (k: string) => string | undefined} = {}) {
  if ((opts.read ?? env)("CARAVEL_PRODUCTION_WRITES_ALLOWED") !== "true") throw new Error("CARAVEL_CANCEL_WRITES_DISABLED");
  if (typeof reference !== "string" || !isUuid(reference)) throw new Error("CARAVEL_REFERENCE_INVALID");
  const client = (opts.factory ?? defaultFactory)(productionKey(credentials), true);
  const key = await uuidFromKey(String(body.idempotency_key ?? `cancel:${reference}`));
  const read = async () => rec((await client.bookingStatusSandbox(reference)).data) ?? {};
  let current = await read();
  if (current.status === "cancelled")
    return {booking_reference: reference, reference, status: "cancelled", provider_payload: {revision: current.revision, already_cancelled: true}};
  let result: Rec | null = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = rec((await client.cancel(reference, Number(current.revision), key)).data);
    } catch (e) {
      if ((e as {code?: string})?.code !== "revision_conflict" || attempt > 0) throw e;
      current = await read();
      if (current.status === "cancelled")
        return {booking_reference: reference, reference, status: "cancelled", provider_payload: {revision: current.revision}};
    }
  }
  const status = caravelBookingStatus(result?.status);
  const fee = rec(rec(result?.cancellation)?.fee);
  return {booking_reference: reference, reference, status: status.ride24 === "cancelled" ? "cancelled" : status.caravel,
    provider_payload: {revision: result?.revision, cancellation_fee_minor: typeof fee?.amount === "number" ? fee.amount : null,
      cancellation_fee_currency: typeof fee?.currency === "string" ? fee.currency : null}};
}
