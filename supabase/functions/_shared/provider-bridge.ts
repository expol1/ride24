import {
  assertSafeApiUrl,
  endpointFor,
  normalizeGroups,
  normalizeLocations,
  partnerApiRequest,
  type ApiLocation,
  type ApiVehicleGroup,
  type PartnerApiCredentials,
} from "./partner-api.ts";

export type Ride24ApiProvider =
  | "ride24_standard_v1"
  | "custom"
  | "renteon"
  | "easy_web_rent";

export type ProviderOperation =
  | "health"
  | "locations"
  | "groups"
  | "search"
  | "booking_create"
  | "booking_status"
  | "booking_cancel";

type RequestInput = {
  variables?: Record<string, string>;
  body?: Record<string, unknown>;
};

type RenteonToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

const renteonTokenCache = new Map<string, RenteonToken>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "items", "results", "locations", "offices", "groups", "vehicle_classes"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function text(value: unknown, max = 500): string | null {
  if (value == null || !["string", "number", "bigint"].includes(typeof value)) return null;
  const result = String(value).trim().slice(0, max);
  return result || null;
}

function number(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function integer(value: unknown): number | null {
  const result = Number(value);
  return Number.isInteger(result) ? result : null;
}

function bool(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function joinLocalDateTime(date: unknown, time: unknown): string {
  const d = text(date, 10);
  const t = text(time, 8) || "10:00";
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("PARTNER_API_ERROR:INVALID_DATE");
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(t)) throw new Error("PARTNER_API_ERROR:INVALID_TIME");
  return `${d}T${t.length === 5 ? `${t}:00` : t}`;
}

function rentalDays(body: Record<string, unknown>): number {
  const from = Date.parse(`${String(body.pickup_date || "")}T00:00:00Z`);
  const to = Date.parse(`${String(body.return_date || "")}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 1;
  return Math.max(1, Math.round((to - from) / 86_400_000));
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function renteonQuoteReference(item: Record<string, unknown>): string | null {
  const pricelistId = integer(item.PricelistId ?? item.pricelistId);
  const priceDate = text(item.PriceDate ?? item.priceDate, 80);
  if (!pricelistId && !priceDate) return null;
  return `renteon:${base64UrlEncode(JSON.stringify({ pricelistId, priceDate }))}`;
}

function parseRenteonQuoteReference(value: unknown): { pricelistId: number | null; priceDate: string | null } {
  const raw = text(value, 500);
  if (!raw?.startsWith("renteon:")) return { pricelistId: null, priceDate: null };
  try {
    const decoded = JSON.parse(base64UrlDecode(raw.slice("renteon:".length)));
    return {
      pricelistId: integer(decoded.pricelistId),
      priceDate: text(decoded.priceDate, 80),
    };
  } catch {
    return { pricelistId: null, priceDate: null };
  }
}

function splitPersonName(value: unknown): { name: string; surname: string } {
  const raw = text(value, 250) || "Ride24 Customer";
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { name: parts[0] || "Ride24", surname: "Customer" };
  return { name: parts.slice(0, -1).join(" "), surname: parts.at(-1)! };
}

function safeBase(credentials: PartnerApiCredentials): string {
  return assertSafeApiUrl(credentials.api_url);
}

function providerPath(credentials: PartnerApiCredentials, operation: ProviderOperation, fallback: string, variables: Record<string, string> = {}): string {
  const configured = credentials.endpoints?.[operation];
  let path = typeof configured === "string" && configured.trim() ? configured.trim() : fallback;
  for (const [key, value] of Object.entries(variables)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  if (/\{[^{}]+\}/.test(path)) throw new Error("PARTNER_API_ERROR:INVALID_ENDPOINT");
  return path;
}

function urlFor(credentials: PartnerApiCredentials, path: string): string {
  const base = new URL(safeBase(credentials).endsWith("/") ? safeBase(credentials) : `${safeBase(credentials)}/`);
  const resolved = new URL(path.replace(/^\//, ""), base);
  if (resolved.origin !== base.origin || resolved.protocol !== "https:") {
    throw new Error("PARTNER_API_ERROR:INVALID_ENDPOINT");
  }
  return resolved.toString();
}

async function sha512Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function renteonCacheKey(credentials: PartnerApiCredentials): string {
  return `${credentials.partner_id}|${credentials.api_url}|${credentials.username || ""}|${credentials.api_key || ""}`;
}

async function renteonToken(credentials: PartnerApiCredentials, force = false): Promise<string> {
  const cacheKey = renteonCacheKey(credentials);
  const cached = renteonTokenCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const username = text(credentials.username, 500);
  const password = text(credentials.password, 4000);
  const clientId = text(credentials.api_key, 4000);
  const secret = text(credentials.api_secret, 4000);
  if (!username || !password || !clientId || !secret) {
    throw new Error("PARTNER_API_ERROR:INVALID_CREDENTIALS");
  }

  const tokenUrl = urlFor(credentials, providerPath(credentials, "health", "/token").replace(/\/api\/ExSettings$/i, "/token"));
  const salt = randomSalt();
  const signature = await sha512Base64(`${username}${salt}${secret}${password}${salt}${secret}${clientId}`);
  const params = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    client_id: clientId,
    signature,
    salt,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
    redirect: "error",
  });

  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(`PARTNER_API_ERROR:AUTH:${response.status}`);
  }

  const expiresIn = Math.max(300, Number(payload.expires_in) || 3600);
  renteonTokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    refreshToken: text(payload.refresh_token, 4000),
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return payload.access_token;
}

async function renteonFetch(
  credentials: PartnerApiCredentials,
  path: string,
  options: { method?: string; body?: unknown } = {},
  retry401 = true,
): Promise<unknown> {
  const token = await renteonToken(credentials);
  const method = String(options.method || "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(urlFor(credentials, path), { method, headers, body, redirect: "error" });
  if (response.status === 401 && retry401) {
    await renteonToken(credentials, true);
    return renteonFetch(credentials, path, options, false);
  }
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = { message: raw.slice(0, 500) }; }
  }
  if (!response.ok) throw new Error(`PARTNER_API_ERROR:HTTP:${response.status}`);
  return payload;
}

function normalizeRenteonLocations(payload: unknown): ApiLocation[] {
  return asArray(payload).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.Id ?? raw.id ?? raw.Code ?? raw.CodeNumber, 200);
    const locationName = text(raw.Name ?? raw.Title ?? raw.OfficeName ?? raw.Code, 250);
    if (!id || !locationName) return [];
    const country = text(
      (isRecord(raw.Country) ? raw.Country.Name : null) ?? raw.CountryName ?? raw.Country ?? "Unknown",
      100,
    ) || "Unknown";
    const city = text(
      (isRecord(raw.City) ? raw.City.Name : null) ?? raw.CityName ?? raw.City ?? raw.Place,
      150,
    );
    const region = text(raw.Region ?? raw.RegionName ?? city ?? country, 150) || country;
    const typeRaw = String(raw.Type ?? raw.OfficeType ?? "").toLowerCase();
    const type = typeRaw.includes("airport") ? "airport" : "city";
    return [{
      external_id: id,
      country,
      region,
      city,
      location_name: locationName,
      type,
      active: raw.IsActive === false || raw.Active === false ? false : true,
      extra_fee: false,
      extra_fee_amount: null,
      contact_required: false,
    }];
  });
}

function normalizeRenteonGroups(payload: unknown): ApiVehicleGroup[] {
  return asArray(payload).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.Id ?? raw.id, 200);
    const sipp = (text(raw.SIPP ?? raw.Sipp, 20) || "").toUpperCase();
    const title = text(raw.Title ?? raw.Name ?? raw.CarModel, 250);
    if (!id) return [];
    return [{
      external_id: id,
      class_code: /^[A-Z]/.test(sipp) ? sipp[0] : "A",
      public_price: 0,
      currency: null,
      example_model: text(raw.CarModel ?? raw.ModelName ?? title, 250),
      model: text(raw.CarModel ?? raw.ModelName ?? title, 250),
      transmission: text(isRecord(raw.CarTransmissionType) ? raw.CarTransmissionType.Name : raw.Transmission, 50),
      fuel_type: null,
      seats: integer(raw.PassengerCapacity),
      bags: Math.max(0, (integer(raw.BigBagsCapacity) || 0) + (integer(raw.SmallBagsCapacity) || 0)),
      image: text(raw.CarModelImageURL ?? raw.ImageURL, 2000),
      description: title,
      features: { sipp: sipp || null, renteon_title: title },
      mileage_limit: null,
      deposit_amount: number(raw.DepositAmount),
      driver_included: false,
      active: raw.ShowInList === false || raw.Active === false ? false : true,
      location_external_ids: null,
      quote_reference: null,
      quote_expires_at: null,
      seasonal_prices: null,
    }];
  });
}

function normalizeRenteonAvailability(payload: unknown, body: Record<string, unknown>): unknown {
  const days = rentalDays(body);
  const locations = [text(body.pickup_location_id, 200), text(body.dropoff_location_id, 200)].filter(Boolean) as string[];
  const groups = asArray(payload).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.CarCategoryId ?? raw.carCategoryId, 200);
    const total = number(raw.Amount ?? raw.CarRentalAmount);
    if (!id || total === null || total <= 0) return [];
    const sipp = (text(raw.SIPP, 20) || "").toUpperCase();
    const includedServices = Array.isArray(raw.IncludedServices) ? raw.IncludedServices : [];
    const mandatoryFees = includedServices
      .filter(isRecord)
      .map((item) => ({
        name: text(item.Name ?? item.ServiceTypeName, 200),
        amount: number(item.AmountTotal),
        pay_on_arrival: item.PayOnArrival === true,
      }));
    return [{
      external_id: id,
      class_code: /^[A-Z]/.test(sipp) ? sipp[0] : "A",
      public_price: total / days,
      currency: text(raw.Currency, 10)?.toUpperCase() || null,
      example_model: text(raw.ModelName, 250),
      model: text(raw.ModelName, 250),
      transmission: null,
      fuel_type: null,
      seats: integer(raw.PassengerCapacity),
      bags: Math.max(0, (integer(raw.BigBagsCapacity) || 0) + (integer(raw.SmallBagsCapacity) || 0)),
      image: text(raw.CarModelImageURL, 2000),
      description: text(raw.CarCategoryGroup ?? raw.ModelName, 2000),
      features: {
        sipp: sipp || null,
        is_on_request: raw.IsOnRequest === true,
        excess_amount: number(raw.ExcessAmount),
        excess_theft_amount: number(raw.ExcessTheftAmount),
        included_services: mandatoryFees,
        provider_total_amount: total,
      },
      mileage_limit: null,
      deposit_amount: number(raw.DepositAmount),
      driver_included: false,
      active: true,
      location_external_ids: locations,
      quote_reference: renteonQuoteReference(raw),
      quote_expires_at: raw.PriceDate ? new Date(Date.parse(String(raw.PriceDate)) + 60 * 60 * 1000).toISOString() : null,
      seasonal_prices: null,
    }];
  });
  return { groups };
}

async function renteonRequest(
  credentials: PartnerApiCredentials,
  operation: ProviderOperation,
  input: RequestInput,
): Promise<unknown> {
  const body = input.body || {};
  if (operation === "health") {
    return renteonFetch(credentials, providerPath(credentials, operation, "/api/ExSettings"));
  }
  if (operation === "locations") {
    return renteonFetch(credentials, providerPath(credentials, operation, "/api/offices"));
  }
  if (operation === "groups") {
    return renteonFetch(credentials, providerPath(credentials, operation, "/api/ExCarCategory/Search"), { method: "POST", body: {} });
  }
  if (operation === "search") {
    const request = {
      BookAsCommissioner: true,
      OfficeOutId: integer(body.pickup_location_id),
      OfficeInId: integer(body.dropoff_location_id ?? body.pickup_location_id),
      DateOut: joinLocalDateTime(body.pickup_date, body.pickup_time),
      DateIn: joinLocalDateTime(body.return_date, body.return_time),
      Currency: text(body.currency, 10)?.toUpperCase() || undefined,
      AvailableOnly: true,
      Booking_Drivers: isRecord(body.main_driver)
        ? [{
          ...splitPersonName(body.main_driver.name),
          DriverAge: integer(body.main_driver.age) || undefined,
        }]
        : undefined,
    };
    if (!request.OfficeOutId || !request.OfficeInId) throw new Error("PARTNER_API_ERROR:INVALID_LOCATION_ID");
    const response = await renteonFetch(
      credentials,
      providerPath(credentials, operation, "/api/bookings/availability"),
      { method: "POST", body: request },
    );
    return normalizeRenteonAvailability(response, body);
  }
  if (operation === "booking_create") {
    const groupId = integer(body.vehicle_group_id);
    const officeOut = integer(body.pickup_location_id);
    const officeIn = integer(body.dropoff_location_id ?? body.pickup_location_id);
    if (!groupId || !officeOut || !officeIn) throw new Error("PARTNER_API_ERROR:INVALID_BOOKING_MAPPING");
    const quote = parseRenteonQuoteReference(body.quote_reference);
    const main = isRecord(body.main_driver) ? body.main_driver : {};
    const additional = isRecord(body.additional_driver) ? body.additional_driver : null;
    const drivers = [{
      ...splitPersonName(main.name),
      DriverAge: integer(main.age) || undefined,
    }];
    if (additional) {
      drivers.push({
        ...splitPersonName(additional.name),
        DriverAge: integer(additional.age) || undefined,
      });
    }
    const createBody: Record<string, unknown> = {
      BookAsCommissioner: true,
      CarCategoryId: groupId,
      OfficeOutId: officeOut,
      OfficeInId: officeIn,
      DateOut: joinLocalDateTime(body.pickup_date, body.pickup_time),
      DateIn: joinLocalDateTime(body.return_date, body.return_time),
      Currency: text(body.currency, 10)?.toUpperCase() || "EUR",
      PricelistId: quote.pricelistId || undefined,
      PriceDate: quote.priceDate || undefined,
      Booking_Drivers: drivers,
      VoucherNumber: text(body.reservation_code, 100) || undefined,
      OrderReference: text(body.ride24_booking_id, 100) || undefined,
    };
    const created = await renteonFetch(
      credentials,
      providerPath(credentials, operation, "/api/bookings/create"),
      { method: "POST", body: createBody },
    );
    if (!isRecord(created)) throw new Error("PARTNER_API_ERROR:INVALID_RESPONSE");
    const saveBody: Record<string, unknown> = {
      ...created,
      ClientName: text(body.client_name ?? main.name, 250) || undefined,
      ClientEmail: text(body.client_email, 254) || undefined,
      ClientPhone: text(body.client_phone, 80) || undefined,
      Remark: `Ride24 ${text(body.reservation_code, 100) || ""}`.trim(),
      VoucherNumber: text(body.reservation_code, 100) || created.VoucherNumber,
      OrderReference: text(body.ride24_booking_id, 100) || created.OrderReference,
    };
    const saved = await renteonFetch(
      credentials,
      providerPath(credentials, "booking_status", "/api/bookings/save"),
      { method: "POST", body: saveBody },
    );
    const row = isRecord(saved) ? saved : {};
    const ref = text(row.Number ?? row.BookingNumber ?? row.Id, 500);
    if (!ref) throw new Error("PARTNER_API_ERROR:INVALID_RESPONSE");
    return {
      booking_reference: ref,
      status: row.IsOnRequest === true ? "pending" : "confirmed",
      provider_response: saved,
    };
  }
  if (operation === "booking_status") {
    const id = text(input.variables?.id, 500);
    if (!id) throw new Error("PARTNER_API_ERROR:INVALID_REFERENCE");
    const response = await renteonFetch(
      credentials,
      providerPath(credentials, operation, "/api/bookings/{id}", { id }),
    );
    const row = isRecord(response) ? response : {};
    const cancelled = Boolean(row.CancellationDate ?? row.CancelledAt ?? row.IsCancelled === true);
    return {
      booking_reference: id,
      status: cancelled ? "cancelled" : row.IsOnRequest === true ? "pending" : "confirmed",
      provider_response: response,
    };
  }
  if (operation === "booking_cancel") {
    const id = text(input.variables?.id, 500);
    if (!id) throw new Error("PARTNER_API_ERROR:INVALID_REFERENCE");
    const response = await renteonFetch(
      credentials,
      providerPath(credentials, operation, "/api/bookings/cancel/{id}", { id }),
      { method: "DELETE" },
    );
    return { booking_reference: id, status: "cancelled", provider_response: response };
  }
  throw new Error("PARTNER_API_ERROR:UNSUPPORTED_OPERATION");
}

async function easyWebRentRequest(
  credentials: PartnerApiCredentials,
  operation: ProviderOperation,
  input: RequestInput,
): Promise<unknown> {
  const body = input.body || {};
  const variables = input.variables || {};
  const defaults: Record<ProviderOperation, string> = {
    health: "/api/v1/availability",
    locations: "/api/v1/locations",
    groups: "/api/v1/vehicle-classes",
    search: "/api/v1/availability",
    booking_create: "/api/v1/reservations",
    booking_status: "/api/v1/reservations/{id}",
    booking_cancel: "/api/v1/reservations/{id}/cancel",
  };
  const path = providerPath(credentials, operation, defaults[operation], variables);

  if (operation === "search") {
    return partnerApiRequest(credentials, path, {
      method: "POST",
      body: {
        pickup_at: joinLocalDateTime(body.pickup_date, body.pickup_time),
        return_at: joinLocalDateTime(body.return_date, body.return_time),
        pickup_location_id: body.pickup_location_id,
        return_location_id: body.dropoff_location_id ?? body.pickup_location_id,
        location_id: body.pickup_location_id,
      },
    });
  }

  if (operation === "booking_create") {
    return partnerApiRequest(credentials, path, {
      method: "POST",
      body: {
        idempotency_key: body.idempotency_key,
        pickup_location_id: body.pickup_location_id,
        return_location_id: body.dropoff_location_id ?? body.pickup_location_id,
        vehicle_class_id: body.vehicle_group_id,
        pickup_at: joinLocalDateTime(body.pickup_date, body.pickup_time),
        return_at: joinLocalDateTime(body.return_date, body.return_time),
        customer: {
          name: body.client_name ?? (isRecord(body.main_driver) ? body.main_driver.name : null),
          email: body.client_email,
          phone: body.client_phone,
        },
        reference: body.reservation_code,
      },
    });
  }

  if (operation === "booking_cancel") {
    return partnerApiRequest(credentials, path, { method: "POST", body: input.body || {} });
  }

  if (operation === "health") {
    return partnerApiRequest(credentials, path, {
      method: "POST",
      body: {
        pickup_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19),
        return_at: new Date(Date.now() + 172_800_000).toISOString().slice(0, 19),
      },
    });
  }

  return partnerApiRequest(credentials, path, operation === "groups" || operation === "locations" || operation === "booking_status"
    ? {}
    : { method: "POST", body: input.body || {} });
}

function normalizeEasyWebRentLocations(payload: unknown): ApiLocation[] {
  const generic = normalizeLocations(payload);
  if (generic.length) return generic;
  return asArray(payload).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.id ?? raw.location_id ?? raw.code, 200);
    const name = text(raw.name ?? raw.location_name ?? raw.title, 250);
    if (!id || !name) return [];
    const country = text(raw.country_name ?? raw.country ?? "Unknown", 100) || "Unknown";
    const city = text(raw.city_name ?? raw.city, 150);
    return [{
      external_id: id,
      country,
      region: text(raw.region ?? raw.state ?? city ?? country, 150) || country,
      city,
      location_name: name,
      type: String(raw.type || "").toLowerCase().includes("airport") ? "airport" : "city",
      active: raw.active === false ? false : true,
      extra_fee: false,
      extra_fee_amount: null,
      contact_required: false,
    }];
  });
}

function normalizeEasyWebRentGroups(payload: unknown): ApiVehicleGroup[] {
  const generic = normalizeGroups(payload);
  if (generic.length) return generic;
  return asArray(payload).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.id ?? raw.vehicle_class_id ?? raw.class_id, 200);
    if (!id) return [];
    const code = (text(raw.sipp ?? raw.class_code ?? raw.code, 20) || "A").toUpperCase();
    return [{
      external_id: id,
      class_code: /^[A-Z]/.test(code) ? code[0] : "A",
      public_price: Math.max(0, number(raw.price_per_day ?? raw.daily_rate ?? raw.price) || 0),
      currency: text(raw.currency, 10)?.toUpperCase() || null,
      example_model: text(raw.example_model ?? raw.model ?? raw.name, 250),
      model: text(raw.model ?? raw.example_model ?? raw.name, 250),
      transmission: text(raw.transmission, 50),
      fuel_type: text(raw.fuel_type ?? raw.fuel, 50),
      seats: integer(raw.seats),
      bags: integer(raw.bags),
      image: text(raw.image ?? raw.image_url, 2000),
      description: text(raw.description ?? raw.name, 2000),
      features: isRecord(raw.features) ? raw.features : {},
      mileage_limit: number(raw.mileage_limit),
      deposit_amount: number(raw.deposit_amount ?? raw.deposit),
      driver_included: raw.driver_included === true,
      active: raw.active === false ? false : true,
      location_external_ids: Array.isArray(raw.location_ids) ? raw.location_ids.map((x) => String(x)) : null,
      quote_reference: text(raw.quote_reference ?? raw.quote_id, 500),
      quote_expires_at: text(raw.quote_expires_at ?? raw.expires_at, 80),
      seasonal_prices: null,
    }];
  });
}

export async function providerRequest<T = unknown>(
  provider: string | null | undefined,
  credentials: PartnerApiCredentials,
  operation: ProviderOperation,
  input: RequestInput = {},
): Promise<T> {
  const normalized = String(provider || "custom").toLowerCase();
  if (normalized === "renteon") {
    return await renteonRequest(credentials, operation, input) as T;
  }
  if (normalized === "easy_web_rent") {
    return await easyWebRentRequest(credentials, operation, input) as T;
  }

  const path = endpointFor(credentials, operation, input.variables || {});
  const method = operation === "booking_create" || operation === "booking_cancel" || operation === "search"
    ? "POST"
    : "GET";
  return await partnerApiRequest<T>(credentials, path, {
    method,
    body: method === "GET" ? undefined : input.body,
  });
}

export function normalizeProviderLocations(
  provider: string | null | undefined,
  payload: unknown,
): ApiLocation[] {
  const normalized = String(provider || "custom").toLowerCase();
  if (normalized === "renteon") return normalizeRenteonLocations(payload);
  if (normalized === "easy_web_rent") return normalizeEasyWebRentLocations(payload);
  return normalizeLocations(payload);
}

export function normalizeProviderGroups(
  provider: string | null | undefined,
  payload: unknown,
): ApiVehicleGroup[] {
  const normalized = String(provider || "custom").toLowerCase();
  if (normalized === "renteon") return normalizeRenteonGroups(payload);
  if (normalized === "easy_web_rent") return normalizeEasyWebRentGroups(payload);
  return normalizeGroups(payload);
}
