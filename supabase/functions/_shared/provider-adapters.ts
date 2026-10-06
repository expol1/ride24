import {
  endpointFor,
  normalizeGroups,
  normalizeLocations,
  partnerApiFormRequest,
  partnerApiRequest,
  sanitizePartnerPayload,
  type ApiLocation,
  type ApiVehicleGroup,
  type PartnerApiCredentials,
} from "./partner-api.ts";
import { serviceClient } from "./ride24-security.ts";

export type ProviderKey =
  | "ride24_standard_v1"
  | "custom"
  | "renteon"
  | "easy_web_rent";

export type ProviderSearchInput = {
  pickup_location_id: string;
  dropoff_location_id: string;
  pickup_location?: string | null;
  dropoff_location?: string | null;
  pickup_date: string;
  return_date: string;
  pickup_time?: string | null;
  return_time?: string | null;
  currency?: string | null;
};

export type ProviderBookingInput = {
  idempotency_key: string;
  ride24_booking_id: string;
  reservation_code?: string | null;
  vehicle_group_id: string | null;
  class_code?: string | null;
  pickup_location_id?: string | null;
  dropoff_location_id?: string | null;
  pickup_date: string;
  return_date: string;
  pickup_time?: string | null;
  return_time?: string | null;
  pickup_location?: string | null;
  return_location?: string | null;
  main_driver?: {
    name?: string | null;
    age?: number | null;
  } | null;
  additional_driver?: {
    name?: string | null;
    age?: number | null;
  } | null;
  client_email?: string | null;
  client_phone?: string | null;
  currency?: string | null;
  partner_amount?: number | null;
  customer_total?: number | null;
  quote_reference?: string | null;
  response_deadline?: string | null;
  provider_quote_data?: unknown;
};

type RenteonToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

const renteonTokenCache = new Map<string, RenteonToken>();

type ProviderEndpointName =
  | "auth"
  | "health"
  | "locations"
  | "groups"
  | "search"
  | "booking_create"
  | "booking_save"
  | "booking_status"
  | "booking_cancel";

const PROVIDER_DEFAULT_ENDPOINTS: Partial<
  Record<ProviderKey, Partial<Record<ProviderEndpointName, string>>>
> = {
  renteon: {
    auth: "/token",
    health: "/api/offices",
    locations: "/api/offices",
    groups: "/api/ExCarCategory/Search",
    search: "/api/ExBooking/Availability",
    booking_create: "/api/ExBooking/Create",
    booking_save: "/api/ExBooking/Save",
    booking_status: "/api/ExBooking/{id}",
    booking_cancel: "/api/ExBooking/Cancel/{id}",
  },
  easy_web_rent: {
    health: "/api/v1/locations",
    locations: "/api/v1/locations",
    groups: "/api/v1/vehicle-classes",
    search: "/api/v1/availability",
    booking_create: "/api/v1/reservations",
    booking_status: "/api/v1/reservations/{id}",
    booking_cancel: "/api/v1/reservations/{id}/cancel",
  },
};

function providerEndpoint(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
  name: ProviderEndpointName,
  variables: Record<string, string> = {},
): string {
  const provider = safeProvider(providerValue);
  const configured = credentials.endpoints?.[name];
  const fallback = PROVIDER_DEFAULT_ENDPOINTS[provider]?.[name];

  if (typeof configured === "string" && configured.trim()) {
    return endpointFor(credentials, name, variables);
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return endpointFor(
      {
        ...credentials,
        endpoints: {
          ...(credentials.endpoints || {}),
          [name]: fallback,
        },
      },
      name,
      variables,
    );
  }
  return endpointFor(credentials, name, variables);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

function arrayFrom(value: unknown, keys: string[] = []): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) {
      for (const nested of ["data", "items", "results"]) {
        if (Array.isArray(candidate[nested])) return candidate[nested] as unknown[];
      }
    }
  }
  return [];
}

function cleanText(value: unknown, max = 500): string | null {
  if (value == null) return null;
  if (!["string", "number", "bigint"].includes(typeof value)) return null;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text || null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeCurrency(value: unknown): string | null {
  const raw = String(value || "").trim().toUpperCase();
  const currency = raw === "TRL" ? "TRY" : raw;
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function safeProvider(provider: unknown): ProviderKey {
  const key = String(provider || "custom").trim().toLowerCase();
  return ["ride24_standard_v1", "custom", "renteon", "easy_web_rent"].includes(key)
    ? key as ProviderKey
    : "custom";
}

export function providerKey(value: unknown): ProviderKey {
  return safeProvider(value);
}

function withSeconds(value: string | null | undefined, fallback = "10:00"): string {
  const raw = String(value || fallback).trim();
  if (/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw)) return raw;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) return `${raw}:00`;
  return `${fallback}:00`;
}

