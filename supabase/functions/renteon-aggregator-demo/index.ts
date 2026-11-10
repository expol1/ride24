import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  jsonResponse,
  requireAdmin,
} from "../_shared/ride24-security.ts";
import type { PartnerApiCredentials } from "../_shared/partner-api.ts";
import {
  aggregatorTest,
  aggregatorLocations,
  aggregatorGroups,
  aggregatorAvailability,
} from "../_shared/renteon-aggregator.ts";

// Admin-only, read-only Renteon Aggregator sandbox acceptance.
// This function cannot create, save, modify or cancel bookings.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { admin } = await requireAdmin(req);
    if (Number(req.headers.get("content-length") || 0) > 1024) {
      return jsonResponse(req, { error: "REQUEST_TOO_LARGE" }, 400);
    }
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body)
      || body.action !== "check_demo") {
      return jsonResponse(req, { error: "ONLY_READ_ONLY_DEMO" }, 400);
    }

    const { data: vault, error } = await admin.rpc("renteon_aggregator_server_credentials");
    if (error || typeof vault?.username !== "string" || typeof vault?.password !== "string") {
      return jsonResponse(req, { error: "RENTEON_VAULT_NOT_CONFIGURED" }, 503);
    }

    const credentials: PartnerApiCredentials = {
      partner_id: "91e04805-31da-4242-9e6f-b6075019d784",
      api_url: "https://aggregator.renteon.com",
      auth_type: "basic",
      renteon_provider_code: "demo",
      username: vault.username,
      password: vault.password,
      extra_headers: {},
      endpoints: {},
      timeout_ms: 15_000,
    };
    const base = Date.now();
    const date = (days: number) => new Date(base + days * 86_400_000).toISOString().slice(0, 10);

    await aggregatorTest(credentials);
    const [locations, groups, offers] = await Promise.all([
      aggregatorLocations(credentials),
      aggregatorGroups(credentials),
      aggregatorAvailability(credentials, {
        pickup_location_id: "GR-ATH-ATH",
        dropoff_location_id: "GR-ATH-ATH",
        pickup_date: date(10),
        return_date: date(14),
        pickup_time: "10:00",
        return_time: "10:00",
        currency: "EUR",
      }),
    ]);

    return jsonResponse(req, {
      success: locations.length > 0 && groups.length > 0,
      provider: "demo",
      live_provider: "Avia",
      production_booking_enabled: false,
      booking_operations_performed: 0,
      data: {
        locations: locations.length,
        categories: groups.length,
        available_offers: offers.length,
        examples: offers.slice(0, 3).map((x) => ({
          code: x.external_id,
          total_eur: x.public_price_total,
          expires_at: x.quote_expires_at,
          insurance_excess: x.features?.excess_amount ?? null,
        })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.error("renteon-aggregator-demo", message.startsWith("PARTNER_API_ERROR:") ? message.slice(0, 120) : "TEST_FAILED");
    return jsonResponse(req, { error: "RENTEON_DEMO_TEST_FAILED", detail: message.startsWith("PARTNER_API_ERROR:") ? message : undefined }, 502);
  }
});
