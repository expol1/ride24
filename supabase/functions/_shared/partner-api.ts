import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type PartnerApiCredentials = {
  partner_id: string;
  api_url: string;
  auth_type?: string | null;
  api_key?: string | null;
  api_secret?: string | null;
  username?: string | null;
  password?: string | null;
  bearer_token?: string | null;
  extra_headers?: Record<string, string> | null;
  endpoints?: Record<string, string> | null;
  timeout_ms?: number | null;
};

export type ApiLocation = {
  external_id: string;
  country: string;
  region: string;
  city?: string | null;
  location_name: string;
  type?: string | null;
  extra_fee?: boolean;
  extra_fee_amount?: number | null;
  contact_required?: boolean;
  active?: boolean;
};

export type ApiVehicleGroup = {
  external_id: string;
  class_code: string;
  public_price: number;
  example_model?: string | null;
  model?: string | null;
  transmission?: string | null;
  fuel_type?: string | null;
  seats?: number | null;
  bags?: number | null;
  image?: string | null;
  description?: string | null;
  features?: Record<string, unknown> | null;
  mileage_limit?: number | null;
  deposit_amount?: number | null;
  driver_included?: boolean;
  active?: boolean;
  location_external_ids?: string[] | null;
  quote_reference?: string | null;
  quote_expires_at?: string | null;
  seasonal_prices?: Array<{
    season_type: "LOW" | "MID" | "HIGH";
    start_month: number;
    end_month: number;
    public_price: number;
    active?: boolean;
  }> | null;
};

const MAX_ENDPOINT_LENGTH = 4000;
const MAX_HEADER_COUNT = 50;
const MAX_HEADER_VALUE_LENGTH = 2000;
const MAX_REQUEST_BODY_BYTES = 1_000_000;
const MAX_RESPONSE_BODY_BYTES = 5_000_000;
const MAX_NORMALIZED_ITEMS = 10_000;