function localDateTime(date: string, time?: string | null): string {
  return `${date}T${withSeconds(time)}`;
}

function ride24Days(start: string, end: string): number {
  const startTs = Date.parse(`${start}T00:00:00.000Z`);
  const endTs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return 1;
  return Math.max(1, Math.round((endTs - startTs) / 86_400_000));
}

function sameOriginAbsolute(credentials: PartnerApiCredentials, value: unknown): string | null {
  const raw = cleanText(value, 2_000);
  if (!raw) return null;
  try {
    const base = new URL(credentials.api_url.endsWith("/") ? credentials.api_url : `${credentials.api_url}/`);
    const resolved = new URL(raw, base);
    if (resolved.protocol !== "https:" || resolved.origin !== base.origin) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function countryNameFromCode(value: unknown): string {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return cleanText(value, 100) || "";
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    return display.of(code) || code;
  } catch {
    return code;
  }
}

function classLetter(value: unknown, fallback: unknown = "A"): string {
  const primary = cleanText(value, 20)?.toUpperCase() || "";
  const fallbackText = cleanText(fallback, 20)?.toUpperCase() || "A";
  const match = (primary || fallbackText).match(/[A-Z]/);
  return match?.[0] || "A";
}

function splitName(value: unknown): { name: string; surname: string } {
  const full = cleanText(value, 250) || "Ride24 Customer";
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { name: parts[0], surname: "" };
  return {
    name: parts.slice(0, -1).join(" ").slice(0, 120),
    surname: parts.at(-1)!.slice(0, 120),
  };
}

function canonicalStatus(value: unknown): "pending" | "confirmed" | "rejected" | "cancelled" {
  const status = String(value || "").trim().toLowerCase();
  if (["confirmed", "accepted", "approved", "reserved", "active", "booked", "ok"].includes(status)) {
    return "confirmed";
  }
  if (["cancelled", "canceled", "void"].includes(status)) return "cancelled";
  if (["rejected", "declined", "unavailable", "failed"].includes(status)) return "rejected";
  return "pending";
}

function canonicalGenericBooking(value: unknown): Record<string, unknown> {
  const row = firstRecord(value) || {};
  const nested = firstRecord(row.data) || firstRecord(row.reservation) || row;
  const reference = cleanText(
    nested.booking_reference
      ?? nested.reservation_reference
      ?? nested.reservation_id
      ?? nested.reference
      ?? nested.number
      ?? nested.id,
    500,
  );
  return {
    booking_reference: reference,
    reference,
    id: reference,
    status: canonicalStatus(nested.status),
    provider_payload: sanitizePartnerPayload(value, 12_000),
  };
}

function renteonCacheKey(credentials: PartnerApiCredentials): string {
  return [
    credentials.partner_id,
    credentials.api_url,
    credentials.username || "",
    credentials.api_key || "",
  ].join("|");
}

function persistedRenteonToken(
  credentials: PartnerApiCredentials,
): RenteonToken | null {
  const accessToken = cleanText(credentials.runtime_access_token, 12_000);
  const expiresAt = credentials.runtime_token_expires_at
    ? Date.parse(credentials.runtime_token_expires_at)
    : Number.NaN;

  if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
    return null;
  }

  return {
    accessToken,
    refreshToken: cleanText(credentials.runtime_refresh_token, 12_000),
    expiresAt,
  };
}

async function persistRenteonToken(
  credentials: PartnerApiCredentials,
  token: RenteonToken,
): Promise<void> {
  try {
    const admin = serviceClient();
    const { error } = await admin
      .from("partner_api_credentials")
      .update({
        runtime_access_token: token.accessToken,
        runtime_refresh_token: token.refreshToken,
        runtime_token_expires_at: new Date(token.expiresAt).toISOString(),
      })
      .eq("partner_id", credentials.partner_id);

    if (error) console.error("renteon runtime token cache write failed");
  } catch {
    // Runtime token persistence is an optimization. In-memory cache remains valid.
    console.error("renteon runtime token cache write failed");
  }
}

