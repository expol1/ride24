import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  requireAdmin,
} from "../_shared/ride24-security.ts";
import {
  assertSafeApiUrl,
  endpointFor,
  normalizeGroups,
  normalizeLocations,
  partnerApiRequest,
  type PartnerApiCredentials,
} from "../_shared/partner-api.ts";

type AdminClient = Awaited<ReturnType<typeof requireAdmin>>["admin"];
type Action = "get" | "save" | "test" | "sync" | "activate" | "deactivate";

type RequestBody = {
  action?: unknown;
  partner_id?: unknown;
  provider?: unknown;
  api_url?: unknown;
  auth_type?: unknown;
  api_key?: unknown;
  api_secret?: unknown;
  username?: unknown;
  password?: unknown;
  bearer_token?: unknown;
  endpoints?: unknown;
  extra_headers?: unknown;
  timeout_ms?: unknown;
  discount_percent?: unknown;
  currency?: unknown;
};

type PartnerRow = {
  id: string;
  company_name: string | null;
  provider_type: string | null;
  api_provider: string | null;
  api_enabled: boolean | null;
  api_status: string | null;
  api_last_test_at: string | null;
  api_last_sync_at: string | null;
  api_last_error: string | null;
  discount_percent: number | string | null;
  currency: string | null;
  active: boolean | null;
  account_status: string | null;
};

type CredentialsRow = PartnerApiCredentials & {
  last_test_at?: string | null;
  last_test_ok?: boolean | null;
  last_sync_at?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
};

const MAX_REQUEST_BYTES = 65_536;
const MAX_SECRET_LENGTH = 4_000;
const MAX_USERNAME_LENGTH = 500;
const MAX_API_URL_LENGTH = 2_000;
const MAX_ENDPOINT_LENGTH = 1_000;
const MAX_HEADER_VALUE_LENGTH = 2_000;
const MAX_SYNC_ITEMS = 10_000;
const MAX_SEASONAL_ROWS = 20_000;
const UPSERT_BATCH_SIZE = 400;

const ACTIONS = new Set<Action>([
  "get",
  "save",
  "test",
  "sync",
  "activate",
  "deactivate",
]);
const PROVIDERS = new Set(["ride24_standard_v1", "custom"]);
const AUTH_TYPES = new Set(["custom_headers", "basic", "bearer"]);
const ENDPOINT_NAMES = new Set([
  "health",
  "locations",
  "groups",
  "search",
  "booking_create",
  "booking_status",
  "booking_cancel",
]);
const LOCATION_TYPES = new Set(["airport", "city", "hotel", "office", "custom"]);
const BLOCKED_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!reader) throw new Error("Wymagane dane wejściowe");

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

function cleanAction(value: unknown): Action {
  const action = String(value || "get").trim().toLowerCase() as Action;
  if (!ACTIONS.has(action)) throw new Error("Nieznana akcja");
  return action;
}

function cleanEnum(value: unknown, allowed: Set<string>, message: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) throw new Error(message);
  return normalized;
}

function cleanRequiredApiUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Nieprawidłowy API URL");
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_API_URL_LENGTH) {
    throw new Error("Nieprawidłowy API URL");
  }
  return assertSafeApiUrl(normalized);
}

function cleanOptionalSecret(
  value: unknown,
  maxLength = MAX_SECRET_LENGTH,
): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Nieprawidłowa konfiguracja API");

  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || /[\u0000\r\n]/.test(normalized)) {
    throw new Error("Nieprawidłowa konfiguracja API");
  }
  return normalized;
}

function cleanTimeout(value: unknown, fallback: unknown): number {
  const number = Number(value ?? fallback ?? 10_000);
  if (!Number.isFinite(number) || number < 1_000 || number > 30_000) {
    throw new Error("Nieprawidłowy limit czasu API");
  }
  return Math.round(number);
}

function cleanDiscount(value: unknown, fallback: unknown): number {
  const number = Number(value ?? fallback ?? 15);
  if (!Number.isFinite(number) || number < 0 || number > 50) {
    throw new Error("Nieprawidłowy rabat partnera");
  }
  return Math.round(number * 100) / 100;
}

