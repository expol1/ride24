import {
  applyRenteonExtras,
  assertRenteonExtrasConfirmed,
  assertRenteonRepricedTotal,
  renteonExtrasCatalog,
} from "./provider-extras.mjs";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
function errorCode(run: () => unknown, code: string) {
  let caught = "";
  try { run(); } catch (error) { caught = (error as Error).message; }
  if (caught !== code) throw new Error(`Expected ${code}, got ${caught || "no error"}`);
}
function booking() {
  return {
    Total: 100,
    Services: [
      { ServiceId: 1, Name: "Full insurance", IsMandatory: true, IsSelected: true, Quantity: 1 },
      { ServiceId: 2, Name: "Child seat", IsMandatory: false, IsSelected: false, Quantity: 0, IsQuantityEditable: true, MaximumQuantity: 3 },
      { ServiceId: 3, Name: "GPS", IsMandatory: false, IsSelected: false, Quantity: 0, IsQuantityEditable: false, MaximumQuantity: 5 },
    ],
  };
}

Deno.test("Renteon catalog excludes mandatory services and never guesses prices", () => {
  const catalog = renteonExtrasCatalog(booking());
  assert(catalog.length === 2, "two optional services");
  assert(catalog[0].id === "renteon:2", "stable provider ID");
  assert(catalog[0].max_quantity === 3, "quantity limited by provider");
  assert(catalog[1].max_quantity === 1, "non-editable quantity limited to one");
  assert(catalog[0].unit_customer_cents === null, "unit price cannot be fabricated");
});

Deno.test("Renteon selection keeps mandatory insurance and original unchanged", () => {
  const original = booking();
  const result = applyRenteonExtras(original, [{ id: "renteon:2", quantity: 2 }], { replace: true });
  assert(result.Services[0].IsSelected === true, "mandatory insurance preserved");
  assert(result.Services[1].IsSelected === true && result.Services[1].Quantity === 2, "quantity selected");
  assert(result.Services[2].IsSelected === false, "unselected GPS off");
  assert(original.Services[1].Quantity === 0, "original provider response not mutated");
  assertRenteonExtrasConfirmed(result, [{ id: "renteon:2", quantity: 2 }]);
});

Deno.test("Renteon defaults are preserved in additive mode", () => {
  const input = booking();
  input.Services[2].IsSelected = true;
  input.Services[2].Quantity = 1;
  const result = applyRenteonExtras(input, [{ id: "renteon:2", quantity: 1 }]);
  assert(result.Services[2].IsSelected === true, "provider-selected defaults preserved");
});

Deno.test("Renteon options reject unknown IDs, duplicate and oversized selections", () => {
  errorCode(() => applyRenteonExtras(booking(), [{ id: "renteon:999", quantity: 1 }]), "API_EXTRAS_UNKNOWN_SERVICE");
  errorCode(() => applyRenteonExtras(booking(), [
    { id: "renteon:2", quantity: 1 }, { id: "renteon:2", quantity: 2 },
  ]), "API_EXTRAS_INVALID_SELECTION");
  errorCode(() => applyRenteonExtras(booking(), [{ id: "renteon:2", quantity: 4 }]), "API_EXTRAS_QUANTITY_EXCEEDED");
  errorCode(() => applyRenteonExtras(booking(), [{ id: "renteon:3", quantity: 2 }]), "API_EXTRAS_QUANTITY_EXCEEDED");
  errorCode(() => applyRenteonExtras(booking(), [{ id: "renteon:1", quantity: 1 }]), "API_EXTRAS_MANDATORY_SERVICE");
  errorCode(() => applyRenteonExtras(booking(), [{ id: "2", quantity: 1 }]), "API_EXTRAS_INVALID_SELECTION");
});

Deno.test("Renteon recalculation must confirm selected services and a valid total", () => {
  errorCode(() => assertRenteonExtrasConfirmed(booking(), [{ id: "renteon:2", quantity: 1 }]), "API_EXTRAS_PROVIDER_DID_NOT_ACCEPT");
  assert(assertRenteonRepricedTotal({ Total: 132.15 }) === 132.15, "provider total");
  errorCode(() => assertRenteonRepricedTotal({ Total: 0 }), "API_EXTRAS_PRICING_UNAVAILABLE");
  errorCode(() => assertRenteonRepricedTotal({ Total: "bad" }), "API_EXTRAS_PRICING_UNAVAILABLE");
});