async function sha512Base64(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
  let binary = "";
  for (let offset = 0; offset < digest.length; offset += 0x8000) {
    binary += String.fromCharCode(...digest.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renteonCredentials(credentials: PartnerApiCredentials): {
  username: string;
  password: string;
  clientId: string;
  secret: string;
} {
  const username = cleanText(credentials.username, 500);
  const password = cleanText(credentials.password, 4_000);
  const clientId = cleanText(credentials.api_key, 4_000);
  const secret = cleanText(credentials.api_secret, 4_000);
  if (!username || !password || !clientId || !secret) {
    throw new Error("PARTNER_API_ERROR:RENTEON_CREDENTIALS_MISSING");
  }
  return { username, password, clientId, secret };
}

async function requestRenteonToken(
  credentials: PartnerApiCredentials,
  refreshToken?: string | null,
): Promise<RenteonToken> {
  const { username, password, clientId, secret } = renteonCredentials(credentials);
  let response: Record<string, unknown>;

  if (refreshToken) {
    try {
      response = await partnerApiFormRequest<Record<string, unknown>>(
        credentials,
        providerEndpoint("renteon", credentials, "auth"),
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        },
      );
    } catch {
      response = {};
    }
    const refreshed = cleanText(response.access_token, 12_000);
    if (refreshed) {
      const expiresIn = Math.max(120, Number(response.expires_in) || 3_600);
      return {
        accessToken: refreshed,
        refreshToken: cleanText(response.refresh_token, 12_000) || refreshToken || null,
        expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1_000,
      };
    }
  }

  const salt = randomSalt();
  const composite = `${username}${salt}${secret}${password}${salt}${secret}${clientId}`;
  const signature = await sha512Base64(composite);

  response = await partnerApiFormRequest<Record<string, unknown>>(
    credentials,
    providerEndpoint("renteon", credentials, "auth"),
    {
      grant_type: "password",
      username,
      password,
      client_id: clientId,
      signature,
      salt,
    },
  );

  const accessToken = cleanText(response.access_token, 12_000);
  if (!accessToken) throw new Error("PARTNER_API_ERROR:RENTEON_AUTH_FAILED");
  const expiresIn = Math.max(120, Number(response.expires_in) || 3_600);

  return {
    accessToken,
    refreshToken: cleanText(response.refresh_token, 12_000),
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1_000,
  };
}

async function renteonAccessToken(credentials: PartnerApiCredentials): Promise<string> {
  const key = renteonCacheKey(credentials);
  const memoryToken = renteonTokenCache.get(key);
  const persistedToken = persistedRenteonToken(credentials);
  const cached = memoryToken && memoryToken.expiresAt > Date.now() + 30_000
    ? memoryToken
    : persistedToken;

  if (cached && cached.expiresAt > Date.now() + 30_000) {
    renteonTokenCache.set(key, cached);
    return cached.accessToken;
  }

  const refreshToken = memoryToken?.refreshToken
    || cleanText(credentials.runtime_refresh_token, 12_000)
    || null;
  const next = await requestRenteonToken(credentials, refreshToken);
  renteonTokenCache.set(key, next);
  await persistRenteonToken(credentials, next);
  return next.accessToken;
}

async function renteonRequest<T>(
  credentials: PartnerApiCredentials,
  endpoint: keyof NonNullable<PartnerApiCredentials["endpoints"]> | string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  let token = await renteonAccessToken(credentials);
  const tokenCredentials: PartnerApiCredentials = {
    ...credentials,
    auth_type: "bearer",
    bearer_token: token,
  };

  try {
    return await partnerApiRequest<T>(tokenCredentials, path, options);
  } catch (error) {
    if (error instanceof Error && error.message === "PARTNER_API_ERROR:HTTP:401") {
      renteonTokenCache.delete(renteonCacheKey(credentials));
      token = await renteonAccessToken(credentials);
      return await partnerApiRequest<T>(
        { ...credentials, auth_type: "bearer", bearer_token: token },
        path,
        options,
      );
    }
    throw error;
  }
}

export function normalizeRenteonLocations(
  credentials: PartnerApiCredentials,
  payload: unknown,
): ApiLocation[] {
  const source = arrayFrom(payload, ["offices", "Offices", "data", "items", "results"]);
  const output: ApiLocation[] = [];

  for (const raw of source.slice(0, 10_000)) {
    if (!isRecord(raw)) continue;
    const id = cleanText(raw.Id ?? raw.id, 200);
    const name = cleanText(raw.Name ?? raw.name, 250);
    const town = cleanText(raw.Town ?? raw.city, 150);
    if (!id || !name) continue;

    const country = countryNameFromCode(raw.CountryCode ?? raw.country_code ?? raw.country);
    const lowerName = name.toLowerCase();
    output.push({
      external_id: id,
      country: country || cleanText(raw.CountryCode, 100) || "Unknown",
      region: town || country || "Unknown",
      city: town,
      location_name: name,
      type: lowerName.includes("airport") ? "airport" : "city",
      extra_fee: false,
      extra_fee_amount: null,
      contact_required: false,
      active: true,
    });
  }

  return output;
}

export function normalizeRenteonGroups(
  credentials: PartnerApiCredentials,
  payload: unknown,
): ApiVehicleGroup[] {
  const source = arrayFrom(payload, [
    "carCategories",
    "CarCategories",
    "categories",
    "data",
    "items",
    "results",
  ]);

  const output: ApiVehicleGroup[] = [];
  for (const raw of source.slice(0, 10_000)) {
    if (!isRecord(raw)) continue;
    const id = cleanText(raw.Id ?? raw.CarCategoryId ?? raw.id, 200);
    if (!id) continue;

    const sipp = cleanText(raw.SIPP ?? raw.sipp, 20);
    const model = cleanText(raw.CarModel ?? raw.ModelName ?? raw.model, 250);
    const title = cleanText(raw.Title ?? raw.Name ?? raw.title, 250);
    const transmissionRecord = firstRecord(raw.CarTransmissionType);
    const fuelTypes = Array.isArray(raw.FuelTypes) ? raw.FuelTypes : [];
    const firstFuel = firstRecord(fuelTypes[0]);
    const bigBags = Math.max(0, Number(raw.BigBagsCapacity) || 0);
    const smallBags = Math.max(0, Number(raw.SmallBagsCapacity) || 0);

    output.push({
      external_id: id,
      class_code: classLetter(sipp, raw.CarCategoryGroup ?? title),
      public_price: 0,
      currency: null,
      example_model: model || title,
      model: model || title,
      transmission: cleanText(transmissionRecord?.Name ?? raw.Transmission, 50),
      fuel_type: cleanText(firstFuel?.Name ?? raw.FuelType, 50),
      seats: positiveInteger(raw.PassengerCapacity),
      bags: Math.round(bigBags + smallBags),
      image: sameOriginAbsolute(credentials, raw.CarModelImageURL ?? raw.ImageURL),
      description: title || model || sipp || `Renteon category ${id}`,
      features: {
        provider: "renteon",
        sipp,
        renteon_category_id: id,
        air_conditioning: raw.AirConditioning === true,
        number_of_doors: finiteNumber(raw.NumberOfDoors),
      },
      mileage_limit: null,
      deposit_amount: finiteNumber(raw.DepositAmount),
      driver_included: false,
      active: raw.ShowInList !== false && raw.Active !== false,
      location_external_ids: null,
      seasonal_prices: null,
    });
  }
  return output;
}

export function normalizeRenteonAvailability(
  credentials: PartnerApiCredentials,
  payload: unknown,
  input: ProviderSearchInput,
): ApiVehicleGroup[] {
  let source: unknown[] = [];
  if (Array.isArray(payload)) {
    source = payload.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (Array.isArray(entry.AvailabilityCarCategories)) {
        return entry.AvailabilityCarCategories;
      }
      if (Array.isArray(entry.availabilityCarCategories)) {
        return entry.availabilityCarCategories;
      }
      return [entry];
    });
  } else {
    source = arrayFrom(payload, [
      "AvailabilityCarCategories",
      "availabilityCarCategories",
      "data",
      "items",
      "results",
    ]);
  }

  const days = ride24Days(input.pickup_date, input.return_date);
  const output: ApiVehicleGroup[] = [];

  for (const raw of source.slice(0, 10_000)) {
    if (!isRecord(raw)) continue;
    const categoryId = cleanText(raw.CarCategoryId ?? raw.Id ?? raw.id, 200);
    const total = positiveNumber(raw.Amount ?? raw.TotalAmount ?? raw.Total ?? raw.Price);
    if (!categoryId || total === null) continue;

    const currency = normalizeCurrency(raw.Currency ?? input.currency);
    const sipp = cleanText(raw.SIPP, 20);
    const model = cleanText(raw.ModelName ?? raw.CarModel, 250);
    const priceDate = cleanText(raw.PriceDate, 80);
    const priceDateTs = priceDate ? Date.parse(priceDate) : Number.NaN;
    const quoteExpiry = Number.isFinite(priceDateTs)
      ? new Date(priceDateTs + 60 * 60 * 1_000).toISOString()
      : null;
    const bigBags = Math.max(0, Number(raw.BigBagsCapacity) || 0);
    const smallBags = Math.max(0, Number(raw.SmallBagsCapacity) || 0);

    output.push({
      external_id: categoryId,
      class_code: classLetter(sipp, raw.CarCategoryGroup),
      public_price: Number((total / days).toFixed(6)),
      currency,
      example_model: model,
      model,
      transmission: cleanText(raw.Transmission ?? raw.CarTransmissionType, 50),
      fuel_type: cleanText(raw.FuelType, 50),
      seats: positiveInteger(raw.PassengerCapacity),
      bags: Math.round(bigBags + smallBags),
      image: sameOriginAbsolute(credentials, raw.CarModelImageURL ?? raw.ImageURL),
      description: model || sipp || `Renteon category ${categoryId}`,
      features: {
        provider: "renteon",
        sipp,
        car_category_group: cleanText(raw.CarCategoryGroup, 100),
        minimum_driver_age: finiteNumber(raw.MinimumDriverAge),
        maximum_driver_age: finiteNumber(raw.MaximumDriverAge),
        excess_amount: finiteNumber(raw.ExcessAmount),
        included_services: sanitizePartnerPayload(raw.IncludedServices ?? [], 3_000),
      },
      mileage_limit: null,
      deposit_amount: finiteNumber(raw.DepositAmount),
      driver_included: false,
      active: raw.AvailableCount === undefined
        ? true
        : Number(raw.AvailableCount) > 0,
      location_external_ids: [
        input.pickup_location_id,
        input.dropoff_location_id,
      ].filter(Boolean),
      quote_reference: [
        categoryId,
        cleanText(raw.PricelistId, 100) || "",
        priceDate || "",
      ].join(":").slice(0, 500),
      quote_expires_at: quoteExpiry,
      seasonal_prices: null,
      price_is_total: true,
      public_price_total: total,
      provider_quote_data: {
        provider: "renteon",
        pricelist_id: finiteNumber(raw.PricelistId),
        price_date: priceDate,
        service_id: finiteNumber(raw.ServiceId),
        is_on_request: raw.IsOnRequest === true,
        total_amount: total,
        car_rental_amount: finiteNumber(raw.CarRentalAmount),
        original_amount: finiteNumber(raw.OriginalAmount),
        availability_car_category: sanitizePartnerPayload(raw, 60_000),
      },
    });
  }

  return output;
}

