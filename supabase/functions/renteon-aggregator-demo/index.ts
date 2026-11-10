import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/ride24-security.ts";

// Read-only integration preflight. Only the Renteon demo provider is reachable.
// No create/calculate/save/open/search booking action can be invoked here.
const AGGREGATOR_ORIGIN = "https://aggregator.renteon.com";
const DEMO_CODE = "demo";
const MAX_RESPONSE_BYTES = 3_000_000;
const TIMEOUT_MS = 12_000;

type Row = Record<string, unknown>;
function object(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Row
    : null;
}

function inspectShape(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length > 0 ? inspectShape(value[0], depth + 1) : null,
    };
  }
  const row = object(value);
  if (row) {
    const keys = Object.keys(row).slice(0, 60);
    return depth >= 3
      ? { type: "object", keys }
      : {
        type: "object",
        keys,
        fields: Object.fromEntries(keys.slice(0, 16).map((key) => [
          key, inspectShape(row[key], depth + 1),
        ])),
      };
  }
  return { type: value === null ? "null" : typeof value };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const sizeHeader = Number(response.headers.get("content-length") || "0");
  if (sizeHeader > MAX_RESPONSE_BYTES) throw new Error("RENTEON_RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("RENTEON_EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("RENTEON_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!size) throw new Error("RENTEON_EMPTY_RESPONSE");
  try {
    return JSON.parse(new TextDecoder().decode(output));
  } catch {
    throw new Error("RENTEON_NOT_JSON");
  }
}

function dateAfter(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10) + "T10:00";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { admin } = await requireAdmin(req);
    const len = Number(req.headers.get("content-length") || "0");
    if (len > 1024) return jsonResponse(req, { error: "Nieprawidłowe żądanie" }, 400);
    const request = await req.json().catch(() => ({}));
    if (!object(request) || request.action !== "check_demo") {
      return jsonResponse(req, { error: "Dostępna jest tylko operacja testowa demo" }, 400);
    }

    const { data: vault, error: vaultError } = await admin
      .rpc("renteon_aggregator_server_credentials");
    const creds = object(vault);
    if (vaultError || typeof creds?.username !== "string" ||
      typeof creds?.password !== "string" || !creds.username || !creds.password) {
      console.error("renteon-aggregator-demo: vault setup incomplete");
      return jsonResponse(req, { error: "Nie udało się odczytać sekretów Renteon z Vault" }, 503);
    }

    // Basic credentials exist exclusively in this server-side function.
    const authorization = "Basic " + btoa(creds.username + ":" + creds.password);
    const headers: Record<string, string> = {
      "Authorization": authorization,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };

    async function call(path: string, method: "GET" | "POST", body?: Row) {
      const url = new URL(path, AGGREGATOR_ORIGIN);
      if (url.origin !== AGGREGATOR_ORIGIN) throw new Error("RENTEON_BAD_HOST");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          redirect: "error",
          signal: controller.signal,
        });
        // Do not forward raw server errors: some providers echo authorization.
        if (!response.ok) return { http_status: response.status, success: false, shape: null };
        const result = await readBoundedJson(response);
        return { http_status: response.status, success: true, shape: inspectShape(result) };
      } finally {
        clearTimeout(timeout);
      }
    }

    const requestBody = {
      currency: "EUR",
      prepaid: false,
      IncludeOnRequest: true,
      providers: [{ Code: DEMO_CODE, PricelistCodes: [] as string[] }],
      PickupLocation: "GR-ATH-ATH",
      DropOffLocation: "GR-ATH-ATH",
      PickupDate: dateAfter(10),
      DropOffDate: dateAfter(14),
    };
    const setup = await call("/api/setup/provider/demo", "GET");
    if (!setup.success) {
      return jsonResponse(req, { success: false, stage: "setup", setup }, 502);
    }
    const availability = await call("/api/bookings/availability", "POST", requestBody);
    return jsonResponse(req, {
      success: availability.success,
      provider: DEMO_CODE,
      production_booking_enabled: false,
      request: { PickupLocation: requestBody.PickupLocation,
        PickupDate: requestBody.PickupDate, DropOffDate: requestBody.DropOffDate },
      setup,
      availability,
    }, availability.success ? 200 : 502);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    if (message === "AUTH_REQUIRED") return jsonResponse(req, { error: "Wymagane logowanie" }, 401);
    if (message === "ADMIN_REQUIRED") return jsonResponse(req, { error: "Brak uprawnień administratora" }, 403);
    console.error("renteon-aggregator-demo:", message.slice(0, 120));
    return jsonResponse(req, { error: "Test DEMO nie powiódł się. Sprawdź log funkcji lub spróbuj ponownie." }, 502);
  }
});