const ALLOWED_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const BLOCKED_EXTRA_HEADERS = new Set([
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

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizedHostname(url: URL): string {
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (!host) throw new Error("API URL nie zawiera prawidłowej domeny");
  return host;
}

function parseIpv4(address: string): number[] | null {
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;

  const octets = match.slice(1).map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return octets;
}

function parseIpv6(address: string): number[] | null {
  let input = address.toLowerCase().split("%", 1)[0];
  if (!input || input.includes(":::")) return null;

  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) return null;

    const ipv4 = parseIpv4(input.slice(lastColon + 1));
    if (!ipv4) return null;

    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    input = `${input.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = input.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter(Boolean)
    : [];

  if (doubleColonParts.length === 1 && left.length !== 8) return null;

  const missing = 8 - left.length - right.length;
  if (doubleColonParts.length === 2 && missing < 1) return null;

  const rawWords = doubleColonParts.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;

  if (rawWords.length !== 8) return null;

  const words = rawWords.map((word) => {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return Number.NaN;
    return Number.parseInt(word, 16);
  });

  return words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
    ? null
    : words;
}

function hasIpv6Prefix(
  words: number[],
  prefix: number[],
  prefixLength: number,
): boolean {
  let remaining = prefixLength;

  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const bits = Math.min(16, remaining);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    const expected = prefix[index] || 0;

    if ((words[index] & mask) !== (expected & mask)) return false;
    remaining -= bits;
  }

  return true;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;

  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isBlockedIpv6(words: number[]): boolean {
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (allZero || loopback) return true;

  // IPv4-compatible and IPv4-mapped IPv6 addresses.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    const embeddedIpv4 = [
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ];
    return isBlockedIpv4(embeddedIpv4);
  }

  return hasIpv6Prefix(words, [0x0064, 0xff9b], 96) // NAT64 well-known prefix
    || hasIpv6Prefix(words, [0x0064, 0xff9b, 0x0001], 48) // local-use NAT64
    || hasIpv6Prefix(words, [0x0100], 64) // discard-only
    || hasIpv6Prefix(words, [0x2001], 23) // IETF special-purpose space
    || hasIpv6Prefix(words, [0x2001, 0x0db8], 32) // documentation
    || hasIpv6Prefix(words, [0x2002], 16) // 6to4
    || hasIpv6Prefix(words, [0x3fff], 20) // documentation
    || hasIpv6Prefix(words, [0xfc00], 7) // unique local
    || hasIpv6Prefix(words, [0xfe80], 10) // link-local
    || hasIpv6Prefix(words, [0xfec0], 10) // deprecated site-local
    || hasIpv6Prefix(words, [0xff00], 8); // multicast
}

function isBlockedOrInvalidIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6(normalized);
  if (ipv6) return isBlockedIpv6(ipv6);

  return true;
}

export function assertSafeApiUrl(value: unknown): string {
  const raw = String(value || "").trim();
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("API URL jest nieprawidłowy");
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(
      "API URL musi używać HTTPS i nie może zawierać danych logowania",
    );
  }

  const host = normalizedHostname(url);
  const blockedName = host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".localdomain")
    || host.endsWith(".internal")
    || host.endsWith(".home")
    || host.endsWith(".lan");

  const isIpLiteral = Boolean(parseIpv4(host)) || host.includes(":");
  if (blockedName || (isIpLiteral && isBlockedOrInvalidIp(host))) {
    throw new Error("API URL wskazuje niedozwolony adres prywatny lub specjalny");
  }

  url.hostname = host;
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function assertSafeResolvedApiUrl(
  value: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const safeUrl = assertSafeApiUrl(value);
  const host = normalizedHostname(new URL(safeUrl));

  if (parseIpv4(host) || host.includes(":")) {
    if (isBlockedOrInvalidIp(host)) {
      throw new Error("API URL wskazuje niedozwolony adres prywatny lub specjalny");
    }
    return safeUrl;
  }

  const results = await Promise.allSettled([
    Deno.resolveDns(host, "A", signal ? { signal } : undefined),
    Deno.resolveDns(host, "AAAA", signal ? { signal } : undefined),
  ]);

  if (signal?.aborted) throw new Error("PARTNER_API_ERROR:TIMEOUT");

  const addresses: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") addresses.push(...result.value);
  }

  const uniqueAddresses = Array.from(new Set(addresses));
  if (!uniqueAddresses.length) {
    throw new Error("API URL nie może zostać bezpiecznie rozwiązany w DNS");
  }

  if (uniqueAddresses.some(isBlockedOrInvalidIp)) {
    throw new Error("API URL wskazuje niedozwolony adres prywatny lub specjalny");
  }

  return safeUrl;
}

const DEFAULT_ENDPOINTS = {
  health: "/health",
  locations: "/locations",
  groups: "/vehicle-groups",
  search: "/search",
  booking_create: "/bookings",
  booking_status: "/bookings/{id}",
  booking_cancel: "/bookings/{id}/cancel",
} as const;

export async function loadPartnerCredentials(
  admin: SupabaseClient,
  partnerId: string,
): Promise<PartnerApiCredentials> {
  const normalizedPartnerId = String(partnerId || "").trim();
  if (!normalizedPartnerId) throw new Error("API_NOT_CONFIGURED");

  const { data, error } = await admin
    .from("partner_api_credentials")
    .select(
      "partner_id, api_url, auth_type, api_key, api_secret, username, password, bearer_token, extra_headers, endpoints, timeout_ms",
    )
    .eq("partner_id", normalizedPartnerId)
    .maybeSingle();

  if (error || !data || !data.api_url) {
    throw new Error("API_NOT_CONFIGURED");
  }

  return {
    ...data,
    api_url: assertSafeApiUrl(data.api_url),
  } as PartnerApiCredentials;
}

export function endpointFor(
  credentials: PartnerApiCredentials,
  name: keyof typeof DEFAULT_ENDPOINTS,
  variables: Record<string, string> = {},
): string {
  const configured = credentials.endpoints?.[name];
  let path = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_ENDPOINTS[name];

  if (!path || path.length > MAX_ENDPOINT_LENGTH) {
    throw new Error("Nieprawidłowy endpoint API");
  }

  for (const [key, value] of Object.entries(variables)) {
    const safeKey = String(key).trim();
    if (!safeKey) continue;
    path = path.replaceAll(`{${safeKey}}`, encodeURIComponent(String(value)));
  }

  if (/\{[^{}]+\}/.test(path)) {
    throw new Error("Nieprawidłowy endpoint API: brak wymaganej wartości");
  }

  return path;
}

function buildUrl(baseUrl: string, path: string): string {
  const safeBaseUrl = assertSafeApiUrl(baseUrl);
  const base = new URL(
    safeBaseUrl.endsWith("/") ? safeBaseUrl : `${safeBaseUrl}/`,
  );
  const rawPath = String(path || "").trim();

  if (!rawPath || rawPath.length > MAX_ENDPOINT_LENGTH) {
    throw new Error("Nieprawidłowy endpoint API");
  }

  const relativeOrAbsolute = rawPath.startsWith("//")
    ? rawPath.replace(/^\/+/, "")
    : rawPath.replace(/^\//, "");
  const resolved = new URL(relativeOrAbsolute, base);

  if (
    resolved.origin !== base.origin
    || resolved.username
    || resolved.password
    || resolved.protocol !== "https:"
  ) {
    throw new Error(
      "Nieprawidłowy endpoint API: musi pozostać w tej samej domenie i używać HTTPS",
    );
  }

  resolved.hash = "";
  const result = resolved.toString();
  if (result.length > MAX_ENDPOINT_LENGTH) {
    throw new Error("Nieprawidłowy endpoint API: adres jest zbyt długi");
  }

  return result;
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return btoa(binary);
}

function safeHeaderCredential(value: unknown, max = 8000): string {
  const text = String(value ?? "");
  if (/\r|\n|\0/.test(text) || text.length > max) {
    throw new Error("PARTNER_API_ERROR:INVALID_CREDENTIALS");
  }
  return text;
}

function authHeaders(credentials: PartnerApiCredentials): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });

  const entries = Object.entries(credentials.extra_headers || {}).slice(
    0,
    MAX_HEADER_COUNT,
  );

  for (const [key, value] of entries) {
    const normalizedKey = key.trim();
    const normalizedName = normalizedKey.toLowerCase();

    if (
      typeof value !== "string"
      || !normalizedKey
      || !HEADER_NAME_PATTERN.test(normalizedKey)
      || BLOCKED_EXTRA_HEADERS.has(normalizedName)
      || /\r|\n|\0/.test(value)
    ) {
      continue;
    }

    headers.set(normalizedKey, value.slice(0, MAX_HEADER_VALUE_LENGTH));
  }

  const authType = String(credentials.auth_type || "custom_headers").toLowerCase();

  if (authType === "basic" && credentials.username) {
    const username = safeHeaderCredential(credentials.username);
    const password = safeHeaderCredential(credentials.password || "");
    headers.set(
      "Authorization",
      `Basic ${encodeBase64Utf8(`${username}:${password}`)}`,
    );
  } else if (authType === "bearer" && credentials.bearer_token) {
    headers.set(
      "Authorization",
      `Bearer ${safeHeaderCredential(credentials.bearer_token)}`,
    );
  } else {
    if (credentials.api_key) {
      headers.set("X-API-KEY", safeHeaderCredential(credentials.api_key));
    }
    if (credentials.api_secret) {
      headers.set("X-API-SECRET", safeHeaderCredential(credentials.api_secret));
    }
    if (credentials.username) {
      headers.set("X-API-USER", safeHeaderCredential(credentials.username));
    }
    if (credentials.password) {
      headers.set("X-API-PASSWORD", safeHeaderCredential(credentials.password));
    }
  }

  return headers;
}

function normalizedMethod(value: unknown): string {
  const method = String(value || "GET").trim().toUpperCase();
  if (!ALLOWED_HTTP_METHODS.has(method)) {
    throw new Error("PARTNER_API_ERROR:METHOD_NOT_ALLOWED");
  }
  return method;
}

function serializeRequestBody(body: unknown): string {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new Error("PARTNER_API_ERROR:INVALID_BODY");
  }

  if (serialized === undefined) {
    throw new Error("PARTNER_API_ERROR:INVALID_BODY");
  }

  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new Error("PARTNER_API_ERROR:REQUEST_TOO_LARGE");
  }

  return serialized;
}

async function readResponseTextLimited(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error("PARTNER_API_ERROR:RESPONSE_TOO_LARGE");
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        throw new Error("PARTNER_API_ERROR:RESPONSE_TOO_LARGE");
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function isKnownSafePartnerError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;

  return error.message.startsWith("PARTNER_API_ERROR:")
    || error.message.startsWith("API URL")
    || error.message.startsWith("Nieprawidłowy endpoint API")
    || error.message === "API_NOT_CONFIGURED";
}

export async function partnerApiRequest<T>(
  credentials: PartnerApiCredentials,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = boundedInteger(
    credentials.timeout_ms,
    1000,
    30000,
    10000,
  ) || 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const method = normalizedMethod(options.method);
    if ((method === "GET" || method === "HEAD") && options.body !== undefined) {
      throw new Error("PARTNER_API_ERROR:BODY_NOT_ALLOWED");
    }

    const requestUrl = await assertSafeResolvedApiUrl(
      buildUrl(credentials.api_url, path),
      controller.signal,
    );

    const response = await fetch(requestUrl, {
      method,
      headers: authHeaders(credentials),
      body: options.body === undefined
        ? undefined
        : serializeRequestBody(options.body),
      signal: controller.signal,
      redirect: "error",
    });

    const text = await readResponseTextLimited(response);
    let payload: unknown = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 500) };
      }
    }

    if (!response.ok) {
      throw new Error(`PARTNER_API_ERROR:HTTP:${response.status}`);
    }

    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("PARTNER_API_ERROR:TIMEOUT");
    }

    if (isKnownSafePartnerError(error)) throw error;
    throw new Error("PARTNER_API_ERROR:NETWORK");
  } finally {
    clearTimeout(timeout);
  }
}

function finiteNumber(
  value: unknown,
  fallback: number | null = null,
): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedText(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (!["string", "number", "bigint"].includes(typeof value)) return null;

  const text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

  return text || null;
}

function safeHttpsImage(value: unknown): string | null {
  const text = boundedText(value, 2000);
  if (!text) return null;

  try {
    return assertSafeApiUrl(text);
  } catch {
    return null;
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number | null = null,
): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function boundedNonNegativeNumber(
  value: unknown,
  maximum = 1_000_000_000,
  fallback = 0,
): number {
  const number = finiteNumber(value, fallback) ?? fallback;
  return Math.max(0, Math.min(maximum, number));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueByExternalId<T extends { external_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    if (seen.has(item.external_id)) continue;
    seen.add(item.external_id);
    output.push(item);
  }

  return output;
}

export function sanitizePartnerPayload(
  value: unknown,
  maxChars = 12000,
): unknown {
  const safeMaxChars = boundedInteger(maxChars, 1000, 100_000, 12000) || 12000;
  const secretKeys = /(password|passwd|secret|token|authorization|api[_-]?key|credential|cookie|session|private[_-]?key|access[_-]?key)/i;
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 5) return "[MAX_DEPTH]";
    if (input == null || typeof input === "boolean" || typeof input === "number") {
      return input;
    }
    if (typeof input === "string") return input.slice(0, 2000);
    if (typeof input === "bigint") return input.toString();
    if (Array.isArray(input)) {
      return input.slice(0, 100).map((entry) => walk(entry, depth + 1));
    }
    if (typeof input === "object") {
      if (seen.has(input as object)) return "[CIRCULAR]";
      seen.add(input as object);

      const output: Record<string, unknown> = Object.create(null);
      for (const [rawKey, entry] of Object.entries(
        input as Record<string, unknown>,
      ).slice(0, 100)) {
        const key = rawKey.slice(0, 200);
        if (!key || BLOCKED_OBJECT_KEYS.has(key)) continue;
        output[key] = secretKeys.test(key)
          ? "[REDACTED]"
          : walk(entry, depth + 1);
      }
      return output;
    }

    return String(input).slice(0, 500);
  };

  const sanitized = walk(value, 0);
  const encoded = JSON.stringify(sanitized);
  if (encoded.length <= safeMaxChars) return sanitized;

  return {
    truncated: true,
    preview: encoded.slice(0, safeMaxChars),
  };
}

export function normalizeLocations(payload: unknown): ApiLocation[] {
  const payloadRecord = asRecord(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payloadRecord?.locations)
    ? payloadRecord.locations
    : [];

  const normalized = source.slice(0, MAX_NORMALIZED_ITEMS).flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];

    const externalId = boundedText(item.external_id ?? item.id, 200) || "";
    const country = boundedText(item.country, 100) || "";
    const region = boundedText(item.region ?? item.country, 150) || "";
    const locationName = boundedText(item.location_name ?? item.name, 250) || "";

    if (!externalId || !country || !region || !locationName) return [];

    return [{
      external_id: externalId,
      country,
      region,
      city: boundedText(item.city, 150),
      location_name: locationName,
      type: boundedText(item.type, 30),
      extra_fee: item.extra_fee === true,
      extra_fee_amount: boundedNonNegativeNumber(item.extra_fee_amount),
      contact_required: item.contact_required === true,
      active: item.active !== false,
    } satisfies ApiLocation];
  });

  return uniqueByExternalId(normalized);
}

export function normalizeGroups(payload: unknown): ApiVehicleGroup[] {
  const payloadRecord = asRecord(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payloadRecord?.groups)
    ? payloadRecord.groups
    : Array.isArray(payloadRecord?.cars)
    ? payloadRecord.cars
    : [];

  const normalized = source.slice(0, MAX_NORMALIZED_ITEMS).flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];

    const rawLocations = Array.isArray(item.location_external_ids)
      ? item.location_external_ids
      : Array.isArray(item.locations)
      ? item.locations.map((entry) => {
        const location = asRecord(entry);
        return location
          ? location.external_id ?? location.id ?? ""
          : entry;
      })
      : null;

    const locations = rawLocations
      ? Array.from(
        new Set(
          rawLocations
            .slice(0, 100)
            .map((entry) => boundedText(entry, 200))
            .filter((entry): entry is string => Boolean(entry)),
        ),
      )
      : null;

    const seasonal = Array.isArray(item.seasonal_prices)
      ? item.seasonal_prices.slice(0, 36).flatMap((entry) => {
        const season = asRecord(entry);
        if (!season) return [];

        const seasonType = String(season.season_type || "MID").toUpperCase();
        const startMonth = Number(season.start_month);
        const endMonth = Number(season.end_month);
        const publicPrice = Number(season.public_price);

        if (
          !["LOW", "MID", "HIGH"].includes(seasonType)
          || !Number.isInteger(startMonth)
          || startMonth < 1
          || startMonth > 12
          || !Number.isInteger(endMonth)
          || endMonth < 1
          || endMonth > 12
          || !Number.isFinite(publicPrice)
          || publicPrice <= 0
          || publicPrice > 1_000_000_000
        ) {
          return [];
        }

        return [{
          season_type: seasonType as "LOW" | "MID" | "HIGH",
          start_month: startMonth,
          end_month: endMonth,
          public_price: publicPrice,
          active: season.active !== false,
        }];
      })
      : null;

    const externalId = boundedText(item.external_id ?? item.id, 200) || "";
    const classCode = (
      boundedText(item.class_code ?? item.group_code ?? item.category, 10) || ""
    ).toUpperCase();
    const publicPrice = Number(
      item.public_price ?? item.price_per_day ?? item.price ?? 0,
    );

    if (
      !externalId
      || !/^[A-Z]$/.test(classCode)
      || !Number.isFinite(publicPrice)
      || publicPrice <= 0
      || publicPrice > 1_000_000_000
    ) {
      return [];
    }

    const sanitizedFeatures = sanitizePartnerPayload(
      asRecord(item.features) || {},
      4000,
    );

    return [{
      external_id: externalId,
      class_code: classCode,
      public_price: publicPrice,
      example_model: boundedText(item.example_model ?? item.model, 250),
      model: boundedText(item.model ?? item.example_model, 250),
      transmission: boundedText(item.transmission, 50),
      fuel_type: boundedText(item.fuel_type, 50),
      seats: boundedInteger(item.seats, 1, 99),
      bags: boundedInteger(item.bags, 0, 99),
      image: safeHttpsImage(item.image),
      description: boundedText(item.description, 2000),
      features: asRecord(sanitizedFeatures) || {},
      mileage_limit: boundedNonNegativeNumber(item.mileage_limit),
      deposit_amount: boundedNonNegativeNumber(item.deposit_amount),
      driver_included: item.driver_included === true,
      active: item.available === false ? false : item.active !== false,
      location_external_ids: locations,
      quote_reference: boundedText(item.quote_reference ?? item.quote_id, 500),
      quote_expires_at: boundedText(item.quote_expires_at ?? item.expires_at, 80),
      seasonal_prices: seasonal,
    } satisfies ApiVehicleGroup];
  });

  return uniqueByExternalId(normalized);
}
