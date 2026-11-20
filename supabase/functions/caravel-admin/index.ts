// Caravel ADMIN (profiles.role = admin, verify_jwt=true). NOT DEPLOYED as of 18 Nov 2026.
// actions:
//   status                                  read-only readiness summary (no secrets)
//   terms-ingest  {input:TermsIngestInput}   store reviewed production terms (immutable)
//   catalog-sync  {supplier_id}              merge production locations/groups, new rows INACTIVE
//   release-open  {certified_at, document_id, content_hash, reason, confirm:"OPEN_CARAVEL_SALES"}
//   release-close {reason}                   kill switch
//   auto-sync (scheduler only, header x-cron-secret = vault secret "caravel_auto_sync_cron",
//              checked by caravel_auto_sync_secret_ok(); or the CARAVEL_AUTO_SYNC_SECRET env):
//                                            catalogue + terms sync; machine-verified new terms
//                                            continue selling, anything unverified pauses sales
// Day-to-day administration happens in the existing "Konfiguracja Partnera API" modal
// (api-partner-admin routes Test / Synchronizuj / Aktywuj / Wyłącz for Caravel).
// Production supplier calls use partner_api_credentials (api.caravelway.com) only.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {corsHeaders, jsonResponse, requireAdmin, requireSecret, serviceClient} from "../_shared/ride24-security.ts";
import {runCaravelAutoSync} from "../_shared/caravel-partner-admin.ts";
import {ingestCaravelProductionTerms, syncCaravelCatalog, setCaravelRelease, CARAVEL_PARTNER_ID} from "../_shared/caravel-admin.ts";
import {caravelProductionReadClient} from "../_shared/caravel-paid-fulfillment.ts";
import {loadPartnerCredentials} from "../_shared/partner-api.ts";
import {loadCaravelRelease} from "../_shared/caravel-release.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: corsHeaders(req)});
  if (req.method !== "POST") return jsonResponse(req, {code: "METHOD_NOT_ALLOWED"}, 405);
  if (Number(req.headers.get("content-length") || 0) > 16384) return jsonResponse(req, {code: "REQUEST_TOO_LARGE"}, 413);
  const body = await req.json().catch(() => null);
  if (body?.action === "auto-sync") {
    const admin = serviceClient();
    let authorized = false;
    try { requireSecret(req, "x-cron-secret", "CARAVEL_AUTO_SYNC_SECRET"); authorized = true; } catch { /* vault check below */ }
    if (!authorized) {
      const supplied = req.headers.get("x-cron-secret") ?? "";
      const {data, error} = supplied.length >= 32
        ? await admin.rpc("caravel_auto_sync_secret_ok", {p_secret: supplied}) : {data: false, error: null};
      authorized = !error && data === true;
    }
    if (!authorized) return jsonResponse(req, {code: "CRON_AUTH_REQUIRED"}, 401);
    try {
      const client = caravelProductionReadClient(await loadPartnerCredentials(admin, CARAVEL_PARTNER_ID));
      const result = await runCaravelAutoSync({admin, client});
      console.info("Caravel auto-sync", JSON.stringify(result).slice(0, 2000));
      return jsonResponse(req, result);
    } catch (e) {
      console.error("Caravel auto-sync skipped", String((e as Error)?.message ?? e).slice(0, 120));
      return jsonResponse(req, {code: "CARAVEL_AUTO_SYNC_SKIPPED"}, 200);
    }
  }
  let ctx;
  try { ctx = await requireAdmin(req); } catch { return jsonResponse(req, {code: "ADMIN_REQUIRED"}, 403); }
  const {user, admin} = ctx;
  const actor = `admin:${user.id}`;
  try {
    switch (body?.action) {
      case "status": {
        const release = await loadCaravelRelease(admin);
        const count = async (t: string, active?: boolean) => {
          let q = admin.from(t).select("id", {count: "exact", head: true}).eq("partner_id", CARAVEL_PARTNER_ID).eq("is_api_managed", true);
          if (active !== undefined) q = q.eq("active", active);
          return (await q).count ?? 0;
        };
        const {count: terms} = await admin.from("caravel_reviewed_terms").select("document_id", {count: "exact", head: true});
        const {data: cred} = await admin.from("partner_api_credentials").select("api_url,api_key").eq("partner_id", CARAVEL_PARTNER_ID).maybeSingle();
        return jsonResponse(req, {release_open: release.open, reason: "reason" in release ? release.reason : null,
          reviewed_terms_rows: terms ?? 0,
          locations: {total: await count("partner_locations"), active: await count("partner_locations", true)},
          vehicle_groups: {total: await count("car_classes"), active: await count("car_classes", true)},
          production_credentials: cred?.api_url === "https://api.caravelway.com" && !!cred?.api_key,
          server_flags: {writes_allowed: Deno.env.get("CARAVEL_PRODUCTION_WRITES_ALLOWED") === "true",
            stripe_first_approved: Deno.env.get("CARAVEL_STRIPE_FIRST_APPROVED") === "true"}});
      }
      case "terms-ingest": {
        const client = caravelProductionReadClient(await loadPartnerCredentials(admin, CARAVEL_PARTNER_ID));
        const r = await ingestCaravelProductionTerms({admin, client,
          input: {...body.input, approvedBy: actor}});
        return jsonResponse(req, r, r.ok ? 200 : 409);
      }
      case "catalog-sync": {
        const client = caravelProductionReadClient(await loadPartnerCredentials(admin, CARAVEL_PARTNER_ID));
        const r = await syncCaravelCatalog({admin, client, supplierId: String(body.supplier_id || "")});
        return jsonResponse(req, r, r.ok ? 200 : 409);
      }
      case "release-open": {
        if (body.confirm !== "OPEN_CARAVEL_SALES") return jsonResponse(req, {code: "CONFIRMATION_REQUIRED"}, 400);
        const r = await setCaravelRelease({admin, open: true, certifiedAt: body.certified_at, documentId: body.document_id,
          contentHash: body.content_hash, actor, reason: String(body.reason || "")});
        return jsonResponse(req, r, r.ok ? 200 : 409);
      }
      case "release-close": {
        const r = await setCaravelRelease({admin, open: false, actor, reason: String(body.reason || "")});
        return jsonResponse(req, r, r.ok ? 200 : 409);
      }
      default: return jsonResponse(req, {code: "BAD_REQUEST"}, 400);
    }
  } catch (e) {
    return jsonResponse(req, {code: "CARAVEL_ADMIN_FAILED", detail: String((e as Error)?.message || "").slice(0, 80)}, 500);
  }
});