function cleanCurrency(value: unknown, fallback: unknown): string {
  const raw = String(value ?? fallback ?? "EUR").trim().toUpperCase();
  const currency = raw === "TRL" ? "TRY" : raw;
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Waluta operacyjna musi mieć trzyznakowy kod ISO, np. TRY lub EGP");
  }
  return currency;
}

function cleanEndpoints(value: unknown, apiUrl: string): Record<string, string> {
  if (!isRecord(value)) throw new Error("Nieprawidłowa konfiguracja endpointów API");

  const entries = Object.entries(value);
  if (entries.length > ENDPOINT_NAMES.size) {
    throw new Error("Nieprawidłowa konfiguracja endpointów API");
  }

  const output: Record<string, string> = Object.create(null);
  const base = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);

  for (const [rawName, rawPath] of entries) {
    const name = rawName.trim();
    if (
      BLOCKED_OBJECT_KEYS.has(name)
      || !ENDPOINT_NAMES.has(name)
      || typeof rawPath !== "string"
    ) {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    const path = rawPath.trim();
    if (
      !path
      || path.length > MAX_ENDPOINT_LENGTH
      || /[\u0000\r\n\\]/.test(path)
      || path.startsWith("//")
    ) {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    let resolved: URL;
    try {
      resolved = new URL(path.replace(/^\//, ""), base);
    } catch {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    if (
      resolved.protocol !== "https:"
      || resolved.origin !== base.origin
      || resolved.username
      || resolved.password
    ) {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    output[name] = path;
  }

  return output;
}

function cleanExtraHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Nieprawidłowa konfiguracja nagłówków API");

  const entries = Object.entries(value);
  if (entries.length > 30) throw new Error("Nieprawidłowa konfiguracja nagłówków API");

  const output: Record<string, string> = Object.create(null);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    const normalizedName = name.toLowerCase();

    if (
      BLOCKED_OBJECT_KEYS.has(name)
      || !name
      || !HEADER_NAME_PATTERN.test(name)
      || BLOCKED_HEADER_NAMES.has(normalizedName)
      || typeof rawValue !== "string"
      || rawValue.length > MAX_HEADER_VALUE_LENGTH
      || /[\u0000\r\n]/.test(rawValue)
    ) {
      throw new Error("Nieprawidłowa konfiguracja nagłówków API");
    }

    output[name] = rawValue;
  }

  return output;
}

function masked(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function safeStoredError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return normalized || null;
}

function statusMessageForError(error: unknown, operation: "test" | "sync"): string {
  const message = error instanceof Error ? error.message : "";

  if (message === "PARTNER_API_ERROR:TIMEOUT") {
    return "Przekroczono limit czasu połączenia z API partnera";
  }
  if (message.startsWith("PARTNER_API_ERROR:HTTP:")) {
    return "API partnera zwróciło błąd HTTP";
  }
  if (message === "API_NOT_CONFIGURED") {
    return "Brak kompletnej konfiguracji API partnera";
  }
  if (message.startsWith("API URL") || message.startsWith("Nieprawidłowy endpoint API")) {
    return safeStoredError(message) || "Nieprawidłowa konfiguracja API partnera";
  }

  return operation === "test"
    ? "Błąd komunikacji z API partnera"
    : "Błąd synchronizacji danych partnera API";
}

function safeMetadata(
  credentials: Partial<CredentialsRow> | null,
  partner: PartnerRow,
): Record<string, unknown> {
  return {
    configured: Boolean(credentials?.api_url),
    provider: partner.api_provider || "custom",
    api_url: credentials?.api_url || "",
    auth_type: credentials?.auth_type || "custom_headers",
    api_key_configured: masked(credentials?.api_key),
    api_secret_configured: masked(credentials?.api_secret),
    username_configured: masked(credentials?.username),
    password_configured: masked(credentials?.password),
    bearer_token_configured: masked(credentials?.bearer_token),
    endpoints: isRecord(credentials?.endpoints) ? credentials?.endpoints : {},
    extra_headers_configured: isRecord(credentials?.extra_headers)
      && Object.keys(credentials.extra_headers).length > 0,
    timeout_ms: Number(credentials?.timeout_ms || 10_000),
    discount_percent: Number(partner.discount_percent ?? 15),
    currency: String(partner.currency || "EUR"),
    api_enabled: partner.api_enabled === true,
    api_status: partner.api_status || "draft",
    api_last_test_at: partner.api_last_test_at || null,
    api_last_sync_at: partner.api_last_sync_at || null,
    api_last_error: safeStoredError(partner.api_last_error),
  };
}

async function getPartner(admin: AdminClient, partnerId: string): Promise<PartnerRow> {
  const { data, error } = await admin
    .from("partners")
    .select(
      "id, company_name, provider_type, api_provider, api_enabled, api_status, api_last_test_at, api_last_sync_at, api_last_error, discount_percent, currency, active, account_status",
    )
    .eq("id", partnerId)
    .maybeSingle();

  if (error) throw new Error("Nie udało się odczytać partnera");
  if (!data) throw new Error("Partner nie istnieje");
  if (data.provider_type !== "api") {
    throw new Error("Wybrany partner nie jest partnerem API");
  }

  return data as PartnerRow;
}

async function getCredentials(
  admin: AdminClient,
  partnerId: string,
): Promise<CredentialsRow | null> {
  const { data, error } = await admin
    .from("partner_api_credentials")
    .select(
      "partner_id, api_url, auth_type, api_key, api_secret, username, password, bearer_token, extra_headers, endpoints, timeout_ms, last_test_at, last_test_ok, last_sync_at, last_error, updated_at",
    )
    .eq("partner_id", partnerId)
    .maybeSingle();

  if (error) throw new Error("Nie udało się odczytać konfiguracji API");
  return data as CredentialsRow | null;
}

function credentialsForRequest(row: CredentialsRow | null): PartnerApiCredentials {
  if (!row?.api_url) throw new Error("API_NOT_CONFIGURED");
  return {
    partner_id: row.partner_id,
    api_url: assertSafeApiUrl(row.api_url),
    auth_type: row.auth_type || "custom_headers",
    api_key: row.api_key || null,
    api_secret: row.api_secret || null,
    username: row.username || null,
    password: row.password || null,
    bearer_token: row.bearer_token || null,
    extra_headers: isRecord(row.extra_headers) ? row.extra_headers as Record<string, string> : {},
    endpoints: isRecord(row.endpoints) ? row.endpoints as Record<string, string> : {},
    timeout_ms: Number(row.timeout_ms || 10_000),
  };
}

async function restoreCredentials(
  admin: AdminClient,
  partnerId: string,
  previous: CredentialsRow | null,
): Promise<void> {
  if (!previous) {
    await admin.from("partner_api_credentials").delete().eq("partner_id", partnerId);
    return;
  }

  await admin.from("partner_api_credentials").upsert({
    partner_id: previous.partner_id,
    api_url: previous.api_url,
    auth_type: previous.auth_type,
    api_key: previous.api_key,
    api_secret: previous.api_secret,
    username: previous.username,
    password: previous.password,
    bearer_token: previous.bearer_token,
    extra_headers: previous.extra_headers || {},
    endpoints: previous.endpoints || {},
    timeout_ms: previous.timeout_ms || 10_000,
    last_test_at: previous.last_test_at || null,
    last_test_ok: previous.last_test_ok === true,
    last_sync_at: previous.last_sync_at || null,
    last_error: previous.last_error || null,
    updated_at: previous.updated_at || new Date().toISOString(),
  }, { onConflict: "partner_id" });
}

async function saveConfiguration(
  admin: AdminClient,
  partner: PartnerRow,
  body: RequestBody,
): Promise<void> {
  const previousCredentials = await getCredentials(admin, partner.id);
  const apiUrl = cleanRequiredApiUrl(body.api_url);
  const provider = cleanEnum(
    body.provider ?? partner.api_provider ?? "custom",
    PROVIDERS,
    "Nieprawidłowy dostawca API",
  );
  const authType = cleanEnum(
    body.auth_type ?? previousCredentials?.auth_type ?? "custom_headers",
    AUTH_TYPES,
    "Nieprawidłowy typ autoryzacji API",
  );
  const discount = cleanDiscount(body.discount_percent, partner.discount_percent);
  const currency = cleanCurrency(body.currency, partner.currency);
  const previousCurrency = cleanCurrency(partner.currency, "EUR");
  const timeoutMs = cleanTimeout(body.timeout_ms, previousCredentials?.timeout_ms);
  const now = new Date().toISOString();

  const incomingApiKey = cleanOptionalSecret(body.api_key);
  const incomingApiSecret = cleanOptionalSecret(body.api_secret);
  const incomingUsername = cleanOptionalSecret(body.username, MAX_USERNAME_LENGTH);
  const incomingPassword = cleanOptionalSecret(body.password);
  const incomingBearer = cleanOptionalSecret(body.bearer_token);

  const endpoints = body.endpoints === undefined
    ? (isRecord(previousCredentials?.endpoints) ? previousCredentials.endpoints : {})
    : cleanEndpoints(body.endpoints, apiUrl);
  const extraHeaders = body.extra_headers === undefined
    ? (isRecord(previousCredentials?.extra_headers) ? previousCredentials.extra_headers : {})
    : cleanExtraHeaders(body.extra_headers);

  const credentialsPayload = {
    partner_id: partner.id,
    api_url: apiUrl,
    auth_type: authType,
    api_key: incomingApiKey ?? previousCredentials?.api_key ?? null,
    api_secret: incomingApiSecret ?? previousCredentials?.api_secret ?? null,
    username: incomingUsername ?? previousCredentials?.username ?? null,
    password: incomingPassword ?? previousCredentials?.password ?? null,
    bearer_token: incomingBearer ?? previousCredentials?.bearer_token ?? null,
    endpoints,
    extra_headers: extraHeaders,
    timeout_ms: timeoutMs,
    last_test_at: null,
    last_test_ok: false,
    last_sync_at: null,
    last_error: null,
    updated_at: now,
  };

  const { error: credentialsError } = await admin
    .from("partner_api_credentials")
    .upsert(credentialsPayload, { onConflict: "partner_id" });
  if (credentialsError) throw new Error("Nie udało się zapisać konfiguracji API");

  const { error: partnerError } = await admin.from("partners").update({
    api_provider: provider,
    api_enabled: false,
    api_status: "configured",
    api_last_test_at: null,
    api_last_sync_at: null,
    api_last_error: null,
    discount_percent: discount,
    currency,
    api_settings: { configured: true, status: "configured" },
  }).eq("id", partner.id);

  if (partnerError) {
    await restoreCredentials(admin, partner.id, previousCredentials).catch(() => undefined);
    throw new Error("Nie udało się zapisać konfiguracji partnera");
  }

  if (currency !== previousCurrency) {
    const { error: quoteExpiryError } = await admin.from("api_quotes")
      .update({ expires_at: now })
      .eq("partner_id", partner.id)
      .is("used_at", null)
      .is("booking_id", null)
      .gt("expires_at", now);
    if (quoteExpiryError) {
      throw new Error("Waluta została zapisana, ale nie udało się wygasić starych wycen API");
    }
  }
}

async function updateFailureState(
  admin: AdminClient,
  partnerId: string,
  message: string,
  operation: "test" | "sync",
  disableApi: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const credentialPatch = operation === "test"
    ? {
      last_test_at: now,
      last_test_ok: false,
      last_error: message,
      updated_at: now,
    }
    : {
      last_error: message,
      updated_at: now,
    };

  const partnerPatch: Record<string, unknown> = {
    api_status: "error",
    api_last_error: message,
    api_settings: { configured: true, status: "error" },
  };
  if (operation === "test") partnerPatch.api_last_test_at = now;
  if (disableApi) partnerPatch.api_enabled = false;

  await admin.from("partner_api_credentials").update(credentialPatch).eq("partner_id", partnerId);
  await admin.from("partners").update(partnerPatch).eq("id", partnerId);
}

async function testConnection(
  admin: AdminClient,
  partnerId: string,
): Promise<void> {
  try {
    const snapshot = await getCredentials(admin, partnerId);
    const credentials = credentialsForRequest(snapshot);
    const snapshotVersion = snapshot?.updated_at;
    if (!snapshotVersion) throw new Error("Nieprawidłowy stan konfiguracji API");

    await partnerApiRequest<unknown>(credentials, endpointFor(credentials, "health"));

    const now = new Date().toISOString();
    const { data: updatedCredentials, error: credentialsError } = await admin
      .from("partner_api_credentials")
      .update({
        last_test_at: now,
        last_test_ok: true,
        last_error: null,
        updated_at: now,
      })
      .eq("partner_id", partnerId)
      .eq("updated_at", snapshotVersion)
      .select("partner_id")
      .maybeSingle();
    if (credentialsError) throw new Error("Nie udało się zapisać wyniku testu API");
    if (!updatedCredentials) {
      throw new Error("Nieprawidłowy stan konfiguracji API. Powtórz test");
    }

    const { error: partnerError } = await admin.from("partners").update({
      api_enabled: false,
      api_status: "tested",
      api_last_test_at: now,
      api_last_error: null,
      api_settings: { configured: true, status: "tested" },
    }).eq("id", partnerId);
    if (partnerError) throw new Error("Nie udało się zapisać wyniku testu partnera");
  } catch (error) {
    const message = statusMessageForError(error, "test");
    await updateFailureState(admin, partnerId, message, "test", true).catch(() => undefined);
    throw error;
  }
}

async function upsertBatches(
  admin: AdminClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + UPSERT_BATCH_SIZE);
    const { error } = await admin.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`Nie udało się zapisać danych synchronizacji: ${table}`);
  }
}