function normalizeEasyWebRentLocations(payload: unknown): ApiLocation[] {
  const source = arrayFrom(payload, ["locations", "data", "items", "results"]);
  return source.slice(0, 10_000).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = cleanText(raw.id ?? raw.location_id ?? raw.external_id, 200);
    const name = cleanText(raw.name ?? raw.location_name ?? raw.title, 250);
    if (!id || !name) return [];
    const country = cleanText(
      raw.country_name ?? raw.country ?? raw.country_code,
      100,
    ) || "Unknown";
    const city = cleanText(raw.city ?? raw.town, 150);
    return [{
      external_id: id,
      country: /^[A-Z]{2}$/.test(country) ? countryNameFromCode(country) : country,
      region: cleanText(raw.region ?? raw.state, 150) || city || country,
      city,
      location_name: name,
      type: cleanText(raw.type, 30)
        || (name.toLowerCase().includes("airport") ? "airport" : "city"),
      extra_fee: raw.extra_fee === true,
      extra_fee_amount: finiteNumber(raw.extra_fee_amount),
      contact_required: raw.contact_required === true,
      active: raw.active !== false,
    } satisfies ApiLocation];
  });
}

function normalizeEasyWebRentGroups(
  credentials: PartnerApiCredentials,
  payload: unknown,
): ApiVehicleGroup[] {
  const source = arrayFrom(payload, [
    "vehicle_classes",
    "classes",
    "groups",
    "data",
    "items",
    "results",
  ]);

  return source.slice(0, 10_000).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = cleanText(
      raw.id ?? raw.vehicle_class_id ?? raw.class_id ?? raw.external_id,
      200,
    );
    if (!id) return [];

    const sipp = cleanText(raw.sipp ?? raw.acriss_code ?? raw.class_code, 20);
    const model = cleanText(raw.example_model ?? raw.model ?? raw.name, 250);
    return [{
      external_id: id,
      class_code: classLetter(sipp, raw.category ?? raw.name),
      public_price: Math.max(0, Number(raw.public_price ?? raw.price ?? 0) || 0),
      currency: normalizeCurrency(raw.currency),
      example_model: model,
      model,
      transmission: cleanText(raw.transmission, 50),
      fuel_type: cleanText(raw.fuel_type ?? raw.fuel, 50),
      seats: positiveInteger(raw.seats ?? raw.passengers),
      bags: positiveInteger(raw.bags ?? raw.luggage) ?? 0,
      image: sameOriginAbsolute(credentials, raw.image ?? raw.image_url),
      description: cleanText(raw.description ?? raw.name, 2_000) || model || `Vehicle class ${id}`,
      features: {
        ...(isRecord(raw.features) ? raw.features : {}),
        provider: "easy_web_rent",
      },
      mileage_limit: finiteNumber(raw.mileage_limit),
      deposit_amount: finiteNumber(raw.deposit_amount ?? raw.deposit),
      driver_included: raw.driver_included === true,
      active: raw.active !== false,
      location_external_ids: Array.isArray(raw.location_ids)
        ? raw.location_ids.map((item) => String(item)).slice(0, 100)
        : null,
      seasonal_prices: null,
    } satisfies ApiVehicleGroup];
  });
}

