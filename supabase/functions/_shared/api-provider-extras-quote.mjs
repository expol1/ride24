import { apiPriceTotals } from "./api-quote-contract.mjs";

function moneyCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error("API_EXTRAS_INVALID_TOTAL");
  return Math.round((n + Number.EPSILON) * 100);
}
function positiveRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100_000;
}

export function apiRenteonExtrasPricing({
  baseTotal, selectedTotal, days, currency, discountPercent, marginPercent,
  loyaltyPercent = 0, exchangeRate, selections = [], catalog = [],
}) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 366
    || !/^[A-Z]{3}$/.test(currency) || !positiveRate(exchangeRate)
    || typeof loyaltyPercent !== "number" || loyaltyPercent < 0 || loyaltyPercent > 20
    || !Array.isArray(selections) || !Array.isArray(catalog)
    || selections.length > 20) throw new Error("API_EXTRAS_INVALID_CONTEXT");

  const base = apiPriceTotals({public_price: baseTotal / days, public_price_total: baseTotal,
    price_is_total: true}, days, discountPercent, marginPercent);
  const selected = apiPriceTotals({public_price: selectedTotal / days, public_price_total: selectedTotal,
    price_is_total: true}, days, discountPercent, marginPercent);
  const basePartner = moneyCents(base.partnerNetTotal);
  const baseCustomer = moneyCents(base.finalTotal);
  const allPartner = moneyCents(selected.partnerNetTotal);
  const allCustomer = moneyCents(selected.finalTotal);
  // Add-ons may never reduce the agreed rental price or produce negative items.
  if (allPartner < basePartner || allCustomer < baseCustomer) throw new Error("API_EXTRAS_REPRICE_REVIEW");
  const available = new Set(catalog.map(item => item.id));
  const seen = new Set();
  for (const entry of selections) {
    if (!entry || typeof entry.id !== "string" || !available.has(entry.id)
      || seen.has(entry.id) || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 10) {
      throw new Error("API_EXTRAS_INVALID_SELECTION");
    }
    seen.add(entry.id);
  }
  const extrasLabel = selections.length
    ? catalog.filter(item => seen.has(item.id)).map(item => item.name_en).join(", ").slice(0, 200)
    : "";
  const items = [{
    kind: "rental", id: null, name_pl: "Wynajem samochodu", name_en: "Car rental",
    quantity: 1, days, billing: "rental",
    partner_cents: basePartner, customer_cents: baseCustomer,
  }];
  if (selections.length) items.push({
    kind: "extra", id: null,
    name_pl: "Dodatki wybrane w systemie wypożyczalni",
    name_en: extrasLabel ? `Provider extras: ${extrasLabel}` : "Selected provider extras",
    quantity: 1, days: 1, billing: "rental",
    partner_cents: allPartner - basePartner, customer_cents: allCustomer - baseCustomer,
  });
  const commission = allCustomer - allPartner;
  const loyalty = Math.round(commission * loyaltyPercent / 100);
  const onlinePln = Math.round((commission - loyalty) * exchangeRate);
  if (!Number.isSafeInteger(onlinePln) || onlinePln < 0 || onlinePln > 100_000_000) {
    throw new Error("API_EXTRAS_INVALID_TOTAL");
  }
  return {
    price: selected,
    snapshot: {
      version: 2, provider_priced: true, currency, items,
      partner_cents: allPartner, gross_cents: allCustomer,
      commission_cents: commission, loyalty_discount_cents: loyalty,
      total_cents: allCustomer - loyalty,
      online_pln_cents: onlinePln, exchange_rate: exchangeRate,
    },
  };
}