async function upsertCarClassBatches(
  admin: AdminClient,
  rows: Record<string, unknown>[],
): Promise<Map<string, string>> {
  const byExternalId = new Map<string, string>();

  for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + UPSERT_BATCH_SIZE);
    const { data, error } = await admin
      .from("car_classes")
      .upsert(batch, { onConflict: "partner_id,external_id" })
      .select("id, external_id");

    if (error) throw new Error("Nie udało się zapisać grup pojazdów API");
    for (const row of data || []) {
      if (typeof row.external_id === "string" && typeof row.id === "string") {
        byExternalId.set(row.external_id, row.id);
      }
    }
  }

  return byExternalId;
}

async function saveSeasonalPrice(
  admin: AdminClient,
  row: Record<string, unknown>,
): Promise<void> {
  const { data: existing, error: lookupError } = await admin
    .from("seasonal_prices")
    .select("id")
    .eq("car_class_id", row.car_class_id)
    .eq("season_type", row.season_type)
    .eq("start_month", row.start_month)
    .eq("end_month", row.end_month)
    .limit(1)
    .maybeSingle();

  if (lookupError) throw new Error("Nie udało się odczytać ceny sezonowej");

  if (existing?.id) {
    const { error } = await admin
      .from("seasonal_prices")
      .update({ public_price: row.public_price, active: row.active })
      .eq("id", existing.id);
    if (error) throw new Error("Nie udało się zaktualizować ceny sezonowej");
    return;
  }

  const { error } = await admin.from("seasonal_prices").insert(row);
  if (error) throw new Error("Nie udało się zapisać ceny sezonowej");
}