function normalizeEasyWebRentAvailability(
  credentials: PartnerApiCredentials,
  payload: unknown,
  input: ProviderSearchInput,
): ApiVehicleGroup[] {
  const source = arrayFrom(payload, [
    "availability",
    "vehicle_classes",
    "offers",
    "quotes",
    "data",
    "items",
    "results",
  ]);
  const days = ride24Days(input.pickup_date, input.return_date);

  return source.slice(0, 10_000).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const group = firstRecord(raw.vehicle_class) || firstRecord(raw.class) || raw;
    const id = cleanText(
      group.id
        ?? raw.vehicle_class_id
        ?? raw.class_id
        ?? raw.group_id
        ?? raw.id,
      200,
    );
    if (!id) return [];

    const total = positiveNumber(
      raw.total_price
        ?? raw.total
        ?? raw.amount
        ?? firstRecord(raw.price)?.total
        ?? raw.price,
    );
    const perDay = positiveNumber(
      raw.price_per_day
        ?? raw.daily_price
        ?? firstRecord(raw.price)?.per_day,
    );
    const publicPrice = perDay || (total ? Number((total / days).toFixed(6)) : null);
    if (!publicPrice) return [];

    const currency = normalizeCurrency(
      raw.currency
        ?? firstRecord(raw.price)?.currency
        ?? input.currency,
    );
    const sipp = cleanText(group.sipp ?? group.acriss_code ?? group.class_code, 20);
    const model = cleanText(
      group.example_model ?? group.model ?? group.name,
      250,
    );

    return [{
      external_id: id,
      class_code: classLetter(sipp, group.category ?? group.name),
      public_price: publicPrice,
      currency,
      example_model: model,
      model,
      transmission: cleanText(group.transmission, 50),
      fuel_type: cleanText(group.fuel_type ?? group.fuel, 50),
      seats: positiveInteger(group.seats ?? group.passengers),
      bags: positiveInteger(group.bags ?? group.luggage) ?? 0,
      image: sameOriginAbsolute(credentials, group.image ?? group.image_url),
      description: cleanText(group.description ?? group.name, 2_000) || model || `Vehicle class ${id}`,
      features: {
        ...(isRecord(group.features) ? group.features : {}),
        provider: "easy_web_rent",
      },
      mileage_limit: finiteNumber(group.mileage_limit),
      deposit_amount: finiteNumber(raw.deposit_amount ?? group.deposit_amount),
      driver_included: group.driver_included === true,
      active: raw.available !== false && raw.active !== false,
      location_external_ids: [
        input.pickup_location_id,
        input.dropoff_location_id,
      ].filter(Boolean),
      quote_reference: cleanText(raw.quote_id ?? raw.reference, 500),
      quote_expires_at: cleanText(raw.expires_at ?? raw.quote_expires_at, 80),
      seasonal_prices: null,
      price_is_total: total !== null,
      public_price_total: total,
      provider_quote_data: {
        provider: "easy_web_rent",
        quote_id: cleanText(raw.quote_id ?? raw.reference, 500),
        raw_quote: sanitizePartnerPayload(raw.quote ?? raw, 20_000),
      },
    } satisfies ApiVehicleGroup];
  });
}

