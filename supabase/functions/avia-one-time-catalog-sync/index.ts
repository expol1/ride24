// Single-use AVIA catalog sync. Not a booking endpoint and never enables API sales.
// Authorized by a 256-bit random token stored only as SHA-256 in a service-only table.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serviceClient } from "../_shared/ride24-security.ts";
import { loadPartnerCredentials } from "../_shared/partner-api.ts";
import {
  aggregatorTest, aggregatorLocations, aggregatorGroups, aggregatorAvailability,
} from "../_shared/renteon-aggregator.ts";

const PARTNER_ID = "91e04805-31da-4242-9e6f-b6075019d784";
const PROJECT_NAME = "Avia d.o.o.";
const table = "ride24_avia_bootstrap_jobs";
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
function dateIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  return /^PARTNER_API_ERROR:[A-Z0-9_:.-]{1,100}$/.test(msg) ? msg : "SYNC_FAILED";
}
async function sha256(v: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 400) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  const body = await req.json().catch(() => null);
  const jobId = body?.job_id;
  const token = body?.token;
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/.test(jobId)
    || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    return json({ error: "AUTH_REQUIRED" }, 401);
  }
  const admin = serviceClient();
  const digest = await sha256(token);
  // Atomic, one-time consume; even a replay cannot run the sync again.
  const { data: job, error: tokenError } = await admin.from(table)
    .update({ status: "running", consumed_at: new Date().toISOString() })
    .eq("id", jobId).eq("token_hash", digest).eq("status", "pending")
    .is("consumed_at", null).gt("expires_at", new Date().toISOString())
    .select("id").maybeSingle();
  if (tokenError || !job?.id) return json({ error: "AUTH_REQUIRED" }, 401);

  try {
    const { data: partner, error: partnerErr } = await admin.from("partners")
      .select("company_name,provider_type,api_provider,api_enabled,account_status,active,discount_percent,currency")
      .eq("id", PARTNER_ID).single();
    if (partnerErr || partner?.company_name !== PROJECT_NAME
      || partner.provider_type !== "api" || partner.api_provider !== "renteon_aggregator"
      || partner.api_enabled === true || partner.active !== true
      || partner.account_status !== "active"
      || Number(partner.discount_percent) !== 0 || partner.currency !== "EUR") {
      throw new Error("PARTNER_CONFIGURATION_MISMATCH");
    }
    const credentials = await loadPartnerCredentials(admin, PARTNER_ID);
    if (credentials.renteon_provider_code !== "Avia") {
      throw new Error("PROVIDER_CODE_MISMATCH");
    }

    await aggregatorTest(credentials);
    const [locations, groups] = await Promise.all([
      aggregatorLocations(credentials), aggregatorGroups(credentials),
    ]);
    // Fail closed rather than replacing a sound catalog with an incomplete setup.
    if (locations.length < 10 || locations.length > 200
      || groups.length < 10 || groups.length > 200
      || new Set(locations.map(x => x.external_id)).size !== locations.length
      || new Set(groups.map(x => x.external_id)).size !== groups.length) {
      throw new Error("INCOMPLETE_AVIA_CATALOG");
    }
    const location = locations.find(x => x.external_id === "HR-DUB-DBV");
    if (!location) throw new Error("DUBROVNIK_AIRPORT_MISSING");
    const offers = await aggregatorAvailability(credentials, {
      pickup_location_id: location.external_id,
      dropoff_location_id: location.external_id,
      pickup_date: dateIn(9),
      return_date: dateIn(13),
      pickup_time: "10:00",
      return_time: "10:00",
      currency: "EUR",
    });
    if (!offers.length || offers.some(x => x.deposit_amount !== 0
      || Number(x.features?.excess_amount || 0) !== 0
      || !x.public_price_total || x.features?.noCardHold !== true)) {
      throw new Error("AVIA_RATE_TERMS_UNVERIFIED");
    }

    const locRows = locations.map(x => ({
      partner_id: PARTNER_ID, external_id: x.external_id, is_api_managed: true,
      country: x.country, region: x.region, city: x.city || null,
      location_name: x.location_name, type: x.type === "airport" ? "airport" : "city",
      active: x.active !== false, extra_fee: false, extra_fee_amount: null,
      return_fee_amount: 0, contact_required: false,
    }));
    const groupRows = groups.map(x => ({
      partner_id: PARTNER_ID, external_id: x.external_id, is_api_managed: true,
      class_code: x.class_code, public_price: 0,
      example_model: x.example_model || x.model || x.external_id,
      model: x.model || x.example_model || x.external_id,
      description: x.description || x.external_id,
      features: {
        ...(x.features || {}), noCreditCard: true, noCardHold: true,
        requiresPersonalDebitCard: true, requiresPersonalDebitCardEvenForCash: true,
        prepaidCardsAccepted: false, virtualCardsAccepted: false,
        anonymousCardsAccepted: false,
      },
      deposit_amount: 0, active: true,
      seats: x.seats ?? 5, bags: x.bags ?? 2, mileage_limit: null,
      driver_included: false,
    }));

    const { error: locErr } = await admin.from("partner_locations")
      .upsert(locRows, { onConflict: "partner_id,external_id" });
    if (locErr) throw new Error("LOCATION_UPSERT_FAILED");
    const { error: grpErr } = await admin.from("car_classes")
      .upsert(groupRows, { onConflict: "partner_id,external_id" });
    if (grpErr) throw new Error("CAR_CLASSES_UPSERT_FAILED");

    const [locCheck, grpCheck] = await Promise.all([
      admin.from("partner_locations").select("*", { count: "exact", head: true })
        .eq("partner_id", PARTNER_ID).eq("is_api_managed", true),
      admin.from("car_classes").select("*", { count: "exact", head: true })
        .eq("partner_id", PARTNER_ID).eq("is_api_managed", true),
    ]);
    if (locCheck.error || grpCheck.error
      || locCheck.count !== locations.length || grpCheck.count !== groups.length) {
      throw new Error("PERSISTED_CATALOG_COUNT_MISMATCH");
    }
    const now = new Date().toISOString();
    const { error: credErr } = await admin.from("partner_api_credentials")
      .update({ last_test_ok: true, last_test_at: now, last_sync_at: now,
        last_error: null, updated_at: now }).eq("partner_id", PARTNER_ID);
    if (credErr) throw new Error("CREDENTIAL_STATUS_UPDATE_FAILED");
    const { error: stateErr } = await admin.from("partners").update({
      api_enabled: false, api_status: "synced", api_last_error: null,
      api_last_test_at: now, api_last_sync_at: now,
      api_settings: { configured: true, status: "synced" },
    }).eq("id", PARTNER_ID).eq("api_enabled", false);
    if (stateErr) throw new Error("PARTNER_STATE_UPDATE_FAILED");

    const summary = {
      provider: "Avia", synchronized: true, sales_enabled: false,
      locations: locations.length, categories: groups.length,
      tested_offers: offers.length, sample_location: location.external_id,
      sample_prices: offers.slice(0, 4).map(x => ({
        group: x.external_id, total_eur: x.public_price_total,
        excess_eur: x.features?.excess_amount ?? null, security_deposit_eur: x.deposit_amount,
      })),
    };
    await admin.from(table).update({ status: "synced", result: summary })
      .eq("id", job.id);
    return json({ success: true, ...summary });
  } catch (error) {
    const code = safeError(error);
    console.error("avia-one-time-catalog-sync", code);
    await admin.from(table).update({ status: "failed", error_code: code })
      .eq("id", job.id);
    return json({ success: false, error: code }, 409);
  }
});
