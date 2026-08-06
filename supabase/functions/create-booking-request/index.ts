import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authenticatedUser,
  corsHeaders,
  enforceRateLimit,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  serviceClient,
} from "../_shared/ride24-security.ts";

type AdminClient = ReturnType<typeof serviceClient>;

type BookingBody = {
  car_class_id?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  pickup_time?: unknown;
  return_time?: unknown;
  driver_id?: unknown;
  additional_driver_id?: unknown;
  pickup_location?: unknown;
  return_location?: unknown;
  terms_accepted?: unknown;
  api_quote_id?: unknown;
};

type PartnerRelation = {
  id: string;
  active: boolean;
  account_status: string | null;
  currency: string | null;
  email: string | null;
  provider_type: "local" | "api";
  api_enabled: boolean;
  rental_terms_url: string | null;
  rental_rules_url: string | null;
};

type CarRow = {
  id: string;
  partner_id: string;
  active: boolean;
  public_price: number | string | null;
  partner_discount_percent: number | string | null;
  partner_net_price: number | string | null;
  platform_margin_percent: number | string | null;
  final_customer_price: number | string | null;
  deposit_amount: number | string | null;
  mileage_limit: number | string | null;
  driver_included: boolean | null;
  features: Record<string, unknown>;
  partner: PartnerRelation;
};

type QuoteRow = {
  id: string;
  partner_id: string;
  car_class_id: string;
  external_group_id: string;
  pickup_location_external_id: string | null;
  dropoff_location_external_id: string | null;
  start_date: string;
  end_date: string;
  public_price_per_day: number | string;
  partner_discount_percent: number | string | null;
  platform_margin_percent: number | string | null;
  partner_net_total: number | string;
  commission_total: number | string;
  final_total: number | string;
  currency: string;
  expires_at: string;
};

type ClaimedQuote = {
  row: QuoteRow;
  claimedAt: string;
};

type LocationRow = {
  id: string;
  location_name: string | null;
};

const MAX_REQUEST_BYTES = 16_384;
const MAX_LOCATION_LENGTH = 250;
const MAX_DRIVER_NAME_LENGTH = 250;
const MAX_BOOKING_DAYS = 366;
const PARTNER_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RATE_LIMIT_REQUESTS = 12;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_TIME = "10:00";
const PLATFORM_TERMS_VERSION = "v1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

function cleanText(
  value: unknown,
  maxLength: number,
  fallback: string | null = null,
): string | null {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") return fallback;

  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedCurrency(value: unknown): string | null {
  const raw = String(value || "").trim().toUpperCase();
  const currency = raw === "TRL" ? "TRY" : raw;
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function safeCurrency(value: unknown): string {
  return normalizedCurrency(value) || "EUR";
}

function parseIsoDate(
  value: unknown,
): { text: string; timestamp: number } {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new Error("Nieprawidłowe dane rezerwacji");
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Nieprawidłowe dane rezerwacji");
  }

  if (new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Nieprawidłowe dane rezerwacji");
  }

  return { text: value, timestamp };
}

function cleanTime(value: unknown): string {
  return typeof value === "string"
      && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
    ? value
    : DEFAULT_TIME;
}

async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new Error("Wymagane dane w formacie JSON");
  }

  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new Error("Nieprawidłowy rozmiar danych wejściowych");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new Error("Wymagane dane rezerwacji");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      totalBytes += value.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Nieprawidłowy rozmiar danych wejściowych");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Nieprawidłowy format JSON");
  }

  if (!isRecord(parsed)) throw new Error("Nieprawidłowe dane wejściowe");
  return parsed;
}

function normalizePartner(value: unknown): PartnerRelation | null {
  const row = firstRecord(value);
  if (
    !row
    || !isUuid(row.id)
    || !["local", "api"].includes(String(row.provider_type || "local"))
  ) {
    return null;
  }

  return {
    id: row.id,
    active: row.active === true,
    account_status: cleanText(row.account_status, 50),
    currency: cleanText(row.currency, 10),
    email: cleanText(row.email, 254),
    provider_type: String(row.provider_type || "local") as "local" | "api",
    api_enabled: row.api_enabled === true,
    rental_terms_url: cleanText(row.rental_terms_url, 2_000),
    rental_rules_url: cleanText(row.rental_rules_url, 2_000),
  };
}