async function providerRequest<T>(
  provider: ProviderKey,
  credentials: PartnerApiCredentials,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  if (provider === "renteon") {
    return await renteonRequest<T>(credentials, "", path, options);
  }
  return await partnerApiRequest<T>(credentials, path, options);
}

export async function testProviderConnection(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
): Promise<void> {
  const provider = safeProvider(providerValue);
  if (provider === "renteon") {
    await renteonRequest(
      credentials,
      "locations",
      providerEndpoint(provider, credentials, "locations"),
    );
    return;
  }

  await partnerApiRequest(
    credentials,
    providerEndpoint(provider, credentials, "health"),
  );
}

export async function fetchProviderLocations(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
): Promise<ApiLocation[]> {
  const provider = safeProvider(providerValue);

  if (provider === "renteon") {
    const payload = await renteonRequest<unknown>(
      credentials,
      "locations",
      providerEndpoint(provider, credentials, "locations"),
    );
    return normalizeRenteonLocations(credentials, payload);
  }

  const payload = await partnerApiRequest<unknown>(
    credentials,
    providerEndpoint(provider, credentials, "locations"),
  );

  if (provider === "easy_web_rent") {
    return normalizeEasyWebRentLocations(payload);
  }
  return normalizeLocations(payload);
}

export async function fetchProviderGroups(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
): Promise<ApiVehicleGroup[]> {
  const provider = safeProvider(providerValue);

  if (provider === "renteon") {
    const payload = await renteonRequest<unknown>(
      credentials,
      "groups",
      providerEndpoint(provider, credentials, "groups"),
      { method: "POST", body: {} },
    );
    return normalizeRenteonGroups(credentials, payload);
  }

  const payload = await partnerApiRequest<unknown>(
    credentials,
    providerEndpoint(provider, credentials, "groups"),
  );
  if (provider === "easy_web_rent") {
    return normalizeEasyWebRentGroups(credentials, payload);
  }
  return normalizeGroups(payload);
}

