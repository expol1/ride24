import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  escapeHtml,
  jsonResponse,
  publicErrorMessage,
  requireAdmin,
} from "../_shared/ride24-security.ts";
import { assertSafeApiUrl } from "../_shared/partner-api.ts";

type AdminClient = Awaited<ReturnType<typeof requireAdmin>>["admin"];

type ApiSettingsInput = {
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
};

type ParsedPartnerInput = {
  email: string;
  password: string;
  companyName: string;
  representativeName: string | null;
  representativeSurname: string | null;
  country: string | null;
  region: string | null;
  phone: string | null;
  currency: "EUR" | "USD" | "PLN";
  discountPercent: number;
  providerType: "local" | "api";
  apiProvider: "ride24_standard_v1" | "custom" | null;
  apiSettings: {
    apiUrl: string | null;
    authType: "custom_headers" | "basic" | "bearer";
    apiKey: string | null;
    apiSecret: string | null;
    username: string | null;
    password: string | null;
    bearerToken: string | null;
    endpoints: Record<string, string>;
    extraHeaders: Record<string, string>;
    timeoutMs: number;
  } | null;
};

const MAX_REQUEST_BYTES = 32_768;
const MAX_API_URL_LENGTH = 2_000;
const MAX_SECRET_LENGTH = 4_000;
const MAX_HEADER_VALUE_LENGTH = 2_000;

const CURRENCIES = new Set(["EUR", "USD", "PLN"]);
const PROVIDER_TYPES = new Set(["local", "api"]);
const API_PROVIDERS = new Set(["ride24_standard_v1", "custom"]);
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
  if (!reader) throw new Error("Wymagane dane partnera");

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

function cleanText(
  value: unknown,
  maxLength: number,
  errorMessage: string,
  required = false,
): string | null {
  if (value == null || value === "") {
    if (required) throw new Error(errorMessage);
    return null;
  }
  if (typeof value !== "string") throw new Error(errorMessage);

  const text = value.trim();
  if (!text) {
    if (required) throw new Error(errorMessage);
    return null;
  }
  if (text.length > maxLength || /[\u0000-\u001F\u007F]/.test(text)) {
    throw new Error(errorMessage);
  }
  return text;
}

function cleanEmail(value: unknown): string {
  const email = cleanText(value, 254, "Podaj poprawny e-mail", true)!
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Podaj poprawny e-mail");
  }
  return email;
}

function cleanTemporaryPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Nieprawidłowe hasło tymczasowe");
  }
  if (
    value.length < 10
    || value.length > 128
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new Error("Nieprawidłowe hasło tymczasowe");
  }
  return value;
}

function cleanSecret(value: unknown, maxLength = MAX_SECRET_LENGTH): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Nieprawidłowa konfiguracja API");

  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength || /[\u0000\r\n]/.test(normalized)) {
    throw new Error("Nieprawidłowa konfiguracja API");
  }
  return normalized;
}

function cleanDiscount(value: unknown): number {
  const number = Number(value ?? 15);
  if (!Number.isFinite(number) || number < 0 || number > 50) {
    throw new Error("Nieprawidłowy rabat partnera");
  }
  return Math.round(number * 100) / 100;
}

function cleanTimeout(value: unknown): number {
  if (value == null || value === "") return 10_000;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1_000 || number > 30_000) {
    throw new Error("Nieprawidłowy limit czasu API");
  }
  return Math.round(number);
}