function normalizeCar(value: unknown): CarRow | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.partner_id)
  ) {
    return null;
  }

  const partner = normalizePartner(value.partners);
  if (!partner || partner.id !== value.partner_id) return null;

  return {
    id: value.id,
    partner_id: value.partner_id,
    active: value.active === true,
    public_price:
      typeof value.public_price === "number"
        || typeof value.public_price === "string"
      ? value.public_price
      : null,
    partner_discount_percent:
      typeof value.partner_discount_percent === "number"
        || typeof value.partner_discount_percent === "string"
      ? value.partner_discount_percent
      : null,
    partner_net_price:
      typeof value.partner_net_price === "number"
        || typeof value.partner_net_price === "string"
      ? value.partner_net_price
      : null,
    platform_margin_percent:
      typeof value.platform_margin_percent === "number"
        || typeof value.platform_margin_percent === "string"
      ? value.platform_margin_percent
      : null,
    final_customer_price:
      typeof value.final_customer_price === "number"
        || typeof value.final_customer_price === "string"
      ? value.final_customer_price
      : null,
    deposit_amount:
      typeof value.deposit_amount === "number"
        || typeof value.deposit_amount === "string"
      ? value.deposit_amount
      : null,
    mileage_limit:
      typeof value.mileage_limit === "number"
        || typeof value.mileage_limit === "string"
      ? value.mileage_limit
      : null,
    driver_included: value.driver_included === true,
    features: isRecord(value.features) ? value.features : {},
    partner,
  };
}

function normalizeQuote(value: unknown): QuoteRow | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.partner_id)
    || !isUuid(value.car_class_id)
    || typeof value.external_group_id !== "string"
    || typeof value.start_date !== "string"
    || typeof value.end_date !== "string"
    || typeof value.currency !== "string"
    || typeof value.expires_at !== "string"
  ) {
    return null;
  }

  const requiredNumbers = [
    value.public_price_per_day,
    value.partner_net_total,
    value.commission_total,
    value.final_total,
  ];
  if (
    !requiredNumbers.every((item) => finiteNumber(item) !== null)
  ) {
    return null;
  }

  return {
    id: value.id,
    partner_id: value.partner_id,
    car_class_id: value.car_class_id,
    external_group_id: value.external_group_id.slice(0, 200),
    pickup_location_external_id: cleanText(
      value.pickup_location_external_id,
      200,
    ),
    dropoff_location_external_id: cleanText(
      value.dropoff_location_external_id,
      200,
    ),
    start_date: value.start_date,
    end_date: value.end_date,
    public_price_per_day: value.public_price_per_day as number | string,
    partner_discount_percent:
      typeof value.partner_discount_percent === "number"
        || typeof value.partner_discount_percent === "string"
      ? value.partner_discount_percent
      : null,
    platform_margin_percent:
      typeof value.platform_margin_percent === "number"
        || typeof value.platform_margin_percent === "string"
      ? value.platform_margin_percent
      : null,
    partner_net_total: value.partner_net_total as number | string,
    commission_total: value.commission_total as number | string,
    final_total: value.final_total as number | string,
    currency: value.currency,
    expires_at: value.expires_at,
  };
}