export async function searchProvider(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
  input: ProviderSearchInput,
): Promise<ApiVehicleGroup[]> {
  const provider = safeProvider(providerValue);

  if (provider === "renteon") {
    const body: Record<string, unknown> = {
      BookAsCommissioner: true,
      OfficeOutId: positiveInteger(input.pickup_location_id),
      OfficeInId: positiveInteger(input.dropoff_location_id)
        ?? positiveInteger(input.pickup_location_id),
      DateTimeOut: localDateTime(input.pickup_date, input.pickup_time),
      DateTimeIn: localDateTime(input.return_date, input.return_time),
      AvailableOnly: true,
    };

    if (!body.OfficeOutId || !body.OfficeInId) {
      throw new Error("PARTNER_API_ERROR:RENTEON_LOCATION_MAPPING");
    }

    const payload = await renteonRequest<unknown>(
      credentials,
      "search",
      providerEndpoint(provider, credentials, "search"),
      { method: "POST", body },
    );
    return normalizeRenteonAvailability(credentials, payload, input);
  }

  if (provider === "easy_web_rent") {
    const query = new URLSearchParams({
      pickup_at: localDateTime(input.pickup_date, input.pickup_time),
      return_at: localDateTime(input.return_date, input.return_time),
      location_id: input.pickup_location_id,
    });
    if (input.dropoff_location_id) {
      query.set("return_location_id", input.dropoff_location_id);
    }

    let payload: unknown;
    try {
      payload = await partnerApiRequest<unknown>(
        credentials,
        `${providerEndpoint(provider, credentials, "search")}?${query.toString()}`,
        { method: "GET" },
      );
    } catch (error) {
      // Some Easy Web Rent installations expose availability as POST.
      payload = await partnerApiRequest<unknown>(
        credentials,
        providerEndpoint(provider, credentials, "search"),
        {
          method: "POST",
          body: {
            pickup_at: localDateTime(input.pickup_date, input.pickup_time),
            return_at: localDateTime(input.return_date, input.return_time),
            location_id: input.pickup_location_id,
            return_location_id: input.dropoff_location_id,
          },
        },
      );
    }
    return normalizeEasyWebRentAvailability(credentials, payload, input);
  }

  const payload = await partnerApiRequest<unknown>(
    credentials,
    providerEndpoint(provider, credentials, "search"),
    { method: "POST", body: input },
  );
  return normalizeGroups(payload);
}

function renteonProviderQuote(input: ProviderBookingInput): Record<string, unknown> {
  if (!isRecord(input.provider_quote_data)) return {};
  return input.provider_quote_data;
}

