import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  enforceRateLimit,
  jsonResponse,
  publicErrorMessage,
  serviceClient,
} from "../_shared/ride24-security.ts";
import {
  endpointFor,
  loadPartnerCredentials,
  normalizeGroups,
  partnerApiRequest,
  sanitizePartnerPayload,
  type ApiVehicleGroup,
} from "../_shared/partner-api.ts";

type AdminClient = ReturnType<typeof serviceClient>;

type SearchBody = {
  pickupType?: unknown;
  pickupCountry?: unknown;
  pickupRegion?: unknown;
  pickupCity?: unknown;
  pickupLocationName?: unknown;
  pickupLocation?: unknown;
  dropoffType?: unknown;
  dropoffCountry?: unknown;
  dropoffRegion?: unknown;
  dropoffCity?: unknown;
  dropoffLocationName?: unknown;
  dropoffLocation?: unknown;
  pickupDate?: unknown;
  returnDate?: unknown;
  pickupTime?: unknown;
  returnTime?: unknown;
};

type LocationCriteria = {
  type: string;
  country: string;
  region: string;
  city: string;
  locationName: string;
  displayName: string;
};

type PartnerLocationRow = {
  id: string;
  partner_id: string;
  external_id: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  location_name: string | null;
  type: string | null;
  active: boolean | null;
  extra_fee: boolean | null;
  extra_fee_amount: number | string | null;
  contact_required: boolean | null;
  partners: PartnerRow;
};

type PartnerRow = {
  id: string;
  company_name: string | null;
  provider_type: string | null;
  api_provider: string | null;
  api_enabled: boolean | null;
  discount_percent: number | string | null;
  currency: string | null;
  min_driver_age: number | string | null;
  active: boolean | null;
  account_status: string | null;
};

type CarClassRow = {
  id: string;
  external_id: string;
  class_code: string | null;
  description: string | null;
  example_model: string | null;
  model: string | null;
  image: string | null;
  transmission: string | null;
  fuel_type: string | null;
  seats: number | null;
  bags: number | null;
  features: unknown;
  mileage_limit: number | null;
  deposit_amount: number | string | null;
  driver_included: boolean | null;
  active: boolean | null;
  platform_margin_percent: number | string | null;
};

type QuoteBudget = {
  remaining: number;
};

const MAX_REQUEST_BYTES = 32_768;
const MAX_LOCATION_ROWS = 500;
const MAX_PARTNERS_PER_SEARCH = 50;
const MAX_GROUPS_PER_PARTNER = 1_000;
const MAX_RESULTS_PER_SEARCH = 250;
const MAX_PROVIDER_CONCURRENCY = 5;
const CLASS_LOOKUP_BATCH_SIZE = 100;
const DEFAULT_PLATFORM_MARGIN_PERCENT = 25;
const DEFAULT_TIME = "10:00";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new Error("Wymagane dane w formacie JSON");
  }

  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("Nieprawidłowy rozmiar danych wejściowych");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new Error("Wymagane dane wyszukiwania");

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

function cleanText(value: unknown, maxLength = 180): string {
  if (typeof value !== "string" && typeof value !== "number") return "";

  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    return "";
  }
  return text;
}

function parseIsoDate(value: unknown): { text: string; timestamp: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Nieprawidłowe daty");
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error("Nieprawidłowe daty");

  const normalized = new Date(timestamp).toISOString().slice(0, 10);
  if (normalized !== value) throw new Error("Nieprawidłowe daty");

  return { text: value, timestamp };
}

function cleanTime(value: unknown): string {
  return typeof value === "string"
      && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
    ? value
    : DEFAULT_TIME;
}

function criteriaFromBody(
  body: SearchBody,
  prefix: "pickup" | "dropoff",
): LocationCriteria {
  const locationName = cleanText(
    body[`${prefix}LocationName` as keyof SearchBody],
  );
  const displayName = cleanText(
    body[`${prefix}Location` as keyof SearchBody],
  ) || locationName;

  return {
    type: cleanText(body[`${prefix}Type` as keyof SearchBody], 30).toLowerCase(),
    country: cleanText(body[`${prefix}Country` as keyof SearchBody]),
    region: cleanText(body[`${prefix}Region` as keyof SearchBody]),
    city: cleanText(body[`${prefix}City` as keyof SearchBody]),
    locationName,
    displayName,
  };
}

