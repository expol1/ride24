// Caravel SANDBOX live audit — TEMPORARY, sandbox-only, no Ride24 DB access.
//
// Purpose (18–20 Nov 2026 window): obtain REAL sandbox evidence that mocks
// cannot give:
//   reference       suppliers/whoami + terms list + every terms body with an
//                   INDEPENDENT canonical SHA-256 check (§3.9) + protections
//   hmac-self-test  official POST /_certification/hmac-self-test using the
//                   PUBLIC fixture (its own self-test secret, not an account secret)
//   acceptance      existing runCaravelAcceptance quote -> book -> replay ->
//                   status -> cancel on ONE sandbox supplier (invented data)
//   cert-status     GET /_certification/status (read-only)
//
//   cert-start / cert-phase / cert-advance
//                   drive Caravel's HOSTED sandbox certification run (10 phases).
//                   Authorized by Ride24 on 18 Nov 2026 once the prerequisites
//                   (full live flow, key on capabilities, HMAC self-test) passed.
//                   Sandbox-only by Caravel's design: a production target is refused.
//                   Reference snapshots persist in the private service-role-only
//                   caravel_sbx_reference_snapshots RPCs (no customer data).
//
// It never reaches production
// (client fixed to environment "sandbox"), never reads/writes Ride24 tables,
// never returns or logs CARAVEL_SANDBOX_API_KEY.
//
// Auth: gateway verify_jwt=true AND header x-ride24-audit-token whose SHA-256
// must equal TOKEN_SHA256 (one-time operator token, never committed). Hard
// expiry; afterwards 410 without reading the secret. Replace with a closed
// stub after the audit.
import {CaravelClient} from "../_shared/caravel-sandbox-adapter.ts";
import {runCaravelAcceptance} from "../_shared/caravel-acceptance.mjs";
import {verifyCaravelTermsDocumentHash} from "../_shared/caravel-terms-canonical.ts";
import {buildCaravelHmacSelfTestSubmission} from "../_shared/caravel-webhooks.ts";
import {createCaravelSandboxReferenceRepository} from "../_shared/caravel-cert-state.mjs";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2";

const EXPIRES_AT = Date.parse("2026-11-20T20:00:00Z");
const TOKEN_SHA256 = "036784ba932a088753833498653cb8a03272d6c6decc931047b9f69a30b79f81";
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES = new Set(["baseline", "unknown-enum-value", "unknown-error-code", "unknown-response-field",
  "unknown-feature-code", "opaque-id-tolerance", "shrunk-reference-refresh:1", "shrunk-reference-refresh:2",
  "deprecation-notice", "version-format"]);
