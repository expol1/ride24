import { assertApiPricingCompatible } from "./api-quote-contract.mjs";

// These describe implemented behaviour, never a claim that a tenant has passed
// acceptance. Connection/metadata tests do not exercise a priced reservation.
export function apiProviderCapabilities(providerValue) {
  const provider = String(providerValue || "").trim().toLowerCase();
  const supported = ["ride24_standard_v1", "custom", "renteon", "easy_web_rent"].includes(provider);
  const features = [
    ["availability", "Dostępność, terminy i lokalizacje", "Availability, dates and locations", supported ? "requires_provider_test" : "unsupported"],
    ["pricing", "Kwota za cały okres i rabat partnera", "Period total and partner discount", supported ? "requires_provider_test" : "unsupported"],
    ["booking_lifecycle", "Rezerwacja, status i anulowanie", "Booking, status and cancellation", supported ? "requires_provider_test" : "unsupported"],
    ["location_fee_metadata", "Oddzielna opłata odbioru i zwrotu", "Separate pickup and return fee metadata",
      ["ride24_standard_v1", "custom", "easy_web_rent"].includes(provider) ? "metadata_only" : "requires_adapter"],
    ["mandatory_fee_quote", "Pełna wycena opłat lotniskowych, nocnych i za inną lokalizację", "Complete airport, out-of-hours and one-way fee quote", "requires_adapter"],
    ["optional_extras", "Wybór dodatków, ilości i przeliczenie ceny", "Extra selection, quantities and repricing", "requires_adapter"],
    ["snapshot", "Pozycje API w rozliczeniu, aplikacjach i voucherze", "API line items in breakdown, apps and voucher", "requires_adapter"]
  ].map(([key, label_pl, label_en, status]) => ({ key, label_pl, label_en, status }));
  return {
    version: 1, provider, supported_provider: supported,
    full_ride24_ready: false,
    certification_status: "not_certified",
    features,
    next_step_pl: provider === "renteon"
      ? "Wymagane przygotowanie wyceny Create/Calculate przed rezerwacją, obsługa katalogu usług i test na koncie wypożyczalni."
      : "Wymagane mapowanie pełnej wyceny i katalogu dodatków według dokumentacji dostawcy oraz test na koncie wypożyczalni.",
    next_step_en: provider === "renteon"
      ? "Prepare a Create/Calculate quote before booking, map its service catalogue, and run acceptance on the rental company's tenant."
      : "Map complete quotes and extra catalogues using the provider's documentation, then run acceptance on the rental company's tenant."
  };
}

export async function inspectApiReadiness(admin, partner, credentials) {
  const result = apiProviderCapabilities(partner.api_provider);
  result.connection_tested = credentials?.last_test_ok === true;
  result.metadata_synced = Boolean(credentials?.last_sync_at);
  result.local_pricing_status = "unverified";
  try {
    await assertApiPricingCompatible(admin, partner.id);
    result.local_pricing_status = "compatible_basic";
  } catch (error) {
    result.local_pricing_status = error?.code === "API_PRICING_NOT_READY"
      ? "unmapped_supplements" : "verification_failed";
  }
  // No tenant is certified by merely having reachable HTTP endpoints.
  return result;
}