function hasLocationCriteria(criteria: LocationCriteria): boolean {
  return Boolean(
    criteria.locationName
      || criteria.city
      || criteria.region
      || criteria.country
      || criteria.displayName,
  );
}

function applyLocationFilter(query: any, criteria: LocationCriteria): any {
  // Zachowuje ten sam priorytet intencji, którego używa results.html.
  if (criteria.locationName) return query.eq("location_name", criteria.locationName);
  if ((criteria.type === "airport" || criteria.type === "city") && criteria.city) {
    return query.eq("city", criteria.city);
  }
  if (criteria.type === "region" && criteria.region) {
    return query.eq("region", criteria.region);
  }
  if (criteria.country) return query.eq("country", criteria.country);
  if (criteria.city) return query.eq("city", criteria.city);
  if (criteria.region) return query.eq("region", criteria.region);
  return query.eq("location_name", criteria.displayName);
}

function comparable(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function sameLocation(a: LocationCriteria, b: LocationCriteria): boolean {
  if (!hasLocationCriteria(b)) return true;
  if (a.locationName && b.locationName) {
    return comparable(a.locationName) === comparable(b.locationName);
  }
  if (a.displayName && b.displayName) {
    if (comparable(a.displayName) === comparable(b.displayName)) return true;
  }

  return a.type === b.type
    && comparable(a.country) === comparable(b.country)
    && comparable(a.region) === comparable(b.region)
    && comparable(a.city) === comparable(b.city);
}

function partnerFromRelation(value: unknown): PartnerRow | null {
  const row = firstRecord(value);
  if (!row || typeof row.id !== "string") return null;

  return {
    id: row.id,
    company_name: typeof row.company_name === "string" ? row.company_name : null,
    provider_type: typeof row.provider_type === "string" ? row.provider_type : null,
    api_provider: typeof row.api_provider === "string" ? row.api_provider : null,
    api_enabled: row.api_enabled === true,
    discount_percent: typeof row.discount_percent === "number" || typeof row.discount_percent === "string"
      ? row.discount_percent
      : null,
    currency: typeof row.currency === "string" ? row.currency : null,
    min_driver_age: typeof row.min_driver_age === "number" || typeof row.min_driver_age === "string"
      ? row.min_driver_age
      : null,
    active: row.active === true,
    account_status: typeof row.account_status === "string" ? row.account_status : null,
  };
}

function normalizeLocationRow(value: unknown): PartnerLocationRow | null {
  if (!isRecord(value)) return null;
  const partner = partnerFromRelation(value.partners);
  if (
    !partner
    || typeof value.id !== "string"
    || typeof value.partner_id !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    partner_id: value.partner_id,
    external_id: typeof value.external_id === "string" ? value.external_id : null,
    country: typeof value.country === "string" ? value.country : null,
    region: typeof value.region === "string" ? value.region : null,
    city: typeof value.city === "string" ? value.city : null,
    location_name: typeof value.location_name === "string" ? value.location_name : null,
    type: typeof value.type === "string" ? value.type : null,
    active: value.active === true,
    extra_fee: value.extra_fee === true,
    extra_fee_amount: typeof value.extra_fee_amount === "number" || typeof value.extra_fee_amount === "string"
      ? value.extra_fee_amount
      : null,
    contact_required: value.contact_required === true,
    partners: partner,
  };
}

async function resolveDropoffLocation(
  admin: AdminClient,
  partnerId: string,
  pickupLocation: PartnerLocationRow,
  pickupCriteria: LocationCriteria,
  dropoffCriteria: LocationCriteria,
): Promise<PartnerLocationRow | null> {
  if (sameLocation(pickupCriteria, dropoffCriteria)) return pickupLocation;

  let query = admin
    .from("partner_locations")
    .select(
      "id, partner_id, external_id, country, region, city, location_name, type, active, extra_fee, extra_fee_amount, contact_required",
    )
    .eq("partner_id", partnerId)
    .eq("active", true);

  query = applyLocationFilter(query, dropoffCriteria);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error("Nie udało się sprawdzić lokalizacji zwrotu");
  if (!data || !isRecord(data)) return null;

  return {
    id: typeof data.id === "string" ? data.id : "",
    partner_id: typeof data.partner_id === "string" ? data.partner_id : partnerId,
    external_id: typeof data.external_id === "string" ? data.external_id : null,
    country: typeof data.country === "string" ? data.country : null,
    region: typeof data.region === "string" ? data.region : null,
    city: typeof data.city === "string" ? data.city : null,
    location_name: typeof data.location_name === "string" ? data.location_name : null,
    type: typeof data.type === "string" ? data.type : null,
    active: data.active === true,
    extra_fee: data.extra_fee === true,
    extra_fee_amount: typeof data.extra_fee_amount === "number" || typeof data.extra_fee_amount === "string"
      ? data.extra_fee_amount
      : null,
    contact_required: data.contact_required === true,
    partners: pickupLocation.partners,
  };
}

function quoteExpiry(group: ApiVehicleGroup): string {
  const now = Date.now();
  const localLimit = now + 15 * 60 * 1000;
  const supplied = group.quote_expires_at
    ? Date.parse(group.quote_expires_at)
    : Number.NaN;
  const timestamp = Number.isFinite(supplied) && supplied > now
    ? Math.min(localLimit, supplied)
    : localLimit;

  return new Date(timestamp).toISOString();
}

function normalizedCurrency(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  const currency = raw === "TRL" ? "TRY" : raw;
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function safeCurrency(value: unknown): string {
  return normalizedCurrency(value) || "EUR";
}

function safeMargin(value: unknown): number {
  const margin = Number(value);
  if (!Number.isFinite(margin) || margin <= 0 || margin > 100) {
    return DEFAULT_PLATFORM_MARGIN_PERCENT;
  }
  return Number(margin.toFixed(2));
}

async function loadGlobalPlatformMargin(admin: AdminClient): Promise<number> {
  const { data, error } = await admin.rpc("get_global_platform_margin");
  if (error) {
    console.warn("search-api global margin fallback");
    return DEFAULT_PLATFORM_MARGIN_PERCENT;
  }
  return safeMargin(data);
}

function safeDiscount(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(50, number));
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, 200)) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().slice(0, 200);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function publicFeatures(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePartnerPayload(value, 8_000);
  return isRecord(sanitized) ? sanitized : {};
}

