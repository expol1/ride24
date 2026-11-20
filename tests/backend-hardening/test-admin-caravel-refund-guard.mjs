import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = p => readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const sql=read('supabase/migrations/20261120125000_caravel_verified_manual_refund_guard.sql');
const html=read('admin/index.html');

test('manual refund retains strict admin-only authorization and one-row lock',()=>{
  assert.match(sql,/p\.id=auth\.uid\(\) and p\.role='admin'/);
  assert.match(sql,/from public\.bookings where id=p_id for update/);
  assert.match(sql,/REFUND_BOOKING_NOT_FOUND/);
  assert.match(sql,/REFUND_NOT_PENDING/);
  assert.match(sql,/set refund_status='completed', refund_completed_at=now\(\)/);
});
test('Caravel only: API-confirmed cancellation requires a matching booking reference and durable independent cancellation log',()=>{
  assert.match(sql,/b\.partner_id = '78721481-7619-44df-a9b7-5faa344b69bb'::uuid/);
  assert.match(sql,/b\.api_status is distinct from 'cancelled'/);
  assert.match(sql,/b\.api_response->>'status' is distinct from 'cancelled'/);
  assert.match(sql,/l\.booking_id = b\.id and l\.provider = 'caravel'/);
  assert.match(sql,/l\.action = 'cancel' and l\.status = 'cancelled'/);
  assert.match(sql,/l\.response_payload->>'status' = 'cancelled'/);
  assert.match(sql,/l\.response_payload->>'reference' = b\.api_booking_reference/);
  assert.match(sql,/l\.response_payload->>'booking_reference' = b\.api_booking_reference/);
});
test('manual settlement requires captured payment, valid amount and no automated refund evidence',()=>{
  assert.match(sql,/b\.refund_amount_pln > b\.online_payment_pln/);
  assert.match(sql,/pay\.booking_id = b\.id and pay\.status = 'paid'/);
  assert.match(sql,/w\.booking_id = b\.id and w\.paid_at is not null/);
  assert.match(sql,/w\.refund_id is not null or w\.refund_started_at is not null/);
  assert.match(sql,/API_REFUND_ALREADY_IN_PROGRESS/);
  assert.match(sql,/REFUND_AMOUNT_INVALID/);
});
test('all other API partners retain original blocked manual-review guard, local partners unchanged',()=>{
  const elseBlock=sql.slice(sql.indexOf('    else\n      -- Preserve existing strict guard'),sql.indexOf('\n    end if;\n  end if;',sql.indexOf('    else\n      -- Preserve existing strict guard')));
  assert.match(elseBlock,/b\.manual_review is true/);
  assert.match(elseBlock,/b\.api_booking_reference is not null and b\.api_status is distinct from 'cancelled'/);
  assert.match(sql,/if b\.provider_type='api' then/);
  assert.doesNotMatch(sql,/update public\.bookings[\s\S]*manual_review\s*=/i);
  assert.doesNotMatch(sql,/stripe\.refunds|stripe\.com|http_post/i);
});
test('admin requires confirming completed bank transfer and does not claim to transfer funds',()=>{
  const fn=html.slice(html.indexOf('async function markRefundDone(id) {'),html.indexOf('async function forceCancel(',html.indexOf('async function markRefundDone(id) {')));
  assert.match(fn,/Czy przelew zwrotny został już faktycznie wykonany/);
  assert.match(fn,/nie wysyła pieniędzy/i);
  assert.match(fn,/db\.rpc\("admin_mark_refund_done"/);
  assert.doesNotMatch(fn,/stripe\.refunds\.create|fetch\(.+stripe/i);
});