export async function createProviderBooking(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
  input: ProviderBookingInput,
): Promise<Record<string, unknown>> {
  const provider = safeProvider(providerValue);

  if (provider === "renteon") {
    const quote = renteonProviderQuote(input);
    const categoryId = positiveInteger(input.vehicle_group_id);
    const officeOutId = positiveInteger(input.pickup_location_id);
    const officeInId = positiveInteger(input.dropoff_location_id)
      ?? officeOutId;
    const availabilityCategory = isRecord(quote.availability_car_category)
      ? quote.availability_car_category
      : null;

    if (!categoryId || !officeOutId || !officeInId || !availabilityCategory) {
      throw new Error("PARTNER_API_ERROR:RENTEON_QUOTE_MAPPING");
    }

    const main = splitName(input.main_driver?.name);
    const createBody: Record<string, unknown> = {
      BookAsCommissioner: true,
      CarCategoryIds: [categoryId],
      OfficeOutId: officeOutId,
      OfficeInId: officeInId,
      DateTimeOut: localDateTime(input.pickup_date, input.pickup_time),
      DateTimeIn: localDateTime(input.return_date, input.return_time),
      AvailableOnly: true,
      AvailabilityCarCategory: availabilityCategory,
      Booking_Drivers: [{
        Name: main.name,
        Surname: main.surname,
        DriverAge: input.main_driver?.age ?? undefined,
      }],
    };

    const created = await renteonRequest<Record<string, unknown>>(
      credentials,
      "booking_create",
      providerEndpoint(provider, credentials, "booking_create"),
      { method: "POST", body: createBody },
    );

    const saveBody: Record<string, unknown> = {
      ...created,
      BookAsCommissioner: true,
      ClientName: cleanText(input.main_driver?.name, 250),
      ClientEmail: cleanText(input.client_email, 254),
      ClientPhone: cleanText(input.client_phone, 80),
      VoucherNumber: cleanText(input.reservation_code, 100),
      OrderReference: cleanText(input.reservation_code, 100),
      IntegrationRemark: `Ride24 ${cleanText(input.reservation_code, 100) || input.ride24_booking_id}`,
      PriceDate: cleanText(
        created.PriceDate ?? quote.price_date ?? availabilityCategory.PriceDate,
        80,
      ),
    };

    const saved = await renteonRequest<Record<string, unknown>>(
      credentials,
      "booking_save",
      providerEndpoint(provider, credentials, "booking_save"),
      { method: "POST", body: saveBody },
    );

    const reference = cleanText(saved.Number ?? saved.number ?? saved.Id ?? saved.id, 500);
    const status = saved.IsCancelled === true
      ? "rejected"
      : saved.IsOnRequest === true
      ? "pending"
      : "confirmed";

    return {
      booking_reference: reference,
      reference,
      id: reference,
      status,
      provider_payload: sanitizePartnerPayload(saved, 12_000),
    };
  }

  if (provider === "easy_web_rent") {
    const main = splitName(input.main_driver?.name);
    const payload = await partnerApiRequest<unknown>(
      credentials,
      providerEndpoint(provider, credentials, "booking_create"),
      {
        method: "POST",
        headers: {
          "Idempotency-Key": input.idempotency_key,
        },
        body: {
          idempotency_key: input.idempotency_key,
          pickup_location_id: input.pickup_location_id,
          return_location_id:
            input.dropoff_location_id || input.pickup_location_id,
          vehicle_class_id: input.vehicle_group_id,
          pickup_at: localDateTime(input.pickup_date, input.pickup_time),
          return_at: localDateTime(input.return_date, input.return_time),
          currency: input.currency,
          customer: {
            first_name: main.name,
            last_name: main.surname,
            email: input.client_email,
            phone: input.client_phone,
          },
          external_reference:
            input.reservation_code || input.ride24_booking_id,
          quote_reference: input.quote_reference,
        },
      },
    );
    return canonicalGenericBooking(payload);
  }

  const payload = await partnerApiRequest<unknown>(
    credentials,
    providerEndpoint(provider, credentials, "booking_create"),
    {
      method: "POST",
      headers: {
        "Idempotency-Key": input.idempotency_key,
      },
      body: input,
    },
  );
  return canonicalGenericBooking(payload);
}

export async function getProviderBookingStatus(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
  externalReference: string,
): Promise<Record<string, unknown>> {
  const provider = safeProvider(providerValue);

  if (provider === "renteon") {
    const payload = await renteonRequest<Record<string, unknown>>(
      credentials,
      "booking_status",
      providerEndpoint(provider, credentials, "booking_status", { id: externalReference }),
    );
    const status = payload.IsCancelled === true
      ? "cancelled"
      : payload.IsOnRequest === true
      ? "pending"
      : "confirmed";
    return {
      booking_reference: cleanText(payload.Number ?? externalReference, 500),
      reference: cleanText(payload.Number ?? externalReference, 500),
      status,
      provider_payload: sanitizePartnerPayload(payload, 12_000),
      confirmed_at: cleanText(payload.ModificationTime ?? payload.InitialBookingDate, 80),
    };
  }

  const payload = await partnerApiRequest<unknown>(
    credentials,
    providerEndpoint(provider, credentials, "booking_status", { id: externalReference }),
  );
  return canonicalGenericBooking(payload);
}

export async function cancelProviderBooking(
  providerValue: unknown,
  credentials: PartnerApiCredentials,
  externalReference: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const provider = safeProvider(providerValue);

  if (provider === "renteon") {
    const payload = await renteonRequest<unknown>(
      credentials,
      "booking_cancel",
      providerEndpoint(provider, credentials, "booking_cancel", { id: externalReference }),
      { method: "DELETE" },
    );
    return {
      booking_reference: externalReference,
      reference: externalReference,
      status: "cancelled",
      provider_payload: sanitizePartnerPayload(payload, 12_000),
    };
  }

  const payload = await partnerApiRequest<unknown>(
    credentials,
    providerEndpoint(provider, credentials, "booking_cancel", { id: externalReference }),
    {
      method: "POST",
      headers: body.idempotency_key
        ? { "Idempotency-Key": String(body.idempotency_key) }
        : undefined,
      body,
    },
  );
  const canonical = canonicalGenericBooking(payload);
  return {
    ...canonical,
    status: canonical.status === "pending" ? "cancelled" : canonical.status,
  };
}