function cleanEndpoints(value: unknown, apiUrl: string | null): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("Nieprawidłowa konfiguracja endpointów API");

  const output: Record<string, string> = {};
  const base = apiUrl
    ? new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`)
    : null;

  for (const [rawName, rawPath] of Object.entries(value).slice(0, 20)) {
    const name = rawName.trim();
    if (!ENDPOINT_NAMES.has(name) || typeof rawPath !== "string") {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    const path = rawPath.trim();
    if (
      !path
      || path.length > 1_000
      || /[\u0000\r\n]/.test(path)
      || path.startsWith("//")
    ) {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    if (base) {
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
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
      throw new Error("Nieprawidłowa konfiguracja endpointów API");
    }

    output[name] = path;
  }

  return output;
}

function cleanExtraHeaders(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("Nieprawidłowa konfiguracja nagłówków API");

  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value).slice(0, 30)) {
    const name = rawName.trim();
    const normalizedName = name.toLowerCase();

    if (
      !name
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

function parseInput(body: Record<string, unknown>): ParsedPartnerInput {
  const email = cleanEmail(body.email);
  const password = cleanTemporaryPassword(body.password);
  const companyName = cleanText(
    body.company_name,
    200,
    "Podaj poprawną nazwę firmy",
    true,
  )!;

  const rawProviderType = String(body.provider_type || "local").toLowerCase();
  if (!PROVIDER_TYPES.has(rawProviderType)) {
    throw new Error("Nieprawidłowy typ partnera");
  }
  const providerType = rawProviderType as "local" | "api";

  const rawCurrency = String(body.currency || "EUR").toUpperCase();
  const currency = CURRENCIES.has(rawCurrency)
    ? rawCurrency as "EUR" | "USD" | "PLN"
    : "EUR";

  let apiProvider: "ride24_standard_v1" | "custom" | null = null;
  let apiSettings: ParsedPartnerInput["apiSettings"] = null;

  if (providerType === "api") {
    const rawApiProvider = String(body.api_provider || "custom");
    apiProvider = API_PROVIDERS.has(rawApiProvider)
      ? rawApiProvider as "ride24_standard_v1" | "custom"
      : "custom";

    const settings = isRecord(body.api_settings)
      ? body.api_settings as ApiSettingsInput
      : {};

    const rawApiUrl = cleanText(
      settings.api_url,
      MAX_API_URL_LENGTH,
      "Nieprawidłowy API URL",
    );
    const apiUrl = rawApiUrl ? assertSafeApiUrl(rawApiUrl) : null;

    const rawAuthType = String(settings.auth_type || "custom_headers");
    const authType = AUTH_TYPES.has(rawAuthType)
      ? rawAuthType as "custom_headers" | "basic" | "bearer"
      : "custom_headers";

    apiSettings = {
      apiUrl,
      authType,
      apiKey: cleanSecret(settings.api_key),
      apiSecret: cleanSecret(settings.api_secret),
      username: cleanSecret(settings.username, 500),
      password: cleanSecret(settings.password),
      bearerToken: cleanSecret(settings.bearer_token),
      endpoints: cleanEndpoints(settings.endpoints, apiUrl),
      extraHeaders: cleanExtraHeaders(settings.extra_headers),
      timeoutMs: cleanTimeout(settings.timeout_ms),
    };
  }

  return {
    email,
    password,
    companyName,
    representativeName: cleanText(
      body.representative_name,
      120,
      "Nieprawidłowe dane przedstawiciela",
    ),
    representativeSurname: cleanText(
      body.representative_surname,
      120,
      "Nieprawidłowe dane przedstawiciela",
    ),
    country: cleanText(body.country, 100, "Nieprawidłowy kraj"),
    region: cleanText(body.region, 150, "Nieprawidłowy region"),
    phone: cleanText(body.phone, 50, "Nieprawidłowy numer telefonu"),
    currency,
    discountPercent: cleanDiscount(body.discount_percent),
    providerType,
    apiProvider,
    apiSettings,
  };
}

async function rollbackCreatedPartner(
  admin: AdminClient,
  userId: string | null,
  partnerId: string | null,
): Promise<void> {
  if (partnerId) {
    const { error } = await admin.from("partners").delete().eq("id", partnerId);
    if (error) console.error("admin-create-partner rollback partner failed");
  }

  if (userId) {
    const { error: profileError } = await admin.from("profiles").delete().eq("id", userId);
    if (profileError) console.error("admin-create-partner rollback profile failed");

    const { error: authError } = await admin.auth.admin.deleteUser(userId);
    if (authError) console.error("admin-create-partner rollback auth failed");
  }
}

async function sendWelcomeEmail(
  email: string,
  companyName: string,
  temporaryPassword: string,
): Promise<boolean> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
      const html = `