function externalQuoteReference(
  group: ApiVehicleGroup,
  response: unknown,
): string | null {
  const direct = typeof group.quote_reference === "string"
    ? group.quote_reference.trim()
    : "";
  if (direct) return direct.slice(0, 500);

  const responseRecord = isRecord(response) ? response : null;
  const fallback = typeof responseRecord?.quote_reference === "string"
    ? responseRecord.quote_reference.trim()
    : "";
  return fallback ? fallback.slice(0, 500) : null;
}

async function loadCarClasses(
  admin: AdminClient,
  partnerId: string,
  externalIds: string[],
): Promise<Map<string, CarClassRow>> {
  const output = new Map<string, CarClassRow>();

  for (let offset = 0; offset < externalIds.length; offset += CLASS_LOOKUP_BATCH_SIZE) {
    const batch = externalIds.slice(offset, offset + CLASS_LOOKUP_BATCH_SIZE);
    const { data, error } = await admin
      .from("car_classes")
      .select(
        "id, external_id, class_code, description, example_model, model, image, transmission, fuel_type, seats, bags, features, mileage_limit, deposit_amount, driver_included, active, platform_margin_percent",
      )
      .eq("partner_id", partnerId)
      .eq("is_api_managed", true)
      .eq("active", true)
      .in("external_id", batch);

    if (error) throw new Error("Nie udało się odczytać grup pojazdów API");

    for (const raw of data || []) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.external_id !== "string") {
        continue;
      }

      output.set(raw.external_id, {
        id: raw.id,
        external_id: raw.external_id,
        class_code: typeof raw.class_code === "string" ? raw.class_code : null,
        description: typeof raw.description === "string" ? raw.description : null,
        example_model: typeof raw.example_model === "string" ? raw.example_model : null,
        model: typeof raw.model === "string" ? raw.model : null,
        image: typeof raw.image === "string" ? raw.image : null,
        transmission: typeof raw.transmission === "string" ? raw.transmission : null,
        fuel_type: typeof raw.fuel_type === "string" ? raw.fuel_type : null,
        seats: typeof raw.seats === "number" ? raw.seats : null,
        bags: typeof raw.bags === "number" ? raw.bags : null,
        features: raw.features,
        mileage_limit: typeof raw.mileage_limit === "number" ? raw.mileage_limit : null,
        deposit_amount: typeof raw.deposit_amount === "number" || typeof raw.deposit_amount === "string"
          ? raw.deposit_amount
          : null,
        driver_included: raw.driver_included === true,
        active: raw.active === true,
        platform_margin_percent: typeof raw.platform_margin_percent === "number" || typeof raw.platform_margin_percent === "string"
          ? raw.platform_margin_percent
          : null,
      });
    }
  }

  return output;
}

