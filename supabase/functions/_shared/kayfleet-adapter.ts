// Fast Rent a Car Cyprus — KayFleet Partner API v1.
// Read-only sandbox preparation. Booking creation is intentionally blocked until
// quote binding, deposits, payment conditions and extras are certified.
import {
  partnerApiRequest,
  type ApiLocation,
  type ApiVehicleGroup,
  type PartnerApiCredentials,
} from "./partner-api.ts";

type Json = Record<string, unknown>;
type Window = {
  pickup_location_id: string;
  dropoff_location_id: string;
  pickup_date: string;
  return_date: string;
  pickup_time?: string | null;
  return_time?: string | null;
  currency?: string | null;
};

function obj(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_RESPONSE");
  }
  return value as Json;
}
function rows(value: unknown, key: string): Json[] {
  const items = obj(value)[key];
  if (!Array.isArray(items)) throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_RESPONSE");
  return items.slice(0, 100).map(obj);
}
function txt(value: unknown, max = 200): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}
function money(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)
    || value < 0 || value > 10_000_000) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_" + label);
  }
  return value;
}
function positive(value: unknown, label: string): number {
  const n = money(value, label);
  if (n <= 0) throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_" + label);
  return n;
}
function imageUrl(value: unknown): string | null {
  const source = txt(value, 2000);
  if (!source) return null;
  try {
    const u = new URL(source);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}
function groupCode(name: string): string {
  // Ride24 class_code is a single UI category letter, NOT a promised ACRISS code.
  const first = name.trim().toUpperCase().match(/[A-Z]/)?.[0];
  return first || "A";
}

// Check both Cyprus UTC offsets against the actual IANA zone. Fail closed for
// missing/ambiguous wall-clock times during DST changes; never silently use UTC.
export function cyprusIso(date: string, time: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time || "10:00");
  if (!m || !t) throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_TIME");
  const [year, month, day, hour, minute, second] =
    [Number(m[1]), Number(m[2]), Number(m[3]), Number(t[1]), Number(t[2]), Number(t[3] || "0")];
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_TIME");
  }
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Nicosia", hourCycle: "h23", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit",
  });
  const expected = date + "T" + [hour, minute, second].map((n) => String(n).padStart(2, "0")).join(":");
  const valid = [120, 180].filter((offset) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utc - offset * 60_000))
      .filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    return parts.year + "-" + parts.month + "-" + parts.day + "T"
      + parts.hour + ":" + parts.minute + ":" + parts.second === expected;
  });
  if (valid.length !== 1) throw new Error("PARTNER_API_ERROR:KAYFLEET_AMBIGUOUS_TIME");
  return expected + (valid[0] === 120 ? "+02:00" : "+03:00");
}
function datetimes(window: Window) {
  if (!window.pickup_location_id || !window.dropoff_location_id) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_LOCATION_REQUIRED");
  }
  const pickup_datetime = cyprusIso(window.pickup_date, window.pickup_time);
  const return_datetime = cyprusIso(window.return_date, window.return_time);
  if (Date.parse(return_datetime) <= Date.parse(pickup_datetime)) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_WINDOW");
  }
  return { pickup_datetime, return_datetime };
}
export function normalizeKayFleetLocations(payload: unknown): ApiLocation[] {
  return rows(payload, "locations").map((x) => {
    const id = txt(x.location_id);
    const name = txt(x.name);
    if (!id || !name || txt(x.currency).toUpperCase() !== "EUR") {
      throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_LOCATION");
    }
    const isAirport = /airport|lotnisko/i.test(name);
    const city = /paphos|pafos/i.test(name) ? "Paphos"
      : /larnaca/i.test(name) ? "Larnaca"
      : /limassol/i.test(name) ? "Limassol"
      : /nicosia/i.test(name) ? "Nicosia" : name;
    const pickup = money(x.pickup_fee, "PICKUP_FEE");
    const dropoff = money(x.dropoff_fee, "DROPOFF_FEE");
    return {
      external_id: id, country: "Cyprus", region: city, city,
      location_name: name, type: isAirport ? "airport" : "city",
      extra_fee: pickup > 0 || dropoff > 0,
      extra_fee_amount: pickup, return_fee_amount: dropoff,
      active: true,
    };
  });
}
export function normalizeKayFleetGroups(payload: unknown): ApiVehicleGroup[] {
  return rows(payload, "vehicle_groups").map((x) => {
    const id = txt(x.group_id);
    const name = txt(x.name);
    if (!id || !name || txt(x.currency).toUpperCase() !== "EUR") {
      throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_GROUP");
    }
    // Metadata's daily_price_from is not a live offer; only quote is authoritative.
    const priceFrom = money(x.daily_price_from, "PRICE_FROM");
    return {
      external_id: id, class_code: groupCode(name), public_price: 0,
      currency: "EUR", model: name, example_model: name,
      description: name, seats: Number.isInteger(x.seats) ? Number(x.seats) : null,
      bags: Number.isInteger(x.bags) ? Number(x.bags) : null,
      image: imageUrl(x.image_url), deposit_amount: null,
      mileage_limit: null, active: true,
      features: { is_category: true, kayfleet_price_from_eur: priceFrom },
    };
  });
}
export function normalizeKayFleetQuote(
  group: ApiVehicleGroup, availability: Json, value: unknown, window: Window,
): ApiVehicleGroup {
  const q = obj(value);
  const reference = txt(q.quote_reference);
  const expires = txt(q.quote_expires_at);
  const expiration = Date.parse(expires);
  if (!reference || !expires || !Number.isFinite(expiration) || expiration <= Date.now()
    || txt(q.currency).toUpperCase() !== "EUR"
    || txt(q.group_id) !== group.external_id
    || money(q.insurance_excess, "EXCESS") !== 0
    || q.deposit_amount !== 0
    || (q.full_insurance != null && q.full_insurance !== true)) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_QUOTE_UNVERIFIED");
  }
  const days = positive(q.days, "DAYS");
  const parts = ["rental_total", "insurance_fee", "equipment_fee",
    "additional_driver_fee", "delivery_fee"].map((k) => money(q[k], k.toUpperCase()));
  const total = positive(q.grand_total, "GRAND_TOTAL");
  if (Math.abs(parts.reduce((a, b) => a + b, 0) - total) > 0.011) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_PRICE_MISMATCH");
  }
  if (availability.available !== true || money(availability.available_count, "COUNT") < 1) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_UNAVAILABLE");
  }
  return {
    ...group, deposit_amount: 0, public_price: total / days, price_is_total: true,
    public_price_total: total, quote_reference: reference, quote_expires_at: expires,
    location_external_ids: [...new Set([window.pickup_location_id, window.dropoff_location_id])],
    provider_quote_data: {
      kayfleet: true, quote: q, availability: {
        available_count: availability.available_count,
        rental_total: availability.rental_total,
      }, pickup_location: window.pickup_location_id,
      dropoff_location: window.dropoff_location_id,
      ...datetimes(window),
    },
  };
}
export async function kayfleetLocations(credentials: PartnerApiCredentials): Promise<ApiLocation[]> {
  const data = await partnerApiRequest<unknown>(credentials, "/api/partner/locations", { method: "GET" });
  return normalizeKayFleetLocations(data);
}
export async function kayfleetGroups(credentials: PartnerApiCredentials): Promise<ApiVehicleGroup[]> {
  const data = await partnerApiRequest<unknown>(credentials, "/api/partner/vehicle-groups", { method: "GET" });
  return normalizeKayFleetGroups(data);
}
export async function kayfleetSearch(
  credentials: PartnerApiCredentials, window: Window,
): Promise<ApiVehicleGroup[]> {
  if (window.currency && window.currency.toUpperCase() !== "EUR") {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_CURRENCY");
  }
  const dates = datetimes(window);
  const [available, metadata] = await Promise.all([
    partnerApiRequest<unknown>(credentials,
      "/api/partner/availability?" + new URLSearchParams(dates).toString(), { method: "GET" }),
    kayfleetGroups(credentials),
  ]);
  const byId = new Map(metadata.map((g) => [g.external_id, g]));
  const matching = rows(available, "vehicle_groups").filter((x) => x.available === true
    && typeof x.available_count === "number" && x.available_count > 0);
  const results: ApiVehicleGroup[] = [];
  for (const row of matching.slice(0, 30)) {
    const id = txt(row.group_id);
    const group = byId.get(id);
    if (!group) continue;
    const params = new URLSearchParams({
      ...dates, group_id: id, pickup_location: window.pickup_location_id,
      dropoff_location: window.dropoff_location_id, full_insurance: "true",
    });
    const q = await partnerApiRequest<unknown>(
      credentials, "/api/partner/quote?" + params.toString(), { method: "GET" },
    );
    try { results.push(normalizeKayFleetQuote(group, row, q, window)); }
    catch { /* A group's unsafe/expired quote must not become an offer. */ }
  }
  return results;
}
export async function kayfleetBookingStatus(
  credentials: PartnerApiCredentials, reference: string,
): Promise<Record<string, unknown>> {
  if (!reference || reference.length > 200) throw new Error("PARTNER_API_ERROR:KAYFLEET_REFERENCE");
  const payload = await partnerApiRequest<unknown>(
    credentials, "/api/partner/bookings/" + encodeURIComponent(reference), { method: "GET" });
  const status = txt(obj(payload).status).toLowerCase();
  const resolved = status === "denied" ? "rejected"
    : status === "cancelled" ? "cancelled"
    : status === "confirmed" ? "confirmed" : "pending";
  if (!["pending", "confirmed", "denied", "active", "completed", "cancelled", "overdue"].includes(status)) {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_INVALID_STATUS");
  }
  return { booking_reference: reference, reference, status: resolved,
    definitive_rejection: status === "denied",
    // The v1 document does not specify the priced status payload. Do not
    // authorize a paid voucher until this is validated on a sandbox.
    // Full insurance, zero excess and zero deposit MUST match the signed B2B terms.
    liability_verified: status === "confirmed" && obj(payload).full_insurance === true
      && obj(payload).insurance_excess === 0 && obj(payload).deposit_amount === 0,
    needs_manual_review: status === "confirmed" || ["active", "completed", "overdue"].includes(status),
    provider_payload: payload };
}
export async function kayfleetCancel(
  credentials: PartnerApiCredentials, reference: string, reason?: string,
): Promise<Record<string, unknown>> {
  if (!reference || reference.length > 200) throw new Error("PARTNER_API_ERROR:KAYFLEET_REFERENCE");
  const payload = await partnerApiRequest<unknown>(
    credentials, "/api/partner/bookings/" + encodeURIComponent(reference) + "/cancel",
    { method: "POST", body: reason ? { reason: reason.slice(0, 250) } : {} },
  );
  if (txt(obj(payload).status).toLowerCase() !== "cancelled") {
    throw new Error("PARTNER_API_ERROR:KAYFLEET_CANCEL_NOT_CONFIRMED");
  }
  return { booking_reference: reference, reference, status: "cancelled", provider_payload: payload };
}
export async function kayfleetCreateBooking(): Promise<never> {
  // Never create a paid booking before binding quote_reference to POST /bookings,
  // confirming full insurance/deposit and testing the booking status response.
  throw new Error("PARTNER_API_ERROR:KAYFLEET_BOOKING_NOT_CERTIFIED");
}
