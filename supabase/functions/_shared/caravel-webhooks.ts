/**
 * Caravel webhook handling (isolated; NO production receiver is deployed).
 * OpenAPI v1.67.0 WebhookEvent + Webhook Receiver Guide:
 *  - X-Caravel-Signature: "t=<unix-seconds>,v1=<lowercase hex>[,v1=...]";
 *    v1 = HMAC-SHA256(secret, "{t}.{method}.{path}.{body}") over the exact
 *    received bytes; several v1 during rotation (accept any); ignore unknown
 *    scheme tags; constant-time compare; reject t outside the replay window
 *    (300 s, either direction). Verify BEFORE parsing.
 *  - Delivery is at-least-once: dedupe on event_id.
 *  - revision is the per-booking ordering key; never apply an older revision.
 *  - The payload is a snapshot; Ride24 re-fetches the booking (GET) before acting.
 *  - sequence is consecutive per stream: a gap means missed deliveries ->
 *    reconcile with GET /v1/bookings?updated_since=... and/or redeliver.
 */
type Json = Record<string, unknown>;

const enc = new TextEncoder();
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function parseCaravelSignatureHeader(header: unknown): {t: number; v1: string[]} | null {
  if (typeof header !== "string" || header.length > 4096) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
    // Unknown scheme tags are ignored (spec).
  }
  return t === null || !v1.length ? null : {t, v1};
}

export async function caravelSignatureFor(secret: string, t: number, method: string, path: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${method}.${path}.${body}`)));
}

/** Verify a delivery against one or more active secrets (rotation overlap). */
export async function verifyCaravelSignature(
  header: unknown,
  secrets: string[],
  request: {method: string; path: string; body: string},
  options: {nowSecs?: number; skewSecs?: number} = {},
): Promise<boolean> {
  const parsed = parseCaravelSignatureHeader(header);
  if (!parsed || !Array.isArray(secrets) || !secrets.length) return false;
  const now = options.nowSecs ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > (options.skewSecs ?? 300)) return false;
  let ok = false;
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    const expected = await caravelSignatureFor(secret, parsed.t, request.method, request.path, request.body);
    for (const candidate of parsed.v1) if (constantTimeEqual(expected, candidate)) ok = true;
  }
  return ok;
}

export type CaravelWebhookEvent = {
  event_id: string; type: string; occurred_at: string; api_version: string; operator_id: string;
  booking_id: string; external_ref: string; revision: number; sequence: number | null; supplier_id: string | null; data: Json;
};

/** Parse a verified body; returns null for anything outside the documented envelope. */
export function parseCaravelWebhookEvent(body: string): CaravelWebhookEvent | null {
  let e: Json;
  try { e = JSON.parse(body); } catch { return null; }
  if (!e || typeof e !== "object") return null;
  const str = (k: string) => typeof e[k] === "string" && (e[k] as string).length > 0;
  if (!["event_id", "type", "occurred_at", "api_version", "operator_id", "booking_id", "external_ref"].every(str)) return null;
  if (!Number.isSafeInteger(e.revision) || (e.revision as number) < 1) return null;
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) return null;
  const data = e.data as Json;
  if (data.booking_id !== undefined && data.booking_id !== e.booking_id) return null;
  return {
    event_id: e.event_id as string, type: e.type as string, occurred_at: e.occurred_at as string,
    api_version: e.api_version as string, operator_id: e.operator_id as string, booking_id: e.booking_id as string,
    external_ref: e.external_ref as string, revision: e.revision as number,
    sequence: Number.isSafeInteger(e.sequence) ? e.sequence as number : null,
    supplier_id: typeof e.supplier_id === "string" ? e.supplier_id : null, data,
  };
}

export const CARAVEL_EVENT_TYPES = Object.freeze([
  "booking.confirmed", "booking.cancelled", "booking.modified", "booking.no_show", "booking.completed",
]);

export type CaravelWebhookState = {
  /** event ids already processed (persisted by the receiver). */
  hasEvent(eventId: string): boolean;
  /** highest revision applied per booking_id, or null. */
  lastRevision(bookingId: string): number | null;
  /** last delivery sequence per stream (operator), or null. */
  lastSequence(streamId: string): number | null;
};

export type CaravelWebhookDecision =
  | {action: "ignore"; reason: "DUPLICATE_EVENT" | "STALE_REVISION"}
  | {action: "refetch_booking"; booking_id: string; supplier_id: string | null; revision: number; known_type: boolean; sequence_gap: boolean; reconcile_since: string | null};

/**
 * Decide what to do with a verified, parsed event. Ride24 never applies the
 * payload directly: it re-fetches GET /v1/bookings/{booking_id}?ref_type=booking_id
 * and maps the fetched status. Unknown event types still trigger a re-fetch
 * (the booking is the source of truth) but are flagged.
 */
export function decideCaravelWebhookEvent(event: CaravelWebhookEvent, state: CaravelWebhookState): CaravelWebhookDecision {
  if (state.hasEvent(event.event_id)) return {action: "ignore", reason: "DUPLICATE_EVENT"};
  const last = state.lastRevision(event.booking_id);
  if (last !== null && event.revision <= last) return {action: "ignore", reason: "STALE_REVISION"};
  const lastSeq = state.lastSequence(event.operator_id);
  const gap = event.sequence !== null && lastSeq !== null && event.sequence > lastSeq + 1;
  return {
    action: "refetch_booking", booking_id: event.booking_id, supplier_id: event.supplier_id, revision: event.revision,
    known_type: CARAVEL_EVENT_TYPES.includes(event.type), sequence_gap: gap,
    // On a gap, reconcile from slightly before the last event we know about.
    reconcile_since: gap ? new Date(Date.parse(event.occurred_at) - 5 * 60_000).toISOString() : null,
  };
}

/** Accept a re-fetched booking only if it is not older than what Ride24 already holds. */
export function shouldApplyFetchedBooking(fetchedRevision: unknown, appliedRevision: number | null): boolean {
  return Number.isSafeInteger(fetchedRevision) && (fetchedRevision as number) >= 1 &&
    (appliedRevision === null || (fetchedRevision as number) > appliedRevision);
}