async function exchangeRate(currency: string): Promise<number> {
  if (currency === "PLN") return 1;

  const tables = ["A", "B"] as const;
  for (const table of tables) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);

    try {
      const response = await fetch(
        `https://api.nbp.pl/api/exchangerates/rates/${table}/${currency}/?format=json`,
        {
          headers: { Accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        },
      );

      if (response.status === 404) continue;
      if (!response.ok) throw new Error("NBP_HTTP_ERROR");

      const contentLength = Number(response.headers.get("content-length") || "0");
      if (Number.isFinite(contentLength) && contentLength > 64_000) {
        throw new Error("NBP_RESPONSE_TOO_LARGE");
      }

      const payload = await response.json();
      const payloadRecord = firstRecord(payload);
      const rates = Array.isArray(payloadRecord?.rates) ? payloadRecord.rates : [];
      const rate = Number(firstRecord(rates)?.mid);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error("NBP_INVALID_RATE");
      }
      return rate;
    } catch (error) {
      if (table === "B") {
        console.warn("create-booking-request NBP unavailable", currency);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // Zachowujemy dotychczasowy awaryjny fallback wyłącznie dla EUR/USD.
  if (currency === "USD") return 4.0;
  if (currency === "EUR") return 4.5;
  throw new Error("Nie udało się pobrać kursu waluty partnera");
}

async function releaseQuoteClaim(
  admin: AdminClient,
  claim: ClaimedQuote | null,
): Promise<void> {
  if (!claim) return;

  const { error } = await admin
    .from("api_quotes")
    .update({ used_at: null, booking_id: null })
    .eq("id", claim.row.id)
    .eq("used_at", claim.claimedAt)
    .is("booking_id", null);

  if (error) {
    console.error("create-booking-request quote release failed");
  }
}

async function claimApiQuote(
  admin: AdminClient,
  quoteId: string,
  car: CarRow,
  startDate: string,
  endDate: string,
): Promise<ClaimedQuote | null> {
  const now = new Date().toISOString();

  const { data: rawQuote, error: quoteError } = await admin
    .from("api_quotes")
    .select(
      "id, partner_id, car_class_id, external_group_id, pickup_location_external_id, dropoff_location_external_id, start_date, end_date, public_price_per_day, partner_discount_percent, platform_margin_percent, partner_net_total, commission_total, final_total, currency, expires_at",
    )
    .eq("id", quoteId)
    .eq("partner_id", car.partner_id)
    .eq("car_class_id", car.id)
    .eq("start_date", startDate)
    .eq("end_date", endDate)
    .gt("expires_at", now)
    .is("used_at", null)
    .is("booking_id", null)
    .maybeSingle();

  const quote = normalizeQuote(rawQuote);
  if (quoteError || !quote) return null;

  const publicPrice = finiteNumber(quote.public_price_per_day);
  const partnerNet = finiteNumber(quote.partner_net_total);
  const commission = finiteNumber(quote.commission_total);
  const finalTotal = finiteNumber(quote.final_total);
  const discount = finiteNumber(quote.partner_discount_percent ?? 0);
  const margin = finiteNumber(quote.platform_margin_percent ?? 25);

  if (
    publicPrice === null
    || publicPrice <= 0
    || partnerNet === null
    || partnerNet < 0
    || commission === null
    || commission < 0
    || finalTotal === null
    || finalTotal <= 0
    || Math.abs(partnerNet + commission - finalTotal) > 0.05
    || discount === null
    || discount < 0
    || discount > 50
    || margin === null
    || margin < 0
    || margin > 100
    || !normalizedCurrency(quote.currency)
  ) {
    return null;
  }

  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("api_quotes")
    .update({ used_at: claimedAt })
    .eq("id", quote.id)
    .gt("expires_at", now)
    .is("used_at", null)
    .is("booking_id", null)
    .select("id")
    .maybeSingle();

  if (claimError || !claimed) return null;
  return { row: quote, claimedAt };
}

async function bindQuoteToBooking(
  admin: AdminClient,
  claim: ClaimedQuote,
  bookingId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("api_quotes")
    .update({ booking_id: bookingId })
    .eq("id", claim.row.id)
    .eq("used_at", claim.claimedAt)
    .is("booking_id", null)
    .select("id")
    .maybeSingle();

  return !error && Boolean(data);
}

function dispatchFunctionUrl(): string {
  const rawUrl = Deno.env.get("SUPABASE_URL");
  if (!rawUrl) throw new Error("DISPATCH_CONFIGURATION_MISSING");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DISPATCH_CONFIGURATION_MISSING");
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("DISPATCH_CONFIGURATION_MISSING");
  }

  url.pathname = "/functions/v1/api-booking-dispatch";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function dispatchApiBooking(
  bookingId: string,
): Promise<void> {
  const internalSecret = Deno.env.get("RIDE24_INTERNAL_SECRET");
  if (!internalSecret) {
    console.error("create-booking-request dispatch configuration missing");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(dispatchFunctionUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ booking_id: bookingId }),
      signal: controller.signal,
      redirect: "error",
    });

    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      console.error(
        "create-booking-request dispatch failed",
        bookingId,
        response.status,
      );
    }
  } catch {
    console.error(
      "create-booking-request dispatch failed",
      bookingId,
      "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function emailWorkerUrl(): string {
  const rawUrl = Deno.env.get("SUPABASE_URL");
  if (!rawUrl) throw new Error("EMAIL_WORKER_CONFIGURATION_MISSING");

  const url = new URL(rawUrl);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error("EMAIL_WORKER_CONFIGURATION_MISSING");
  }

  url.pathname = "/functions/v1/email-worker";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function triggerEmailWorker(bookingId: string): Promise<void> {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    console.error("create-booking-request email worker configuration missing");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(emailWorkerUrl(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ booking_id: bookingId }),
      signal: controller.signal,
      redirect: "error",
    });

    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      console.error(
        "create-booking-request email worker failed",
        bookingId,
        response.status,
      );
    }
  } catch {
    console.error(
      "create-booking-request email worker failed",
      bookingId,
      "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveApiLocation(
  admin: AdminClient,
  partnerId: string,
  externalId: string,
): Promise<LocationRow | null> {
  const { data, error } = await admin
    .from("partner_locations")
    .select("id, location_name")
    .eq("partner_id", partnerId)
    .eq("external_id", externalId)
    .eq("active", true)
    .maybeSingle();

  if (
    error
    || !isRecord(data)
    || !isUuid(data.id)
  ) {
    return null;
  }

  return {
    id: data.id,
    location_name: cleanText(data.location_name, MAX_LOCATION_LENGTH),
  };
}

async function resolveLocalLocation(
  admin: AdminClient,
  partnerId: string,
  locationName: string,
): Promise<LocationRow | null> {
  const { data, error } = await admin
    .from("partner_locations")
    .select("id, location_name")
    .eq("partner_id", partnerId)
    .eq("location_name", locationName)
    .eq("active", true)
    .maybeSingle();

  if (
    error
    || !isRecord(data)
    || !isUuid(data.id)
  ) {
    return null;
  }

  return {
    id: data.id,
    location_name: cleanText(data.location_name, MAX_LOCATION_LENGTH),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      req,
      { error: "METHOD_NOT_ALLOWED" },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  let quoteClaim: ClaimedQuote | null = null;

  try {
    const user = await authenticatedUser(req);
    const admin = serviceClient();

    await enforceRateLimit(
      admin,
      req,
      "create-booking-request",
      RATE_LIMIT_REQUESTS,
      RATE_LIMIT_WINDOW_SECONDS,
    );

    const body = await readJsonObject(req) as BookingBody;

    if (!isUuid(body.car_class_id)) {
      return jsonResponse(
        req,
        { error: "Nieprawidłowe dane rezerwacji" },
        400,
      );
    }

    const startDate = parseIsoDate(body.start_date);
    const endDate = parseIsoDate(body.end_date);
    const bookingDays = Math.round(
      (endDate.timestamp - startDate.timestamp) / 86_400_000,
    );

    if (bookingDays < 1 || bookingDays > MAX_BOOKING_DAYS) {
      return jsonResponse(
        req,
        { error: "Data zwrotu musi być późniejsza niż data odbioru" },
        400,
      );
    }

    if (body.terms_accepted !== true) {
      return jsonResponse(
        req,
        { error: "Wymagana akceptacja regulaminów" },
        400,
      );
    }

    if (
      body.driver_id != null
      && body.driver_id !== ""
      && !isUuid(body.driver_id)
    ) {
      return jsonResponse(req, { error: "Nieprawidłowy kierowca" }, 400);
    }
    if (
      body.additional_driver_id != null
      && body.additional_driver_id !== ""
      && !isUuid(body.additional_driver_id)
    ) {
      return jsonResponse(req, { error: "Nieprawidłowy kierowca" }, 400);
    }

    const driverId = isUuid(body.driver_id) ? body.driver_id : null;
    const additionalDriverId = isUuid(body.additional_driver_id)
      ? body.additional_driver_id
      : null;

    if (
      driverId
      && additionalDriverId
      && driverId === additionalDriverId
    ) {
      return jsonResponse(
        req,
        {
          error:
            "Główny i dodatkowy kierowca nie mogą być tą samą osobą",
        },
        400,
      );
    }

    const pickupTime = cleanTime(body.pickup_time);
    const returnTime = cleanTime(body.return_time);

    const { data: rawProfile, error: profileError } = await admin
      .from("profiles")
      .select("name, phone, age")
      .eq("id", user.id)
      .maybeSingle();

    const profile = isRecord(rawProfile) ? rawProfile : null;
    const profileName = cleanText(
      profile?.name,
      MAX_DRIVER_NAME_LENGTH,
    );
    const profilePhone = cleanText(profile?.phone, 80);
    const profileAge = finiteNumber(profile?.age);

    if (
      profileError
      || !profileName
      || !profilePhone
      || profileAge === null
      || profileAge <= 0
      || profileAge > 120
    ) {
      return jsonResponse(
        req,
        { error: "Uzupełnij profil przed rezerwacją" },
        400,
      );
    }

    const { data: rawCar, error: carError } = await admin
      .from("car_classes")
      .select(`
        id,
        partner_id,
        active,
        public_price,
        partner_discount_percent,
        partner_net_price,
        platform_margin_percent,
        final_customer_price,
        deposit_amount,
        mileage_limit,
        driver_included,
        features,
        partners!inner(
          id,
          active,
          account_status,
          currency,
          email,
          provider_type,
          api_enabled,
          rental_terms_url,
          rental_rules_url
        )
      `)
      .eq("id", body.car_class_id)
      .maybeSingle();

    const car = normalizeCar(rawCar);
    if (
      carError
      || !car
      || car.active !== true
      || car.partner.active !== true
      || car.partner.account_status !== "active"
    ) {
      return jsonResponse(
        req,
        { error: "Wybrana grupa pojazdów nie jest dostępna" },
        400,
      );
    }

    let mainDriverName = profileName;
    let mainDriverAge = profileAge;
    let additionalDriverName: string | null = null;
    let additionalDriverAge: number | null = null;

    const driverIds = [driverId, additionalDriverId]
      .filter((id): id is string => Boolean(id));

    if (driverIds.length > 0) {
      const { data: rawDrivers, error: driversError } = await admin
        .from("drivers")
        .select("id, user_id, name, age")
        .in("id", driverIds);

      const drivers = (rawDrivers || [])
        .filter((value): value is Record<string, unknown> => isRecord(value));

      if (
        driversError
        || drivers.length !== driverIds.length
        || drivers.some((driver) => driver.user_id !== user.id)
      ) {
        return jsonResponse(
          req,
          { error: "Nieprawidłowy kierowca" },
          403,
        );
      }

      const mainDriver = driverId
        ? drivers.find((driver) => driver.id === driverId)
        : null;
      const additionalDriver = additionalDriverId
        ? drivers.find((driver) => driver.id === additionalDriverId)
        : null;

      if (mainDriver) {
        const name = cleanText(
          mainDriver.name,
          MAX_DRIVER_NAME_LENGTH,
        );
        const age = finiteNumber(mainDriver.age);
        if (!name || age === null || age <= 0 || age > 120) {
          return jsonResponse(
            req,
            { error: "Nieprawidłowy kierowca" },
            400,
          );
        }
        mainDriverName = name;
        mainDriverAge = age;
      }

      if (additionalDriver) {
        const name = cleanText(
          additionalDriver.name,
          MAX_DRIVER_NAME_LENGTH,
        );
        const age = finiteNumber(additionalDriver.age);
        if (!name || age === null || age <= 0 || age > 120) {
          return jsonResponse(
            req,
            { error: "Nieprawidłowy kierowca" },
            400,
          );
        }
        additionalDriverName = name;
        additionalDriverAge = age;
      }
    }

    let baseTotal: number;
    let commission: number;
    let finalTotal: number;
    let publicPriceSnapshot = finiteNumber(car.public_price) ?? 0;
    let partnerDiscountSnapshot =
      finiteNumber(car.partner_discount_percent) ?? 0;
    let platformMarginSnapshot =
      finiteNumber(car.platform_margin_percent) ?? 25;
    let apiQuoteId: string | null = null;
    let apiPickupExternalId: string | null = null;
    let apiDropoffExternalId: string | null = null;
    let apiQuoteCurrency: string | null = null;

    if (car.partner.provider_type === "api") {
      if (
        car.partner.api_enabled !== true
        || !isUuid(body.api_quote_id)
      ) {
        return jsonResponse(
          req,
          {
            error:
              "Oferta API wygasła. Wróć do wyników i wybierz ją ponownie.",
          },
          409,
        );
      }

      quoteClaim = await claimApiQuote(
        admin,
        body.api_quote_id,
        car,
        startDate.text,
        endDate.text,
      );
      if (!quoteClaim) {
        return jsonResponse(
          req,
          {
            error:
              "Oferta API wygasła. Wróć do wyników i wybierz ją ponownie.",
          },
          409,
        );
      }

      const quote = quoteClaim.row;
      baseTotal = finiteNumber(quote.partner_net_total)!;
      commission = finiteNumber(quote.commission_total)!;
      finalTotal = finiteNumber(quote.final_total)!;
      publicPriceSnapshot = finiteNumber(quote.public_price_per_day)!;
      partnerDiscountSnapshot =
        finiteNumber(quote.partner_discount_percent) ?? 0;
      platformMarginSnapshot =
        finiteNumber(quote.platform_margin_percent) ?? 25;
      apiQuoteId = quote.id;
      apiPickupExternalId = quote.pickup_location_external_id;
      apiDropoffExternalId =
        quote.dropoff_location_external_id
        || quote.pickup_location_external_id;
      apiQuoteCurrency = quote.currency;
    } else {
      const { data: pricingData, error: pricingError } = await admin.rpc(
        "calculate_booking_price",
        {
          car_id: car.id,
          start_date: startDate.text,
          end_date: endDate.text,
        },
      );

      const pricing = firstRecord(pricingData);
      if (pricingError || !pricing) {
        throw new Error("Nie udało się obliczyć ceny");
      }

      baseTotal = finiteNumber(pricing.base_total) ?? Number.NaN;
      commission = finiteNumber(pricing.commission) ?? Number.NaN;
      finalTotal = finiteNumber(pricing.final_total) ?? Number.NaN;
      publicPriceSnapshot =
        finiteNumber(pricing.public_price_per_day) ?? Number.NaN;
      partnerDiscountSnapshot =
        finiteNumber(pricing.partner_discount_percent) ?? Number.NaN;
      platformMarginSnapshot =
        finiteNumber(pricing.platform_margin_percent) ?? Number.NaN;
    }

    if (
      ![
        baseTotal,
        commission,
        finalTotal,
        publicPriceSnapshot,
        partnerDiscountSnapshot,
        platformMarginSnapshot,
      ].every((value) => Number.isFinite(value) && value >= 0)
      || publicPriceSnapshot <= 0
      || partnerDiscountSnapshot > 100
      || platformMarginSnapshot > 100
      || finalTotal <= 0
      || Math.abs(baseTotal + commission - finalTotal) > 0.05
    ) {
      throw new Error("Nieprawidłowy wynik kalkulacji ceny");
    }

    const { data: loyaltyData, error: loyaltyError } = await admin.rpc(
      "calculate_loyalty_discount",
      { p_user_id: user.id },
    );
    if (loyaltyError) throw new Error("Nie udało się obliczyć rabatu");

    const loyaltyValue = Array.isArray(loyaltyData)
      ? loyaltyData[0]
      : loyaltyData;
    const discountPercent = Math.max(
      0,
      Math.min(20, finiteNumber(loyaltyValue) ?? 0),
    );

    const currency = safeCurrency(
      apiQuoteCurrency || car.partner.currency || "EUR",
    );
    const rate = await exchangeRate(currency);
    const onlinePaymentPln = Number(
      (commission * rate * (1 - discountPercent / 100)).toFixed(2),
    );

    if (
      !Number.isFinite(rate)
      || rate <= 0
      || !Number.isFinite(onlinePaymentPln)
      || onlinePaymentPln < 0
    ) {
      throw new Error("Nieprawidłowy wynik kalkulacji ceny");
    }

    let pickupName = cleanText(
      body.pickup_location,
      MAX_LOCATION_LENGTH,
      "Do ustalenia",
    )!;
    let returnName = cleanText(
      body.return_location,
      MAX_LOCATION_LENGTH,
      pickupName,
    )!;

    let pickupLocation: LocationRow | null = null;
    let dropoffLocation: LocationRow | null = null;

    if (apiQuoteId) {
      if (!apiPickupExternalId) {
        await releaseQuoteClaim(admin, quoteClaim);
        quoteClaim = null;
        return jsonResponse(
          req,
          {
            error:
              "Lokalizacja odbioru oferty API nie jest już dostępna",
          },
          409,
        );
      }

      pickupLocation = await resolveApiLocation(
        admin,
        car.partner_id,
        apiPickupExternalId,
      );
      if (!pickupLocation) {
        await releaseQuoteClaim(admin, quoteClaim);
        quoteClaim = null;
        return jsonResponse(
          req,
          {
            error:
              "Lokalizacja odbioru oferty API nie jest już dostępna",
          },
          409,
        );
      }
      pickupName = pickupLocation.location_name || pickupName;

      dropoffLocation = await resolveApiLocation(
        admin,
        car.partner_id,
        apiDropoffExternalId || apiPickupExternalId,
      );
      if (!dropoffLocation) {
        await releaseQuoteClaim(admin, quoteClaim);
        quoteClaim = null;
        return jsonResponse(
          req,
          {
            error:
              "Lokalizacja zwrotu oferty API nie jest już dostępna",
          },
          409,
        );
      }
      returnName = dropoffLocation.location_name || returnName;
    } else {
      pickupLocation = await resolveLocalLocation(
        admin,
        car.partner_id,
        pickupName,
      );
      dropoffLocation = await resolveLocalLocation(
        admin,
        car.partner_id,
        returnName,
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const partnerResponseDeadline = new Date(
      now.getTime() + PARTNER_RESPONSE_WINDOW_MS,
    ).toISOString();

    const driverHours = cleanText(
      car.features.driverHours,
      500,
    );

    const insertPayload = {
      car_class_id: car.id,
      partner_id: car.partner_id,
      client_id: user.id,
      pickup_location_id: pickupLocation?.id || null,
      dropoff_location_id: dropoffLocation?.id || null,
      start_date: startDate.text,
      end_date: endDate.text,
      pickup_time: pickupTime,
      return_time: returnTime,
      status: "pending",
      partner_response_deadline: partnerResponseDeadline,
      client_phone: profilePhone,
      client_email: cleanText(user.email, 254),
      main_driver_name: mainDriverName,
      main_driver_age: mainDriverAge,
      add_driver_name: additionalDriverName,
      add_driver_age: additionalDriverAge,
      driver_id: driverId,
      additional_driver_id: additionalDriverId,
      deposit_snapshot: Math.max(
        0,
        finiteNumber(car.deposit_amount) ?? 0,
      ),
      mileage_limit_snapshot: finiteNumber(car.mileage_limit),
      driver_included_snapshot: car.driver_included === true,
      driver_hours_snapshot: driverHours,
      partner_terms_snapshot: car.partner.rental_terms_url,
      partner_rules_snapshot: car.partner.rental_rules_url,
      platform_terms_version: PLATFORM_TERMS_VERSION,
      terms_accepted: true,
      terms_accepted_at: nowIso,
      pickup_location: pickupName,
      return_location: returnName,
      partner_public_price_snapshot: publicPriceSnapshot,
      partner_discount_snapshot: partnerDiscountSnapshot,
      partner_net_price_snapshot: baseTotal,
      platform_margin_snapshot: platformMarginSnapshot,
      final_price_snapshot: finalTotal,
      commission_snapshot: commission,
      online_payment_pln: onlinePaymentPln,
      pickup_payment_partner_currency: baseTotal,
      partner_currency: currency,
      loyalty_discount_percent: discountPercent,
      loyalty_applied: discountPercent > 0,
      provider_type: car.partner.provider_type,
      exchange_rate_snapshot: rate,
      api_quote_id: apiQuoteId,
    };

    const { data: rawBooking, error: bookingError } = await admin
      .from("bookings")
      .insert(insertPayload)
      .select(
        "id, reservation_code, status, partner_response_deadline",
      )
      .single();

    if (bookingError || !isRecord(rawBooking) || !isUuid(rawBooking.id)) {
      await releaseQuoteClaim(admin, quoteClaim);
      quoteClaim = null;

      if (
        bookingError?.message?.includes("no_overlapping_bookings")
        || bookingError?.code === "23P01"
      ) {
        return jsonResponse(
          req,
          {
            error:
              "Ten termin został właśnie zajęty. Wybierz inne daty lub grupę.",
          },
          409,
        );
      }
      throw new Error("Nie udało się utworzyć rezerwacji");
    }

    const bookingId = rawBooking.id;

    if (
      quoteClaim
      && !(await bindQuoteToBooking(admin, quoteClaim, bookingId))
    ) {
      const { error: deleteError } = await admin
        .from("bookings")
        .delete()
        .eq("id", bookingId)
        .eq("client_id", user.id)
        .eq("status", "pending");

      await releaseQuoteClaim(admin, quoteClaim);
      quoteClaim = null;

      if (deleteError) {
        console.error(
          "create-booking-request booking cleanup failed",
          bookingId,
        );
      }
      throw new Error("Nie udało się przypisać wyceny API");
    }

    quoteClaim = null;

    if (car.partner.provider_type !== "api") {
      const { error: queueError } = await admin
        .from("email_logs")
        .upsert(
          {
            booking_id: bookingId,
            email: car.partner.email,
            type: "partner_new_request",
            status: "queued",
          },
          {
            onConflict: "booking_id,type",
            ignoreDuplicates: true,
          },
        );

      if (queueError) {
        console.error(
          "create-booking-request email queue failed",
          bookingId,
        );
      } else {
        await triggerEmailWorker(bookingId);
      }
    } else {
      await dispatchApiBooking(bookingId);
    }

    return jsonResponse(req, {
      success: true,
      booking: {
        id: bookingId,
        reservation_code: cleanText(
          rawBooking.reservation_code,
          100,
        ),
        status: cleanText(rawBooking.status, 50) || "pending",
        partner_response_deadline:
          cleanText(rawBooking.partner_response_deadline, 80)
          || partnerResponseDeadline,
      },
    });
  } catch (error) {
    if (quoteClaim) {
      const admin = serviceClient();
      await releaseQuoteClaim(admin, quoteClaim).catch(() => undefined);
    }

    console.error(
      "create-booking-request",
      error instanceof Error
        ? error.message === "AUTH_REQUIRED"
          ? "AUTH_REQUIRED"
          : error.message === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : "REQUEST_FAILED"
        : "UNKNOWN_ERROR",
    );

    const publicError = publicErrorMessage(error);
    return jsonResponse(
      req,
      { error: publicError.message },
      publicError.status,
    );
  }
});
