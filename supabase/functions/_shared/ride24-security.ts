import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://ride24.pl",
  "https://www.ride24.pl",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
]);

const SAFE_CLIENT_MESSAGES = [
  "Nieprawidł",
  "Nie znaleziono",
  "Brak dostępu",
  "Brak lokalizacji",
  "Brak płatności",
  "Brak Payment Intent",
  "Brak konfiguracji",
  "Wymagane",
  "Wymagana",
  "Uzupełnij",
  "Wybrana grupa",
  "Wybrany partner",
  "Partner nie",
  "API URL",
  "API nie zwróciło",
  "Oferta API wygasła",
  "Najpierw wykonaj",
  "Rezerwacja",
  "Ten termin",
  "Data zwrotu",
  "Główny i dodatkowy",
  "Do końca terminu",
  "Termin płatności",
  "Podaj poprawny",
  "Nieznana akcja",
  "Zwrot nie istnieje",
];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://ride24.pl";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) throw new Error("Missing Supabase service configuration");

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function userScopedClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authorization = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!url || !anonKey || !authorization?.startsWith("Bearer ")) throw new Error("AUTH_REQUIRED");

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
}

export async function authenticatedUser(req: Request): Promise<User> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw new Error("AUTH_REQUIRED");

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new Error("AUTH_REQUIRED");

  const admin = serviceClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  return data.user;
}

export async function requireAdmin(req: Request): Promise<{ user: User; admin: SupabaseClient }> {
  const user = await authenticatedUser(req);
  const admin = serviceClient();

  const { data: profile, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || profile?.role !== "admin") throw new Error("ADMIN_REQUIRED");
  return { user, admin };
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export function requireSecret(req: Request, headerName: string, envName: string): void {
  const expected = Deno.env.get(envName);
  const supplied = req.headers.get(headerName);
  if (!expected || !supplied || !safeEqual(expected, supplied)) throw new Error("INTERNAL_AUTH_FAILED");
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function enforceRateLimit(
  admin: SupabaseClient,
  req: Request,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = req.headers.get("cf-connecting-ip") || forwarded || "unknown";
  const secret = Deno.env.get("RIDE24_INTERNAL_SECRET");
  if (!secret) throw new Error("Missing RIDE24_INTERNAL_SECRET");

  const bytes = new TextEncoder().encode(`${scope}|${clientIp}|${secret}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const key = Array.from(digest).map((value) => value.toString(16).padStart(2, "0")).join("");

  const { data, error } = await admin.rpc("consume_rate_limit", {
    p_scope: scope,
    p_key: key,
    p_limit: Math.max(1, Math.floor(limit)),
    p_window_seconds: Math.max(1, Math.floor(windowSeconds)),
  });
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("RATE_LIMITED");
}

export function publicErrorMessage(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";

  if (message === "AUTH_REQUIRED") return { message: "Wymagane logowanie", status: 401 };
  if (message === "ADMIN_REQUIRED") return { message: "Brak uprawnień administratora", status: 403 };
  if (message === "INTERNAL_AUTH_FAILED") return { message: "Brak autoryzacji wewnętrznej", status: 401 };
  if (message === "RATE_LIMITED") return { message: "Zbyt wiele żądań. Spróbuj ponownie za chwilę.", status: 429 };
  if (message.startsWith("PARTNER_API_ERROR:")) return { message: "Błąd komunikacji z API partnera", status: 502 };
  if (SAFE_CLIENT_MESSAGES.some((prefix) => message.startsWith(prefix))) return { message, status: 400 };

  return { message: "Wystąpił błąd serwera. Spróbuj ponownie.", status: 500 };
}