function reserveQuoteSlot(budget: QuoteBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

function providerErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN";
  if (error.message.startsWith("PARTNER_API_ERROR:")) {
    return error.message.slice(0, 80);
  }
  if (error.message === "API_NOT_CONFIGURED") return "API_NOT_CONFIGURED";
  if (error.message.startsWith("API URL")) return "INVALID_API_URL";
  if (error.message.startsWith("Nieprawidłowy endpoint API")) {
    return "INVALID_ENDPOINT";
  }
  return "REQUEST_FAILED";
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

async function searchPartner(
  admin: AdminClient,
  pickupLocation: PartnerLocationRow,
  pickupCriteria: LocationCriteria,
  dropoffCriteria: LocationCriteria,
  pickupDate: string,
  returnDate: string,
  pickupTime: string,
  returnTime: string,
  days: number,
  quoteBudget: QuoteBudget,
  platformMarginPercent: number,
): Promise<Record<string, unknown>[]> {
  const partner = pickupLocation.partners;
  const partnerCurrency = safeCurrency(partner.currency);
  const dropoffLocation = await resolveDropoffLocation(
    admin,
    pickupLocation.partner_id,
    pickupLocation,
    pickupCriteria,
    dropoffCriteria,
  );

  // Przy innym miejscu zwrotu oferta jest pokazywana tylko wtedy, gdy ten sam
  // partner faktycznie obsługuje wskazaną lokalizację.
  if (!dropoffLocation) return [];

  const credentials = await loadPartnerCredentials(
    admin,
    pickupLocation.partner_id,
  );
  const response = await partnerApiRequest<unknown>(
    credentials,
    endpointFor(credentials, "search"),
    {
      method: "POST",
      body: {
        pickup_location_id: pickupLocation.external_id || pickupLocation.id,
        dropoff_location_id: dropoffLocation.external_id || dropoffLocation.id,
        pickup_location: pickupCriteria.displayName
          || pickupLocation.location_name
          || "",
        dropoff_location: dropoffCriteria.displayName
          || dropoffLocation.location_name
          || "",
        pickup_date: pickupDate,
        return_date: returnDate,
        pickup_time: pickupTime,
        return_time: returnTime,
      },
    },
  );

  const groups = normalizeGroups(response)
    .filter((group) => group.active !== false)
    .slice(0, MAX_GROUPS_PER_PARTNER);
  if (!groups.length) return [];

  const externalIds = Array.from(
    new Set(groups.map((group) => group.external_id).filter(Boolean)),
  );
  const classesByExternalId = await loadCarClasses(
    admin,
    pickupLocation.partner_id,
    externalIds,
  );

  const output: Record<string, unknown>[] = [];

  for (const group of groups) {
    if (quoteBudget.remaining <= 0) break;

    const returnedCurrency = normalizedCurrency(group.currency);
    if (returnedCurrency && returnedCurrency !== partnerCurrency) {
      console.warn(
        "search-api currency mismatch",
        pickupLocation.partner_id,
        returnedCurrency,
        partnerCurrency,
      );
      continue;
    }

    const carClass = classesByExternalId.get(group.external_id);
    if (!carClass || carClass.active !== true) continue;

    const groupFeatureLocations = isRecord(group.features)
      ? safeStringArray(group.features.api_location_external_ids)
      : [];
    const classFeatureLocations = isRecord(carClass.features)
      ? safeStringArray(carClass.features.api_location_external_ids)
      : [];
    const allowedLocations = group.location_external_ids?.length
      ? safeStringArray(group.location_external_ids)
      : groupFeatureLocations.length
      ? groupFeatureLocations
      : classFeatureLocations;

    if (allowedLocations.length) {
      if (
        pickupLocation.external_id
        && !allowedLocations.includes(pickupLocation.external_id)
      ) {
        continue;
      }
      if (
        dropoffLocation.external_id
        && !allowedLocations.includes(dropoffLocation.external_id)
      ) {
        continue;
      }
    }

    const publicPricePerDay = Number(group.public_price);
    if (!Number.isFinite(publicPricePerDay) || publicPricePerDay <= 0) continue;

    const discountPercent = safeDiscount(partner.discount_percent);
    // Ta sama kolejność co dla partnerów lokalnych:
    // cena publiczna -> rabat partnera -> globalna marża Ride24 -> liczba dni.
    const partnerNetPerDayExact = publicPricePerDay
      * (1 - discountPercent / 100);
    const finalPerDayExact = partnerNetPerDayExact
      * (1 + platformMarginPercent / 100);
    const partnerNetPerDay = Number(partnerNetPerDayExact.toFixed(2));
    const finalPerDay = Number(finalPerDayExact.toFixed(2));
    const partnerNetTotal = Number((partnerNetPerDayExact * days).toFixed(2));
    const finalTotal = Number((finalPerDayExact * days).toFixed(2));
    const commissionTotal = Number((finalTotal - partnerNetTotal).toFixed(2));

    if (
      !Number.isFinite(partnerNetTotal)
      || !Number.isFinite(finalTotal)
      || !Number.isFinite(commissionTotal)
      || partnerNetTotal < 0
      || finalTotal <= 0
      || commissionTotal < 0
    ) {
      continue;
    }

    if (!reserveQuoteSlot(quoteBudget)) break;

    const quoteReference = externalQuoteReference(group, response);
    const { data: quote, error: quoteError } = await admin
      .from("api_quotes")
      .insert({
        partner_id: pickupLocation.partner_id,
        car_class_id: carClass.id,
        external_group_id: group.external_id,
        pickup_location_external_id: pickupLocation.external_id || null,
        dropoff_location_external_id: dropoffLocation.external_id || null,
        start_date: pickupDate,
        end_date: returnDate,
        public_price_per_day: publicPricePerDay,
        partner_discount_percent: discountPercent,
        platform_margin_percent: platformMarginPercent,
        partner_net_total: partnerNetTotal,
        commission_total: commissionTotal,
        final_total: finalTotal,
        currency: partnerCurrency,
        external_quote_reference: quoteReference,
        raw_response: sanitizePartnerPayload({
          group_external_id: group.external_id,
          quote_reference: quoteReference,
          pickup_location_external_id: pickupLocation.external_id || null,
          dropoff_location_external_id: dropoffLocation.external_id || null,
        }, 4_000),
        expires_at: quoteExpiry(group),
      })
      .select("id")
      .single();

    if (quoteError || !quote || typeof quote.id !== "string") continue;

    const returnedLocations = [pickupLocation];
    if (dropoffLocation.id !== pickupLocation.id) {
      returnedLocations.push(dropoffLocation);
    }

    const mergedFeatures: Record<string, unknown> = {
      ...publicFeatures(carClass.features),
      ...publicFeatures(group.features),
      api_quote_id: quote.id,
      api_pickup_external_id: pickupLocation.external_id || null,
      api_dropoff_external_id: dropoffLocation.external_id || null,
    };

    output.push({
      ...carClass,
      class_code: carClass.class_code,
      public_price: publicPricePerDay,
      partner_discount_percent: discountPercent,
      partner_net_price: partnerNetPerDay,
      platform_margin_percent: platformMarginPercent,
      final_customer_price: finalPerDay,
      description: group.description || carClass.description,
      example_model: group.example_model || carClass.example_model,
      model: group.model || carClass.model,
      image: group.image || carClass.image,
      transmission: group.transmission || carClass.transmission,
      fuel_type: group.fuel_type || carClass.fuel_type,
      seats: group.seats ?? carClass.seats,
      bags: group.bags ?? carClass.bags,
      features: mergedFeatures,
      mileage_limit: group.mileage_limit ?? carClass.mileage_limit,
      deposit_amount: group.deposit_amount ?? carClass.deposit_amount,
      driver_included: group.driver_included ?? carClass.driver_included,
      seasonal_prices: [],
      api_quote_id: quote.id,
      api_managed: true,
      partners: {
        id: partner.id,
        company_name: partner.company_name,
        active: true,
        account_status: "active",
        provider_type: "api",
        api_enabled: true,
        currency: partnerCurrency,
        min_driver_age: partner.min_driver_age,
        partner_locations: returnedLocations.map((location) => ({
          country: location.country,
          region: location.region,
          city: location.city,
          location_name: location.location_name,
          active: true,
          contact_required: location.contact_required,
          extra_fee: location.extra_fee,
          extra_fee_amount: location.extra_fee_amount,
        })),
      },
    });
  }

  return output;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const admin = serviceClient();
    // Rate limit jest sprawdzany przed odczytaniem i przetworzeniem całego body.
    await enforceRateLimit(admin, req, "public-api-search", 30, 60);

    const body = await readJsonObject(req) as SearchBody;
    const pickupDate = parseIsoDate(body.pickupDate);
    const returnDate = parseIsoDate(body.returnDate);
    if (returnDate.timestamp <= pickupDate.timestamp) {
      throw new Error("Nieprawidłowe daty");
    }

    const pickupCriteria = criteriaFromBody(body, "pickup");
    const dropoffCriteria = criteriaFromBody(body, "dropoff");
    if (!hasLocationCriteria(pickupCriteria)) {
      throw new Error("Brak lokalizacji");
    }

    const pickupTime = cleanTime(body.pickupTime);
    const returnTime = cleanTime(body.returnTime);
    const days = Math.max(
      1,
      Math.round((returnDate.timestamp - pickupDate.timestamp) / 86_400_000),
    );
    const platformMarginPercent = await loadGlobalPlatformMargin(admin);

    let query = admin
      .from("partner_locations")
      .select(`
        id,
        partner_id,
        external_id,
        country,
        region,
        city,
        location_name,
        type,
        active,
        extra_fee,
        extra_fee_amount,
        contact_required,
        partners!inner(
          id,
          company_name,
          provider_type,
          api_provider,
          api_enabled,
          discount_percent,
          currency,
          min_driver_age,
          active,
          account_status
        )
      `)
      .eq("active", true)
      .eq("partners.provider_type", "api")
      .eq("partners.api_enabled", true)
      .eq("partners.active", true)
      .eq("partners.account_status", "active");

    query = applyLocationFilter(query, pickupCriteria);
    const { data: rawLocations, error: locationError } = await query.limit(
      MAX_LOCATION_ROWS,
    );
    if (locationError) throw new Error("Nie udało się odczytać lokalizacji API");

    const locations = ((rawLocations || []) as unknown[])
      .map((row: unknown) => normalizeLocationRow(row))
      .filter((row): row is PartnerLocationRow => Boolean(row));
    if (!locations.length) {
      return jsonResponse(req, { success: true, cars: [], count: 0 });
    }

    const uniquePartners = new Map<string, PartnerLocationRow>();
    for (const location of locations) {
      if (!uniquePartners.has(location.partner_id)) {
        uniquePartners.set(location.partner_id, location);
      }
      if (uniquePartners.size >= MAX_PARTNERS_PER_SEARCH) break;
    }

    const quoteBudget: QuoteBudget = { remaining: MAX_RESULTS_PER_SEARCH };
    const partnerResults = await mapConcurrent(
      [...uniquePartners.values()],
      MAX_PROVIDER_CONCURRENCY,
      async (pickupLocation) => {
        try {
          return await searchPartner(
            admin,
            pickupLocation,
            pickupCriteria,
            dropoffCriteria,
            pickupDate.text,
            returnDate.text,
            pickupTime,
            returnTime,
            days,
            quoteBudget,
            platformMarginPercent,
          );
        } catch (error) {
          console.error(
            "search-api provider failed",
            pickupLocation.partner_id,
            providerErrorCode(error),
          );
          return [];
        }
      },
    );

    const cars = partnerResults
      .flat()
      .slice(0, MAX_RESULTS_PER_SEARCH);

    return jsonResponse(req, {
      success: true,
      cars,
      count: cars.length,
    });
  } catch (error) {
    console.error(
      "search-api",
      error instanceof Error
        ? error.message === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : error.message.startsWith("Nieprawidł")
          || error.message.startsWith("Brak lokalizacji")
          || error.message.startsWith("Wymagane")
          ? "INVALID_REQUEST"
          : "REQUEST_FAILED"
        : "UNKNOWN_ERROR",
    );

    const publicError = publicErrorMessage(error);
    if (publicError.status === 500) {
      return jsonResponse(req, {
        success: false,
        error: "Nie udało się pobrać ofert API",
        cars: [],
        count: 0,
      }, 502);
    }

    return jsonResponse(req, {
      success: false,
      error: publicError.message,
      cars: [],
      count: 0,
    }, publicError.status);
  }
});
