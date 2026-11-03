import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renteonExtrasCatalog,
  applyRenteonExtras,
  assertRenteonExtrasConfirmed,
  assertRenteonRepricedTotal,
} from '../../supabase/functions/_shared/provider-extras.mjs';

const model = () => ({ Total: 100, Services: [
  { ServiceId: 1, Name: 'Full insurance', IsMandatory: true, IsSelected: true, Quantity: 1 },
  { ServiceId: 2, Name: 'Child seat', IsMandatory: false, IsSelected: false, Quantity: 0, IsQuantityEditable: true, MaximumQuantity: 3 },
  { ServiceId: 3, Name: 'GPS', IsMandatory: false, IsSelected: false, Quantity: 0, IsQuantityEditable: false, MaximumQuantity: 8 },
] });

test('Renteon exposes optional provider IDs and never manufactures unit prices', () => {
  const catalog = renteonExtrasCatalog(model());
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].id, 'renteon:2');
  assert.equal(catalog[0].max_quantity, 3);
  assert.equal(catalog[1].max_quantity, 1);
  assert.equal(catalog[0].unit_customer_cents, null);
});

test('selected seats, included insurance and provider response stay valid', () => {
  const original = model();
  const selected = [{ id: 'renteon:2', quantity: 2 }];
  const updated = applyRenteonExtras(original, selected, { replace: true });
  assert.equal(original.Services[1].Quantity, 0);
  assert.equal(updated.Services[0].IsSelected, true);
  assert.equal(updated.Services[1].IsSelected, true);
  assert.equal(updated.Services[1].Quantity, 2);
  assert.equal(updated.Services[2].IsSelected, false);
  assert.equal(assertRenteonExtrasConfirmed(updated, selected), true);
});

test('provider defaults are not disabled without an explicit selection mode', () => {
  const draft = model();
  draft.Services[2].IsSelected = true;
  draft.Services[2].Quantity = 1;
  const updated = applyRenteonExtras(draft, [{ id: 'renteon:2', quantity: 1 }]);
  assert.equal(updated.Services[2].IsSelected, true);
});

test('tampered IDs, duplicates, mandatory products and excessive quantities fail closed', () => {
  const cases = [
    [[{ id: 'renteon:999', quantity: 1 }], 'API_EXTRAS_UNKNOWN_SERVICE'],
    [[{ id: 'renteon:2', quantity: 4 }], 'API_EXTRAS_QUANTITY_EXCEEDED'],
    [[{ id: 'renteon:3', quantity: 2 }], 'API_EXTRAS_QUANTITY_EXCEEDED'],
    [[{ id: 'renteon:1', quantity: 1 }], 'API_EXTRAS_MANDATORY_SERVICE'],
    [[{ id: 'not-from-provider', quantity: 1 }], 'API_EXTRAS_INVALID_SELECTION'],
    [[{ id: 'renteon:2', quantity: 1 }, { id: 'renteon:2', quantity: 1 }], 'API_EXTRAS_INVALID_SELECTION'],
  ];
  for (const [choices, code] of cases) {
    assert.throws(() => applyRenteonExtras(model(), choices), { message: code });
  }
});

test('provider must confirm selected options and valid nonzero total', () => {
  assert.throws(() => assertRenteonExtrasConfirmed(model(), [{ id: 'renteon:2', quantity: 1 }]), {
    message: 'API_EXTRAS_PROVIDER_DID_NOT_ACCEPT',
  });
  assert.equal(assertRenteonRepricedTotal({ Total: 150.25 }), 150.25);
  assert.throws(() => assertRenteonRepricedTotal({ Total: 0 }), { message: 'API_EXTRAS_PRICING_UNAVAILABLE' });
  assert.throws(() => assertRenteonRepricedTotal({ Total: 'bad' }), { message: 'API_EXTRAS_PRICING_UNAVAILABLE' });
});
