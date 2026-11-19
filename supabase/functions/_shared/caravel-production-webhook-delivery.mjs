/**
 * Production Caravel webhook boundary: HMAC over exact callback path/bytes,
 * authenticated supplier-side booking refetch and durable service-role recording.
 * Does not act on the untrusted webhook snapshot; a non-2xx response asks Caravel
 * to redeliver after transient failures. No Stripe or voucher writes here.
 */
import {verifyCaravelSignature, parseCaravelWebhookEvent} from "./caravel-webhooks.ts";

export const CARAVEL_PRODUCTION_WEBHOOK_PATH = "/functions/v1/caravel-production-webhook";
const MAX_BYTES = 32768;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();
const rec = (x) => x && typeof x === "object" && !Array.isArray(x) ? x : null;

export async function handleCaravelProductionDelivery({
  method, path, rawBody, signature, secrets, fetchBooking, record, nowSecs,
} = {}) {
  if (method !== "POST" || path !== CARAVEL_PRODUCTION_WEBHOOK_PATH)
    return {status: 405, accepted: false, reason: "METHOD_OR_PATH_INVALID"};
  if (typeof rawBody !== "string" || encoder.encode(rawBody).byteLength > MAX_BYTES)
    return {status: 413, accepted: false, reason: "BODY_TOO_LARGE"};
  if (!signature) return {status: 401, accepted: false, reason: "INVALID_SIGNATURE"};
  if (!Array.isArray(secrets) || !secrets.some(s => typeof s === "string" && s.length > 0))
    return {status: 503, accepted: false, reason: "SIGNING_SECRET_MISSING"};
  if (!await verifyCaravelSignature(signature, secrets, {method: "POST", path, body: rawBody}, {nowSecs}))
    return {status: 401, accepted: false, reason: "INVALID_SIGNATURE"};
  const event = parseCaravelWebhookEvent(rawBody);
  if (!event || !ID.test(event.event_id) || !ID.test(event.booking_id) || !ID.test(event.operator_id) ||
      !ID.test(event.supplier_id ?? "") || event.api_version !== "1.67.0" ||
      typeof event.external_ref !== "string" || event.external_ref.length > 150 ||
      !Number.isFinite(Date.parse(event.occurred_at)) ||
      (event.sequence !== null && event.sequence < 1))
    return {status: 400, accepted: false, reason: "INVALID_SIGNED_EVENT"};
  if (event.type === "webhook.test") {
    if (event.data.test !== true || !event.external_ref.startsWith("WEBHOOK-TEST-"))
      return {status: 400, accepted: false, reason: "INVALID_TEST_EVENT"};
    return {status: 200, accepted: true, reason: "SIGNED_TEST_RECEIVED"};
  }
  if (typeof fetchBooking !== "function" || typeof record !== "function")
    return {status: 503, accepted: false, reason: "RECEIVER_NOT_CONFIGURED"};
  try {
    // Only provider GET is authoritative. The received event.data is NEVER used.
    const b = rec(await fetchBooking(event.booking_id, event.supplier_id));
    if (!b || b.booking_id !== event.booking_id || b.external_ref !== event.external_ref ||
        (b.supplier_id != null && b.supplier_id !== event.supplier_id) ||
        !Number.isSafeInteger(b.revision) || b.revision < event.revision ||
        typeof b.status !== "string" || !ID.test(b.status))
      throw new Error("CARAVEL_BOOKING_REFETCH_MISMATCH");
    const stored = rec(await record({
      event_id: event.event_id, event_type: event.type, occurred_at: event.occurred_at,
      operator_id: event.operator_id, supplier_id: event.supplier_id,
      supplier_booking_id: event.booking_id, external_ref: event.external_ref,
      event_revision: event.revision, fetched_revision: b.revision,
      sequence: event.sequence, provider_status: b.status,
    }));
    if (stored?.accepted !== true || typeof stored.duplicate !== "boolean")
      throw new Error("CARAVEL_DURABLE_RECORD_UNCONFIRMED");
    return {status: stored.duplicate ? 200 : 202, accepted: true,
      reason: stored.duplicate ? "DUPLICATE" : "VERIFIED_AND_RECORDED",
      needs_reconciliation: stored.sequence_gap === true};
  } catch {
    return {status: 503, accepted: false, reason: "RETRYABLE_VERIFICATION_OR_STORE_FAILURE"};
  }
}
