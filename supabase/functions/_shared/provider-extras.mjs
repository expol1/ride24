// Provider-sourced rental options: no local or guessed pricing.
// This module intentionally does not make external requests or persist quotes.

const MAX_SERVICE_CHOICES = 20;
const MAX_SERVICE_QUANTITY = 10;

function invalid(code = "API_EXTRAS_INVALID") {
  throw new Error(code);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function serviceId(service) {
  const id = service?.ServiceId;
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
  return String(id);
}
function quantityLimit(service) {
  const max = Number(service?.MaximumQuantity);
  return service?.IsQuantityEditable === true
    ? Math.max(1, Math.min(MAX_SERVICE_QUANTITY, Number.isSafeInteger(max) && max >= 1 ? max : 1))
    : 1;
}
function cleanName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 160 && !/[<>\u0000-\u001f]/.test(name) ? name : null;
}
function serviceEntries(model) {
  if (!record(model) || !Array.isArray(model.Services) || model.Services.length > 300) {
    invalid("API_EXTRAS_CATALOG_UNAVAILABLE");
  }
  return model.Services;
}

// The provider is the sole source of selectable service IDs, quantity limits
// and prices. A numeric display price is deliberately not inferred from an
// advertised day rate: Renteon calculates final service totals per booking.
export function renteonExtrasCatalog(model) {
  const seen = new Set();
  const extras = [];
  for (const service of serviceEntries(model)) {
    if (!record(service)) continue;
    const id = serviceId(service);
    if (!id || seen.has(id)) invalid("API_EXTRAS_DUPLICATE_SERVICE");
    seen.add(id);
    if (service.IsMandatory === true) continue;
    const name = cleanName(service.Name);
    if (!name) continue;
    extras.push({
      id: `renteon:${id}`,
      provider_service_id: id,
      code: null,
      name_pl: name,
      name_en: name,
      description: cleanName(service.Description),
      billing: "rental",
      max_quantity: quantityLimit(service),
      selected: service.IsSelected === true,
      quantity: service.IsSelected === true
        ? Math.max(1, Math.min(quantityLimit(service), Number(service.Quantity) || 1))
        : 0,
      unit_customer_cents: null,
    });
  }
  return extras.slice(0, 100);
}

// Mutates only an isolated structured clone of an unsaved Renteon booking.
// We never allow the client to toggle mandatory services, invent service IDs,
// or change provider-calculated fields.
export function applyRenteonExtras(model, selections, { replace = false } = {}) {
  const services = serviceEntries(model);
  if (!Array.isArray(selections) || selections.length > MAX_SERVICE_CHOICES) {
    invalid("API_EXTRAS_INVALID_SELECTION");
  }
  const selected = new Map();
  for (const choice of selections) {
    if (!record(choice) || typeof choice.id !== "string"
      || !/^renteon:[1-9]\d*$/.test(choice.id)
      || !Number.isSafeInteger(choice.quantity) || choice.quantity < 1
      || choice.quantity > MAX_SERVICE_QUANTITY || selected.has(choice.id)) {
      invalid("API_EXTRAS_INVALID_SELECTION");
    }
    selected.set(choice.id, choice.quantity);
  }
  const copy = structuredClone(model);
  const matched = new Set();
  copy.Services = copy.Services.map(service => {
    if (!record(service)) return service;
    const id = serviceId(service);
    if (!id) return service;
    const key = `renteon:${id}`;
    if (service.IsMandatory === true) {
      if (selected.has(key)) invalid("API_EXTRAS_MANDATORY_SERVICE");
      return service;
    }
    if (!selected.has(key)) {
      return replace ? { ...service, IsSelected: false, Quantity: 0 } : service;
    }
    const requested = selected.get(key);
    if (requested > quantityLimit(service)) invalid("API_EXTRAS_QUANTITY_EXCEEDED");
    matched.add(key);
    return { ...service, IsSelected: true, Quantity: requested };
  });
  if (matched.size !== selected.size) invalid("API_EXTRAS_UNKNOWN_SERVICE");
  return copy;
}

export function assertRenteonExtrasConfirmed(model, selections) {
  const services = serviceEntries(model);
  const selected = Array.isArray(selections) ? selections : invalid("API_EXTRAS_INVALID_SELECTION");
  for (const choice of selected) {
    const found = services.filter(service => record(service)
      && service.IsMandatory !== true && `renteon:${serviceId(service)}` === choice.id);
    if (found.length !== 1 || found[0].IsSelected !== true
      || Number(found[0].Quantity) !== choice.quantity) {
      invalid("API_EXTRAS_PROVIDER_DID_NOT_ACCEPT");
    }
  }
  return true;
}

export function assertRenteonRepricedTotal(model) {
  if (!record(model)) invalid("API_EXTRAS_PRICING_UNAVAILABLE");
  const value = Number(model.Total);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    invalid("API_EXTRAS_PRICING_UNAVAILABLE");
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
