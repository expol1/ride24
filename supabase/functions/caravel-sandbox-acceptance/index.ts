// Caravel sandbox acceptance — TEMPORARY, admin-only, SANDBOX-only test function.
//
// Purpose: run the real Caravel sandbox flow server-side with the existing secret
// (capabilities -> reference sync -> availability -> quote -> book -> replay ->
// 409 checks -> cancel) at ONE supplier per call (supplier_id), Premium offers only.
//
// Safeguards:
//  - verify_jwt=true at the gateway AND requireAdmin() (profiles.role = 'admin').
//  - Hard expiry about 24 h after preparation: after EXPIRES_AT it answers 410 without reading the secret.
//  - POST only, body <= 1 KiB, exactly {"action":"run","booking":true|false,"supplier_id":"…"}:
//    one supplier per run.
//  - Premium only: a booking is made only for an offer that passes the Ride24 Premium
//    policy (zero deposit/excess, theft_excess 0, waiver, required covers). No other plan is booked.
//  - The Caravel client is fixed to environment "sandbox": production cannot be reached,
//    and production booking writes are separately disabled in the client.
//  - Bookings use invented data only (Sandbox Tester / sandbox-ci@example.test),
//    payment_model pay_on_arrival, external_ref "ride24-sandbox-…"; every booking created
//    is cancelled in the same run, with a cleanup pass that ignores the time budget.
//  - CARAVEL_SANDBOX_API_KEY is read server-side only; never returned, logged or stored.
//    The result is scrubbed of the key and checked again before it leaves.
//  - No database writes (only requireAdmin's profiles read), no other function touched,
//    no Ride24 booking, payment, Stripe, partner or dispatch interaction.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/ride24-security.ts";
import { runCaravelAcceptance } from "../_shared/caravel-acceptance.mjs";

const EXPIRES_AT = Date.parse("2026-11-15T08:00:00Z"); // about 24 h after preparation
let running = false; // one run at a time per instance

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (Date.now() > EXPIRES_AT) return jsonResponse(req, { error: "ACCEPTANCE_CLOSED" }, 410);
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
  if (!body || typeof body !== "object" || Array.isArray(body) || body.action !== "run"
    || typeof body.booking !== "boolean"
    || typeof body.supplier_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.supplier_id)
    || Object.keys(body).some((k) => k !== "action" && k !== "booking" && k !== "supplier_id")) {
    return jsonResponse(req, { error: "ONLY_SANDBOX_RUN" }, 400);
  }
  if (running) return jsonResponse(req, { error: "RUN_IN_PROGRESS" }, 409);

  running = true;
  try {
    const apiKey = Deno.env.get("CARAVEL_SANDBOX_API_KEY");
    const run = await runCaravelAcceptance(apiKey, {
      booking: body.booking,
      supplierId: body.supplier_id, // one supplier per run
      premiumOnly: true, // never book an offer that fails the Ride24 Premium policy
      runId: crypto.randomUUID().slice(0, 8),
      budgetMs: 100_000,
    });
    const payload = { expires_at: new Date(EXPIRES_AT).toISOString(), sandbox_only: true, secret_present: !!apiKey, ...run };
    if (apiKey && JSON.stringify(payload).includes(apiKey)) return jsonResponse(req, { error: "ACCEPTANCE_REDACTED" }, 500);
    return jsonResponse(req, payload);
  } catch {
    return jsonResponse(req, { error: "ACCEPTANCE_FAILED" }, 500);
  } finally {
    running = false;
  }
});
