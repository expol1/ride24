// Caravel sandbox diagnostics — TEMPORARY, admin-only, read-only.
//
// Safeguards:
//  - verify_jwt=true at the gateway AND requireAdmin() (profiles.role = 'admin').
//  - Hard expiry: after EXPIRES_AT it answers 410 without reading the secret.
//  - POST only, body <= 1 KiB, the only accepted action is "diagnose".
//  - Reads CARAVEL_SANDBOX_API_KEY server-side only; the value is never
//    returned, logged or stored. No console output of requests or responses.
//  - Every Caravel call is a GET on the sandbox host; no quote, booking,
//    cancellation, credential or webhook endpoint. No database writes.
//  - Does not touch any other function, partner row or Ride24 dispatch.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/ride24-security.ts";
import { runCaravelDiagnostics } from "../_shared/caravel-diagnostics.ts";

const EXPIRES_AT = Date.parse("2026-11-20T23:59:59Z");
const SUPPLIER_ID = /^[A-Za-z0-9_-]{1,128}$/;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (Date.now() > EXPIRES_AT) return jsonResponse(req, { error: "DIAGNOSTICS_CLOSED" }, 410);
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    await requireAdmin(req);
  } catch {
    return jsonResponse(req, { error: "ADMIN_REQUIRED" }, 403);
  }

  if (Number(req.headers.get("content-length") || 0) > 1024) {
    return jsonResponse(req, { error: "REQUEST_TOO_LARGE" }, 400);
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || body.action !== "diagnose"
    || Object.keys(body).some((k) => k !== "action" && k !== "supplier_id")
    || (body.supplier_id !== undefined && (typeof body.supplier_id !== "string" || !SUPPLIER_ID.test(body.supplier_id)))) {
    return jsonResponse(req, { error: "ONLY_READ_ONLY_DIAGNOSE" }, 400);
  }

  try {
    const result = await runCaravelDiagnostics(Deno.env.get("CARAVEL_SANDBOX_API_KEY"), {
      supplierId: body.supplier_id ?? Deno.env.get("CARAVEL_SUPPLIER_ID") ?? null,
      nowEpochMs: Date.now(),
      budgetMs: 90_000,
    });
    return jsonResponse(req, { ok: result.blocker === null, expires_at: new Date(EXPIRES_AT).toISOString(), ...result });
  } catch {
    // Generic only: no error text that could carry request data.
    return jsonResponse(req, { error: "DIAGNOSTICS_FAILED" }, 500);
  }
});