<div style="font-family: 'Inter', Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 40px 20px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
    
    <div style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
      <img src="https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png" alt="Ride24 Logo" style="height: 40px; display: block; margin: 0 auto;">
    </div>

    <div style="padding: 40px 30px;">
      <h2 style="color: #0f172a; margin-top: 0; margin-bottom: 20px; font-size: 24px; font-weight: 700; text-align: center;">Welcome to Ride24!</h2>
      
      <p style="color: #475569; line-height: 1.6; font-size: 16px; margin-bottom: 24px; text-align: center;">
        The Ride24 Administrator has successfully created a Partner account for <strong style="color: #0f172a;">${escapeHtml(companyName)}</strong>.
      </p>

      <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 30px 0; border: 1px dashed #cbd5e1; text-align: center;">
        <div style="margin-bottom: 12px; color: #64748b; font-size: 15px;">
          Login (E-mail): <br>
          <span style="color: #0f172a; font-weight: 700; font-size: 16px; display: inline-block; margin-top: 4px;">${escapeHtml(email)}</span>
        </div>
        <div style="color: #64748b; font-size: 15px;">
          Temporary Password: <br>
          <span style="color: #0f172a; font-weight: 700; font-size: 16px; display: inline-block; margin-top: 4px; letter-spacing: 1px;">${escapeHtml(temporaryPassword)}</span>
        </div>
      </div>

      <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin-bottom: 35px; text-align: center; font-style: italic;">
        For security reasons, you will be required to change this temporary password and accept the B2B Terms of Cooperation upon your first login.
      </p>

      <div style="text-align: center; margin-bottom: 20px;">
        <a href="https://ride24.pl/partner.html" 
           style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 16px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; letter-spacing: 0.5px; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2); border: 1px solid #1d4ed8;">
           Log in to Partner Dashboard
        </a>
      </div>

    </div>
  </div>
  
  <div style="text-align: center; margin-top: 20px; color: #94a3b8; font-size: 13px;">
    &copy; 2026 Ride24. All rights reserved.
  </div>
</div>
    `;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Ride24 <noreply@ride24.pl>",
        to: email,
        subject: "Welcome to Ride24 – Your Partner Account",
        html,
      }),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      console.error("admin-create-partner welcome email failed", response.status);
      return false;
    }
    return true;
  } catch {
    console.error("admin-create-partner welcome email failed");
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  let createdUserId: string | null = null;
  let createdPartnerId: string | null = null;
  let adminClient: AdminClient | null = null;

  try {
    const { admin } = await requireAdmin(req);
    adminClient = admin;

    const body = await readJsonObject(req);
    const input = parseInput(body);

    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.companyName },
    });

    if (authError || !authData.user) {
      throw new Error(authError?.message || "Nie udało się utworzyć użytkownika");
    }
    createdUserId = authData.user.id;

    const { error: profileError } = await admin.from("profiles").upsert({
      id: createdUserId,
      email: input.email,
      name: input.companyName,
      role: "partner",
      must_change_password: true,
    }, { onConflict: "id" });
    if (profileError) throw new Error(profileError.message);

    const apiConfigured = Boolean(input.apiSettings?.apiUrl);
    const { data: partner, error: partnerError } = await admin.from("partners").insert({
      user_id: createdUserId,
      company_name: input.companyName,
      email: input.email,
      country: input.country,
      region: input.region,
      phone: input.phone,
      currency: input.currency,
      discount_percent: input.discountPercent,
      representative_name: input.representativeName,
      representative_surname: input.representativeSurname,
      active: false,
      account_status: "pending",
      provider_type: input.providerType,
      api_provider: input.apiProvider,
      api_enabled: false,
      api_status: input.providerType === "api"
        ? apiConfigured ? "configured" : "draft"
        : null,
      api_settings: input.providerType === "api"
        ? {
          configured: apiConfigured,
          status: apiConfigured ? "configured" : "draft",
        }
        : null,
    }).select("id").single();

    if (partnerError || !partner?.id) {
      throw new Error(partnerError?.message || "Nie udało się utworzyć partnera");
    }
    createdPartnerId = String(partner.id);

    if (input.providerType === "api" && input.apiSettings) {
      const { error: credentialsError } = await admin
        .from("partner_api_credentials")
        .insert({
          partner_id: createdPartnerId,
          api_url: input.apiSettings.apiUrl,
          auth_type: input.apiSettings.authType,
          api_key: input.apiSettings.apiKey,
          api_secret: input.apiSettings.apiSecret,
          username: input.apiSettings.username,
          password: input.apiSettings.password,
          bearer_token: input.apiSettings.bearerToken,
          endpoints: input.apiSettings.endpoints,
          extra_headers: input.apiSettings.extraHeaders,
          timeout_ms: input.apiSettings.timeoutMs,
        });
      if (credentialsError) throw new Error(credentialsError.message);
    }

    const emailSent = await sendWelcomeEmail(
      input.email,
      input.companyName,
      input.password,
    );

    return jsonResponse(req, {
      success: true,
      partner_id: createdPartnerId,
      user_id: createdUserId,
      email_sent: emailSent,
    });
  } catch (error) {
    if (adminClient && (createdUserId || createdPartnerId)) {
      await rollbackCreatedPartner(adminClient, createdUserId, createdPartnerId);
    }

    console.error(
      "admin-create-partner",
      error instanceof Error ? error.message.slice(0, 500) : "UNKNOWN_ERROR",
    );
    const publicError = publicErrorMessage(error);
    return jsonResponse(req, { error: publicError.message }, publicError.status);
  }
});