async function syncPartner(
  admin: AdminClient,
  partner: PartnerRow,
): Promise<{ locations: number; groups: number; seasonal_prices: number }> {
  const credentialsRow = await getCredentials(admin, partner.id);
  if (credentialsRow?.last_test_ok !== true) {
    throw new Error("Najpierw wykonaj poprawny test połączenia");
  }
  const snapshotVersion = credentialsRow.updated_at;
  if (!snapshotVersion) throw new Error("Nieprawidłowy stan konfiguracji API");

  try {
    const credentials = credentialsForRequest(credentialsRow);
    const locationsPayload = await partnerApiRequest<unknown>(
      credentials,
      endpointFor(credentials, "locations"),
    );
    const groupsPayload = await partnerApiRequest<unknown>(
      credentials,
      endpointFor(credentials, "groups"),
    );

    const locations = normalizeLocations(locationsPayload);
    const groups = normalizeGroups(groupsPayload);

    if (!locations.length) throw new Error("API nie zwróciło poprawnych lokalizacji");
    if (!groups.length) throw new Error("API nie zwróciło poprawnych grup pojazdów");
    if (locations.length > MAX_SYNC_ITEMS || groups.length > MAX_SYNC_ITEMS) {
      throw new Error("API zwróciło zbyt dużo danych do bezpiecznej synchronizacji");
    }

    const seasonalRowsCount = groups.reduce(
      (sum, group) => sum + (group.seasonal_prices?.length || 0),
      0,
    );
    if (seasonalRowsCount > MAX_SEASONAL_ROWS) {
      throw new Error("API zwróciło zbyt dużo cen sezonowych");
    }

    const locationRows = locations.map((location) => ({
      partner_id: partner.id,
      external_id: location.external_id,
      is_api_managed: true,
      country: location.country,
      region: location.region,
      city: location.city || null,
      location_name: location.location_name,
      type: LOCATION_TYPES.has(String(location.type || "").toLowerCase())
        ? String(location.type).toLowerCase()
        : "city",
      extra_fee: location.extra_fee === true,
      extra_fee_amount: location.extra_fee_amount ?? null,
      contact_required: location.contact_required === true,
      active: location.active !== false,
    }));

    const groupRows = groups.map((group) => ({
      partner_id: partner.id,
      external_id: group.external_id,
      is_api_managed: true,
      class_code: group.class_code,
      public_price: group.public_price,
      example_model: group.example_model || group.model || null,
      model: group.model || group.example_model || null,
      transmission: group.transmission || null,
      fuel_type: group.fuel_type || null,
      seats: group.seats ?? 5,
      bags: group.bags ?? 2,
      image: group.image || null,
      description: group.description || group.example_model || group.class_code,
      features: {
        ...(group.features || {}),
        api_location_external_ids: group.location_external_ids || [],
      },
      mileage_limit: group.mileage_limit ?? null,
      deposit_amount: group.deposit_amount ?? 0,
      driver_included: group.driver_included === true,
      active: group.active !== false,
    }));

    // Synchronizacja jest wyłącznie add/update. Brakujące rekordy nie są
    // automatycznie usuwane ani wyłączane po chwilowej awarii zewnętrznego API.
    await upsertBatches(
      admin,
      "partner_locations",
      locationRows,
      "partner_id,external_id",
    );
    const carClassIds = await upsertCarClassBatches(admin, groupRows);

    let seasonalCount = 0;
    for (const group of groups) {
      const carClassId = carClassIds.get(group.external_id);
      if (!carClassId || !group.seasonal_prices?.length) continue;

      for (const season of group.seasonal_prices) {
        await saveSeasonalPrice(admin, {
          car_class_id: carClassId,
          season_type: season.season_type,
          start_month: season.start_month,
          end_month: season.end_month,
          public_price: season.public_price,
          active: season.active !== false,
        });
        seasonalCount += 1;
      }
    }

    const now = new Date().toISOString();
    const { data: updatedCredentials, error: credentialsUpdateError } = await admin
      .from("partner_api_credentials")
      .update({
        last_sync_at: now,
        last_error: null,
        updated_at: now,
      })
      .eq("partner_id", partner.id)
      .eq("updated_at", snapshotVersion)
      .select("partner_id")
      .maybeSingle();
    if (credentialsUpdateError) {
      throw new Error("Nie udało się zapisać wyniku synchronizacji API");
    }
    if (!updatedCredentials) {
      throw new Error("Nieprawidłowy stan konfiguracji API. Powtórz synchronizację");
    }

    const { data: currentPartner, error: partnerStateError } = await admin
      .from("partners")
      .select("api_enabled")
      .eq("id", partner.id)
      .maybeSingle();
    if (partnerStateError || !currentPartner) {
      throw new Error("Nie udało się odczytać stanu partnera API");
    }
    const nextStatus = currentPartner.api_enabled === true ? "active" : "synced";

    const { error: partnerUpdateError } = await admin.from("partners").update({
      api_status: nextStatus,
      api_last_sync_at: now,
      api_last_error: null,
      api_settings: { configured: true, status: nextStatus },
    }).eq("id", partner.id);
    if (partnerUpdateError) {
      throw new Error("Nie udało się zapisać wyniku synchronizacji partnera");
    }

    return {
      locations: locations.length,
      groups: groups.length,
      seasonal_prices: seasonalCount,
    };
  } catch (error) {
    const message = statusMessageForError(error, "sync");
    await updateFailureState(admin, partner.id, message, "sync", false).catch(() => undefined);
    throw error;
  }
}

