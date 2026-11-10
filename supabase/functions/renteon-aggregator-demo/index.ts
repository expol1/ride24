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

// Admin-only, read-only Renteon Aggregator acceptance: demo or AVIA.
// Cannot create, save, modify, cancel bookings or activate Ride24 sales.
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
      || !["check_demo", "check_avia"].includes(body.action)) {
      return jsonResponse(req, { error: "ONLY_READ_ONLY_AGGREGATOR_CHECKS" }, 400);
    }
    const providerCode = body.action === "check_avia" ? "Avia" : "demo";
    if (providerCode === "Avia") {
      // Guard against accidental display-time double discount.
      const { data: partner, error: partnerError } = await admin
        .from("partners")
        .select("api_provider, api_enabled, discount_percent")
        .eq("id", "91e04805-31da-4242-9e6f-b6075019d784")
        .single();
      if (partnerError || partner?.api_provider !== "renteon_aggregator"
        || Number(partner.discount_percent) !== 0) {
        return jsonResponse(req, { error: "AVIA_PRICE_CONFIG_NOT_READY" }, 409);
      }
    }

    const { data: vault, error } = await admin.rpc("renteon_aggregator_server_credentials");
    if (error || typeof vault?.username !== "string" || typeof vault?.password !== "string") {
      return jsonResponse(req, { error: "RENTEON_VAULT_NOT_CONFIGURED" }, 503);
    }

    const credentials: PartnerApiCredentials = {
      partner_id: "91e04805-31da-4242-9e6f-b6075019d784",
      api_url: "https://aggregator.renteon.com",
      auth_type: "basic",
      renteon_provider_code: providerCode,
      username: vault.username,
      password: vault.password,
      extra_headers: {},
      endpoints: {},
      timeout_ms: 15_000,
    };
    const base = Date.now();
    const date = (days: number) => new Date(base + days * 86_400_000).toISOString().slice(0, 10);

    await aggregatorTest(credentials);
    // All endpoints used below are read-only. No Create/Calculate/Save/Cancel.
    const locations = await aggregatorLocations(credentials);
    const groups = await aggregatorGroups(credentials);

    // Use a currently configured office for AVIA; no hard-coded demo airport.
    const selected = providerCode === "demo"
      ? "GR-ATH-ATH"
      : locations.find((x) => x.type === "airport")?.external_id
        || locations[0]?.external_id
        || null;

    let offers: Awaited<ReturnType<typeof aggregatorAvailability>> = [];
    let availabilityVerified = false;
    let availabilityError: string | null = null;
    if (selected) {
      try {
        offers = await aggregatorAvailability(credentials, {
          pickup_location_id: selected,
          dropoff_location_id: selected,
          pickup_date: date(10),
          return_date: date(14),
          pickup_time: "10:00",
          return_time: "10:00",
          currency: "EUR",
        });
        availabilityVerified = true;
      } catch (error) {
        // Setup access may be valid even if sample dates/location are unavailable.
        availabilityError = error instanceof Error
          && error.message.startsWith("PARTNER_API_ERROR:")
          ? error.message.slice(0, 120)
          : "AVAILABILITY_TEST_FAILED";
      }
    }

    return jsonResponse(req, {
      success: locations.length > 0 && groups.length > 0,
      provider: providerCode,
      access_enabled: true,
      production_booking_enabled: false,
      booking_operations_performed: 0,
      pricing_discount_applied_by_ride24_percent: 0,
      data: {
        locations: locations.length,
        categories: groups.length,
        selected_location: selected,
        pickup_date: date(10),
        return_date: date(14),
        availability_verified: availabilityVerified,
        availability_error: availabilityError,
        available_offers: offers.length,
        examples: offers.slice(0, 5).map((x) => ({
          group_code: x.external_id,
          model: x.model,
          provider_total_eur: x.public_price_total,
          ride24_partner_discount_percent: 0,
          partner_total_eur: x.public_price_total,
          insurance_excess: x.features?.excess_amount ?? null,
          deposit_eur: x.deposit_amount ?? null,
        })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.error("renteon-aggregator-demo", message.startsWith("PARTNER_API_ERROR:") ? message.slice(0, 120) : "TEST_FAILED");
    return jsonResponse(req, { error: "RENTEON_AGGREGATOR_TEST_FAILED", detail: message.startsWith("PARTNER_API_ERROR:") ? message : undefined }, 502);
  }
});
