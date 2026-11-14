import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertVoucherCompleted} from '../../supabase/functions/_shared/api-voucher-confirmation.mjs';

test('voucher can mark workflow fulfilled only with explicit completed voucher response',()=>{
  assert.equal(assertVoucherCompleted(200,{success:true,existing:false,reservation_code:'R24-TEST'}),true);
  assert.equal(assertVoucherCompleted(200,{success:true,existing:true,reservation_code:'R24-TEST'}),true);
});
test('voucher still generating, skipped, missing code and errors must keep workflow retryable',()=>{
 for(const [code,body] of [
   [202,{success:true,generating:true}],
   [200,{success:true,skipped:true,reason:'BOOKING_NOT_PAID'}],
   [200,{success:true}],
   [200,{success:false,reservation_code:'R24-TEST'}],
   [409,{error:'API_CONFIRMATION_REQUIRED'}],
   [500,null]
 ])assert.throws(()=>assertVoucherCompleted(code,body),/API_CONFIRMATION_DELIVERY_INCOMPLETE/);
});
test('payment worker checks actual voucher delivery outcome before fulfilled_at write',async()=>{
 const runtime=await readFile(new URL('../../supabase/functions/_shared/api-payment-runtime.ts',import.meta.url),'utf8');
 assert.match(runtime,/assertVoucherCompleted\(response\.status,body\)/);
 assert.match(runtime,/await internalCall\('generate-voucher',id\)/);
});

test('completed Stripe refund remains in retry sweep until notification and accounting are persisted',async()=>{
  const cron=await readFile(new URL('../../supabase/functions/api-booking-status-sync/index.ts',import.meta.url),'utf8');
  assert.ok(cron.includes("'refund_pending','refunding','refunded','refund_failed'"));
  const runtime=await readFile(new URL('../../supabase/functions/_shared/api-payment-runtime.ts',import.meta.url),'utf8');
  assert.ok(runtime.includes("if(status!=='pending')"));
  assert.ok(runtime.includes("fulfilled_at:new Date().toISOString()"));
});

test('API voucher visibly reserves category rather than a guaranteed model, with free upgrade',async()=>{
  const source=await readFile(new URL('../../supabase/functions/generate-voucher/index.ts',import.meta.url),'utf8');
  assert.match(source,/if \(booking\.api_booking_reference\) \{/);
  assert.match(source,/Category booking: same group or free upgrade/);
  assert.match(source,/Rezerwacja kategorii: taka sama lub wyższa bez dopłaty/);
});