async function activatePartner(admin: AdminClient, partner: PartnerRow): Promise<void> {
  const credentials = await getCredentials(admin, partner.id);
  if (!credentials?.api_url) throw new Error("Brak kompletnej konfiguracji API partnera");
  if (credentials.last_test_ok !== true || !credentials.last_sync_at) {
    throw new Error("Najpierw wykonaj poprawny test i synchronizację");
  }

  const { error } = await admin.from("partners").update({
    api_enabled: true,
    api_status: "active",
    api_last_error: null,
    api_settings: { configured: true, status: "active" },
  }).eq("id", partner.id);
  if (error) throw new Error("Nie udało się aktywować partnera API");
}

async function deactivatePartner(admin: AdminClient, partnerId: string): Promise<void> {
  const { error } = await admin.from("partners").update({
    api_enabled: false,
    api_status: "disabled",
    api_last_error: null,
    api_settings: { configured: true, status: "disabled" },
  }).eq("id", partnerId);
  if (error) throw new Error("Nie udało się wyłączyć partnera API");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const { admin } = await requireAdmin(req);
    const body = await readJsonObject(req) as RequestBody;
    const action = cleanAction(body.action);

    if (!isUuid(body.partner_id)) {
      return jsonResponse(req, { error: "Nieprawidłowy partner_id" }, 400);
    }

    const partner = await getPartner(admin, body.partner_id);

    if (action === "get") {
      const credentials = await getCredentials(admin, partner.id);
      return jsonResponse(req, {
        success: true,
        partner: {
          id: partner.id,
          company_name: partner.company_name,
        },
        config: safeMetadata(credentials, partner),
      });
    }

    if (action === "save") {
      await saveConfiguration(admin, partner, body);
      return jsonResponse(req, {
        success: true,
        message: "Konfiguracja została bezpiecznie zapisana",
      });
    }

    if (action === "test") {
      await testConnection(admin, partner.id);
      return jsonResponse(req, {
        success: true,
        message: "Połączenie poprawne",
      });
    }

    if (action === "sync") {
      const result = await syncPartner(admin, partner);
      return jsonResponse(req, {
        success: true,
        result,
        message: "Lokalizacje i grupy zostały zsynchronizowane",
      });
    }

    if (action === "activate") {
      await activatePartner(admin, partner);
      return jsonResponse(req, {
        success: true,
        message: "Partner API został aktywowany",
      });
    }

    await deactivatePartner(admin, partner.id);
    return jsonResponse(req, {
      success: true,
      message: "Partner API został wyłączony",
    });
  } catch (error) {
    console.error(
      "api-partner-admin",
      error instanceof Error
        ? error.message.startsWith("PARTNER_API_ERROR:")
          ? error.message.slice(0, 100)
          : "REQUEST_FAILED"
        : "UNKNOWN_ERROR",
    );
    const publicError = publicErrorMessage(error);
    return jsonResponse(req, { error: publicError.message }, publicError.status);
  }
});