const SANDBOX = "https://sandbox-api.caravelway.com";
// Official public self-test fixture, fetched from Caravel's own pack (not a live credential).
const FIXTURE_URL = SANDBOX + "/docs/packs/caravel/fixtures/webhook-hmac-self-test.json";
let running = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function eq(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
const errText = (e: unknown, key: string) =>
  String((e as {code?: string; status?: number; message?: string})?.status ?? "") + " " +
  String((e as {code?: string})?.code ?? (e as Error)?.message ?? e).split(key || "\u0000").join("***").slice(0, 300);

async function reference(client: CaravelClient, key: string, only: string | null) {
  const out: Record<string, unknown> = {};
  const who = await client.whoami().catch((e) => ({error: errText(e, key)}));
  out.whoami = who && typeof who === "object" && "data" in who ? (who as {data: unknown}).data : who;
  const sup = await client.suppliers();
  const suppliers = (sup.data as Array<Record<string, unknown>>).filter((s) => !only || s.supplier_id === only);
  out.suppliers = [];
  for (const s of suppliers) {
    const sid = String(s.supplier_id);
    const entry: Record<string, unknown> = {supplier: s};
    try {
      const list = await client.referenceTerms(sid);
      const docs = [];
      for (const meta of list.data) {
        const d = (await client.referenceTermsDocument(meta.document_id, sid)).data;
        let verification: unknown;
        try { verification = await verifyCaravelTermsDocumentHash(d); }
        catch (e) { verification = {verified: false, error: errText(e, key)}; }
        const same = ["document_id", "language", "version", "title", "format", "content_hash", "published_at", "withdrawn_at"]
          .every((k) => (d as Record<string, unknown>)[k] === (meta as Record<string, unknown>)[k]);
        docs.push({metadata: meta, list_detail_consistent: same, verification, body: d.body});
      }
      entry.terms = docs;
    } catch (e) { entry.terms_error = errText(e, key); }
    try {
      const prot = await client.reference("protections", sid);
      entry.protections = (prot.data as Array<Record<string, unknown>>).map((p) => ({
        protection_id: p.protection_id, vehicle_id: p.vehicle_id, plan: p.plan, tier: p.tier, name: p.name,
        product_type: p.product_type, price: p.price, price_basis: p.price_basis, excess: p.excess, deposit: p.deposit,
        theft_excess: p.theft_excess, covers: p.covers, excludes: p.excludes, included: p.included,
      }));
    } catch (e) { entry.protections_error = errText(e, key); }
    try {
      const pol = await client.reference("policies", sid);
      entry.policies = pol.data;
    } catch (e) { entry.policies_error = errText(e, key); }
    try {
      const [loc, veh] = await Promise.all([client.locations(200, sid), client.vehicleClasses(200, sid)]);
      entry.counts = {locations: (loc.data as unknown[]).length, vehicles: (veh.data as unknown[]).length};
    } catch (e) { entry.counts_error = errText(e, key); }
    (out.suppliers as unknown[]).push(entry);
  }
  return out;
}

Deno.serve(async (req) => {
  if (Date.now() > EXPIRES_AT) return json({error: "AUDIT_CLOSED"}, 410);
  if (req.method !== "POST") return json({error: "METHOD_NOT_ALLOWED"}, 405);
  const token = req.headers.get("x-ride24-audit-token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token) || !eq(await sha256Hex(token), TOKEN_SHA256)) return json({error: "FORBIDDEN"}, 403);
  if (Number(req.headers.get("content-length") || 0) > 512) return json({error: "REQUEST_TOO_LARGE"}, 400);
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action;
  const allowed: Record<string, string[]> = {
    "reference": ["action", "supplier_id"], "hmac-self-test": ["action"],
    "acceptance": ["action", "supplier_id", "booking"], "cert-status": ["action"],
    "cert-start": ["action", "confirm"], "cert-advance": ["action", "confirm"],
    "cert-phase": ["action", "phase", "supplier_id", "session_id"],
  };
  if (!body || typeof action !== "string" || !allowed[action] ||
      Object.keys(body).some((k) => !allowed[action].includes(k)) ||
      (body.supplier_id !== undefined && (typeof body.supplier_id !== "string" || !SID.test(body.supplier_id))) ||
      (action === "acceptance" && (typeof body.supplier_id !== "string" || typeof body.booking !== "boolean")) ||
      ((action === "cert-start" || action === "cert-advance") && body.confirm !== "SANDBOX_CERTIFICATION_RUN") ||
      (action === "cert-phase" && (typeof body.phase !== "string" || !PHASES.has(body.phase) ||
        typeof body.supplier_id !== "string" || typeof body.session_id !== "string" || !UUID.test(body.session_id))))
    return json({error: "BAD_REQUEST"}, 400);
  if (running) return json({error: "RUN_IN_PROGRESS"}, 409);
  const key = Deno.env.get("CARAVEL_SANDBOX_API_KEY") ?? "";
  if (!key) return json({error: "SANDBOX_KEY_NOT_CONFIGURED", secret_present: false}, 503);
  running = true;
  try {
    const client = new CaravelClient({apiKey: key, environment: "sandbox"});
    let result: unknown;
    if (action === "reference") {
      result = await reference(client, key, (body.supplier_id as string) ?? null);
    } else if (action === "hmac-self-test") {
      const fr = await fetch(FIXTURE_URL, {redirect: "error", signal: AbortSignal.timeout(15000)});
      if (!fr.ok) throw new Error("FIXTURE_HTTP_" + fr.status);
      const FIXTURE = await fr.json();
      const local = await buildCaravelHmacSelfTestSubmission(FIXTURE);
      const submitted = await client.submitSandboxHmacSelfTest(local).catch((e) => ({error: errText(e, key)}));
      result = {local_signature_matches_fixture: local.signature_hex === (FIXTURE as {expected_signature_hex: string}).expected_signature_hex,
        local_tampered_rejected: local.tampered_rejected, caravel: submitted};
    } else if (action === "acceptance") {
      result = await runCaravelAcceptance(key, {booking: body.booking as boolean, supplierId: body.supplier_id as unknown as null,
        premiumOnly: true, sandboxPremiumMechanics: true, runId: crypto.randomUUID().slice(0, 8), budgetMs: 110_000});
    } else if (action === "cert-phase") {
      const url = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !svc) throw new Error("SERVICE_ROLE_UNAVAILABLE");
      const admin = createClient(url, svc, {auth: {persistSession: false}});
      const referenceRepository = createCaravelSandboxReferenceRepository(admin, body.session_id as string);
      const phase = body.phase as string;
      result = await runCaravelAcceptance(key, {
        booking: phase === "baseline" || phase === "unknown-response-field",
        supplierId: body.supplier_id as unknown as null,
        certificationPhase: (phase === "baseline" ? null : phase) as unknown as null,
        referenceRepository: referenceRepository as never, sandboxPremiumMechanics: true, premiumOnly: true,
        runId: crypto.randomUUID().slice(0, 8), budgetMs: 110_000});
    } else if (action === "cert-start" || action === "cert-advance") {
      const r = await fetch(SANDBOX + (action === "cert-start" ? "/_certification/start" : "/_certification/advance"), {
        method: "POST", headers: {"X-API-Key": key, Accept: "application/json"},
        redirect: "error", signal: AbortSignal.timeout(20000)});
      result = {http_status: r.status, body: await r.json().catch(() => null)};
    } else {
      const r = await fetch(SANDBOX + "/_certification/status", {headers: {"X-API-Key": key, Accept: "application/json"},
        redirect: "error", signal: AbortSignal.timeout(15000)});
      result = {http_status: r.status, body: await r.json().catch(() => null)};
    }
    const payload = {sandbox_only: true, action, at: new Date().toISOString(), result};
    const text = JSON.stringify(payload);
    if (text.includes(key)) return json({error: "REDACTED"}, 500);
    return new Response(text, {headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  } catch (e) {
    return json({error: "AUDIT_FAILED", detail: errText(e, key)}, 500);
  } finally {
    running = false;
  }
});
