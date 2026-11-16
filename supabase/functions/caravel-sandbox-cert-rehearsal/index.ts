// Caravel CERTIFICATION REHEARSAL — isolated admin-only, sandbox-only.
// This is deliberately NOT a certification controller:
// no /_certification/start, /advance or production calls are made.
// Deploy only after the private RLS-only caravel_sbx_reference_snapshots table/RPCs exist.
// Supabase gateway verify_jwt MUST stay true.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {corsHeaders, jsonResponse, requireAdmin} from "../_shared/ride24-security.ts";
import {runCaravelAcceptance} from "../_shared/caravel-acceptance.mjs";
import {createCaravelSandboxReferenceRepository} from "../_shared/caravel-cert-state.mjs";

const EXPIRES_AT = Date.parse("2026-11-20T20:00:00Z"); // update only by a deliberate future code deploy
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const PHASES = new Set([
  "baseline", "unknown-enum-value", "unknown-error-code", "unknown-response-field",
  "unknown-feature-code", "opaque-id-tolerance", "shrunk-reference-refresh:1",
  "shrunk-reference-refresh:2", "deprecation-notice", "version-format",
]);
let running = false;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: corsHeaders(req)});
  if (Date.now() > EXPIRES_AT) return jsonResponse(req, {error: "REHEARSAL_CLOSED"}, 410);
  if (req.method !== "POST") return jsonResponse(req, {error: "METHOD_NOT_ALLOWED"}, 405);
  let admin;
  try { ({admin} = await requireAdmin(req)); }
  catch { return jsonResponse(req, {error: "ADMIN_REQUIRED"}, 403); }
  if (Number(req.headers.get("content-length") || 0) > 1024)
    return jsonResponse(req, {error: "REQUEST_TOO_LARGE"}, 400);
  const body = await req.json().catch(() => null);
  // Read-only administrative readiness endpoint. Never returns a key or
  // its length, never contacts Caravel, and never creates bookings.
  if (body && typeof body === "object" && !Array.isArray(body) &&
      body.action === "preflight" && Object.keys(body).length === 1) {
    const secrets = {
      sandbox_api_key: Boolean(Deno.env.get("CARAVEL_SANDBOX_API_KEY")),
      webhook_hmac: Boolean(Deno.env.get("CARAVEL_SANDBOX_WEBHOOK_SECRET")),
      webhook_hmac_old: Boolean(Deno.env.get("CARAVEL_SANDBOX_WEBHOOK_SECRET_OLD")),
      gap_worker: Boolean(Deno.env.get("CARAVEL_SANDBOX_RECONCILE_SECRET")),
      periodic_worker: Boolean(Deno.env.get("CARAVEL_SANDBOX_PERIODIC_SECRET")),
    };
    const probes = [
      ["reference_cache", "caravel_sbx_reference_snapshots", "session_id"],
      ["webhook_events", "caravel_sbx_webhook_events", "event_id"],
      ["gap_queue", "caravel_sbx_reconcile_jobs", "job_id"],
      ["periodic_scans", "caravel_sbx_periodic_scans", "supplier_id"],
    ] as const;
    const db: Record<string, boolean> = {};
    for (const [label, table, field] of probes) {
      const {error} = await admin.from(table).select(field, {head: true, count: "exact"});
      db[label] = !error;
    }
    return jsonResponse(req, {
      mode: "SANDBOX_READ_ONLY_PREFLIGHT",
      admin_authenticated: true,
      sandbox_enabled: false,
      secrets_configured: secrets,
      private_tables_accessible: db,
      ready_for_rehearsal: secrets.sandbox_api_key && Object.values(db).every(Boolean),
      ready_for_webhook_delivery: secrets.sandbox_api_key && secrets.webhook_hmac && Object.values(db).every(Boolean),
      workers_can_be_enabled: secrets.sandbox_api_key && secrets.gap_worker && secrets.periodic_worker && Object.values(db).every(Boolean),
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.action !== "rehearse" || !PHASES.has(body.phase) ||
      typeof body.supplier_id !== "string" || !SID.test(body.supplier_id) ||
      typeof body.session_id !== "string" || !UUID.test(body.session_id) ||
      Object.keys(body).some(k => !["action", "phase", "supplier_id", "session_id"].includes(k)))
    return jsonResponse(req, {error: "INVALID_REHEARSAL_REQUEST"}, 400);
  if (running) return jsonResponse(req, {error: "RUN_IN_PROGRESS"}, 409);

  running = true;
  try {
    const apiKey = Deno.env.get("CARAVEL_SANDBOX_API_KEY");
    if (!apiKey) return jsonResponse(req, {error: "SANDBOX_SECRET_UNAVAILABLE"}, 503);
    // Private PostgreSQL RPC cache contains only reference records, scoped
    // to a random phase-session UUID. It never holds keys or customer information.
    // Baseline seeds the durable catalogue. EVERY phase re-syncs via MERGE into
    // the same persisted namespace so :1 can quote missing ids and :2 can
    // identify returned records without assuming a warm Edge instance.
    const referenceRepository = createCaravelSandboxReferenceRepository(admin, body.session_id);
    const booking = body.phase === "baseline" || body.phase === "unknown-response-field";
    const run = await runCaravelAcceptance(apiKey, {
      booking, supplierId: body.supplier_id, certificationPhase: body.phase === "baseline" ? null : body.phase,
      referenceRepository, sandboxPremiumMechanics: true, premiumOnly: true,
      runId: crypto.randomUUID().slice(0, 8), budgetMs: 95_000,
    });
    const payload = {rehearsal_only: true, phase: body.phase, supplier_id: body.supplier_id,
      expires_at: new Date(EXPIRES_AT).toISOString(), ...run};
    if (JSON.stringify(payload).includes(apiKey)) return jsonResponse(req, {error: "REHEARSAL_REDACTED"}, 500);
    return jsonResponse(req, payload);
  } catch {
    return jsonResponse(req, {error: "REHEARSAL_FAILED"}, 500);
  } finally {
    running = false;
  }
});
