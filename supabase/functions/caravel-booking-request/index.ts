// Caravel-only consent + pending-booking entry (see _shared/caravel-booking-request.ts).
// verify_jwt=true; the user is re-resolved server-side. Fails closed (409) while
// caravel_release_control / partner / reviewed terms are not all released.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {corsHeaders, jsonResponse, serviceClient, authenticatedUser, enforceRateLimit} from "../_shared/ride24-security.ts";
import {handleCaravelBookingRequest, nbpRateStrict} from "../_shared/caravel-booking-request.ts";
import {requoteCaravelForDriverAge} from "../_shared/caravel-search.ts";
import {caravelProductionReadClient} from "../_shared/caravel-paid-fulfillment.ts";
import {loadPartnerCredentials} from "../_shared/partner-api.ts";
import {CARAVEL_PARTNER_ID} from "../_shared/caravel-release.ts";
import {caravelSafeExtraCatalog} from "../_shared/caravel-extra-selection.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: corsHeaders(req)});
  if (req.method !== "POST") return jsonResponse(req, {code: "METHOD_NOT_ALLOWED"}, 405);
  if (Number(req.headers.get("content-length") || 0) > 8192) return jsonResponse(req, {code: "REQUEST_TOO_LARGE"}, 413);
  let user;
  try { user = await authenticatedUser(req); } catch { return jsonResponse(req, {code: "AUTH_REQUIRED"}, 401); }
  try {
    const admin = serviceClient();
    await enforceRateLimit(admin, req, "caravel-booking-request", 30, 60);
    const body = await req.json().catch(() => null);
    const result = await handleCaravelBookingRequest({
      admin, userId: user.id, userEmail: user.email ?? null, exchangeRate: (c) => nbpRateStrict(c),
      requote: async (quoteRow, driverAge, release, selectedExtras) => {
        const client = caravelProductionReadClient(await loadPartnerCredentials(admin, CARAVEL_PARTNER_ID));
        return requoteCaravelForDriverAge({admin, client, release, quoteRow, driverAge, selectedExtras});
      },
      extrasCatalog: async (release) => {
        const client=caravelProductionReadClient(await loadPartnerCredentials(admin,CARAVEL_PARTNER_ID));
        const response=await client.reference("extras",release.terms.supplierId);
        return caravelSafeExtraCatalog(response.data,release.terms.supplierId,"EUR");
      },
    }, body);
    return jsonResponse(req, result.body, result.status);
  } catch (e) {
    const rate = String((e as Error)?.message || "").includes("RATE_LIMIT");
    return jsonResponse(req, {code: rate ? "RATE_LIMITED" : "CARAVEL_REQUEST_FAILED"}, rate ? 429 : 500);
  }
});
