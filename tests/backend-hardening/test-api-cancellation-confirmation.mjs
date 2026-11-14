import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertSupplierCancellation} from '../../supabase/functions/_shared/api-cancellation-confirmation.mjs';

const ref='26-P2-8302';
test('verified supplier cancellation accepts matching confirmed status and reference',()=>{
  assert.equal(assertSupplierCancellation({status:'cancelled',booking_reference:ref},ref),true);
  assert.equal(assertSupplierCancellation({status:'cancelled',reference:ref},ref),true);
});
test('pending, approved, null, mismatched or unbound supplier cancellation never counts as cancelled',()=>{
  for (const r of [null,undefined,{}, {status:'pending',reference:ref},
      {status:'confirmed',reference:ref},{status:'cancelled',reference:'different'},
      {status:'cancelled'},{status:'cancelled',reference:ref,booking_reference:'different'}]) {
    assert.throws(()=>assertSupplierCancellation(r,ref),/API_CANCEL_(NOT_CONFIRMED|REFERENCE_MISMATCH)/);
  }
});
test('both customer cancellation and cron-based cancellation must validate supplier confirmation before marking cancelled',async()=>{
  const customer=await readFile(new URL('../../supabase/functions/client-cancel-booking/index.ts',import.meta.url),'utf8');
  const sync=await readFile(new URL('../../supabase/functions/api-booking-status-sync/index.ts',import.meta.url),'utf8');
  const adapters=await readFile(new URL('../../supabase/functions/_shared/provider-adapters.ts',import.meta.url),'utf8');
  assert.match(customer,/assertSupplierCancellation\\(response, booking\\.api_booking_reference\\)/);
  assert.match(sync,/assertSupplierCancellation\\(response, booking\\.api_booking_reference\\)/);
  assert.doesNotMatch(adapters,/canonical\\.status === "pending" \\? "cancelled"/);
});
