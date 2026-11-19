import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceApiPayment,verifyApiPayment,DefiniteApiFailure,arventApprovalDeadline} from '../../supabase/functions/_shared/api-payment-flow.mjs';
function setup(options={}) {
 let row={booking_id:'b',state:'paid',paid_at:'2026-11-13T10:00:00Z',payment_intent:'pi_test',updated_at:new Date().toISOString(),...options.row};
 const calls=[];
 const deps={get:async()=>structuredClone(row),move:async(id,from,p)=>{if(row.state!==from)return null;Object.assign(row,p);return structuredClone(row);},
 claimValidation:async(id,w)=>{if(row.state!==w.state||row.updated_at!==w.updated_at)return null;row.state='revalidating';return structuredClone(row);},
 claimDispatch:async()=>{if(row.state!=='revalidating')return null;row.state='dispatching';return structuredClone(row);},
 revalidate:async()=>{calls.push('revalidate');if(options.revalidateError)throw options.revalidateError;return {total:100};},
 create:async()=>{calls.push('create');if(options.createError)throw options.createError;return options.result||{status:'confirmed',booking_reference:'demo-1'};},
 recover:async()=>{calls.push('lookup');return options.recovered||null;},
 status:async()=>{calls.push('status');return options.status||{status:'pending',booking_reference:'demo-1'};},
 cancel:async()=>{calls.push('cancel');if(options.cancelError)throw options.cancelError;return options.cancel||{status:'cancelled',booking_reference:'A-1'};},
 finalize:async()=>{calls.push('voucher-email-push');},refund:async()=>{calls.push('refund');return options.refund||{id:'re_test',status:'succeeded'};},refundNotice:async()=>{calls.push('refund-notice');}};
 return {deps,calls,row};
}
test('paid event revalidates before one provider create and only then confirms',async()=>{
 const s=setup();await advanceApiPayment(s.deps,'b');assert.deepEqual(s.calls,['revalidate','create','voucher-email-push']);assert.equal(s.row.state,'confirmed');
});
for(const state of ['awaiting_payment','abandoned'])test(`${state}: zero supplier bookings`,async()=>{
 const s=setup({row:{state,paid_at:null,payment_intent:null}});await advanceApiPayment(s.deps,'b');assert.deepEqual(s.calls,[]);
});
test('concurrent repeated webhook/workers do not duplicate provider save',async()=>{
 const s=setup();await Promise.all([advanceApiPayment(s.deps,'b'),advanceApiPayment(s.deps,'b'),advanceApiPayment(s.deps,'b')]);
 assert.equal(s.calls.filter(x=>x==='create').length,1);
});
for(const reason of ['PROVIDER_UNAVAILABLE','PROVIDER_PRICE_OR_SERVICES_CHANGED','PROVIDER_TERMS_CHANGED'])test(reason+' refunds without supplier create',async()=>{
 const s=setup({revalidateError:new DefiniteApiFailure(reason)});await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'refund_pending');
 await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'refunded');assert.ok(!s.calls.includes('create'));assert.ok(!s.calls.includes('voucher-email-push'));
});
test('read-only network failure is retryable and does not prematurely refund',async()=>{
 const s=setup({revalidateError:Error('network')});await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'paid');assert.deepEqual(s.calls,['revalidate']);
});
test('save timeout is unknown: lookup first, no retry and no refund',async()=>{
 const s=setup({createError:Error('timeout')});await advanceApiPayment(s.deps,'b');await advanceApiPayment(s.deps,'b');
 assert.deepEqual(s.calls,['revalidate','create','lookup']);assert.equal(s.row.state,'unknown');
});
test('dead worker after dispatch does not cause another save',async()=>{
 const s=setup({row:{state:'dispatching',updated_at:'2026-01-01T00:00:00Z'}});await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'unknown');assert.deepEqual(s.calls,['lookup']);
});
test('provider on-request has no voucher until real confirmation',async()=>{
 const s=setup({result:{status:'pending',booking_reference:'demo-1'},status:{status:'confirmed',booking_reference:'demo-1'}});
 await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'provider_pending');assert.ok(!s.calls.includes('voucher-email-push'));
 await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'confirmed');
});
test('definite provider rejection refunds; generic error cannot impersonate rejection',async()=>{
 for(const definitive of [true,false]) {const s=setup({result:{status:'rejected',definitive_rejection:definitive}});await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,definitive?'refund_pending':'unknown');}
});
test('saved reference with price discrepancy needs review and no voucher',async()=>{
 const s=setup({result:{status:'confirmed',booking_reference:'demo-1',needs_manual_review:true}});await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,'unknown');assert.ok(!s.calls.includes('voucher-email-push'));
});
for(const status of ['pending','failed','succeeded'])test(`Stripe refund ${status} is accurately represented`,async()=>{
 const s=setup({row:{state:'refund_pending'},refund:{id:'re_test',status}});await advanceApiPayment(s.deps,'b');assert.equal(s.row.state,{pending:'refunding',failed:'refund_failed',succeeded:'refunded'}[status]);
});
const booking={id:'b',client_id:'u',online_payment_pln:123.45,stripe_session_id:'cs_test'};
const session={id:'cs_test',mode:'payment',payment_status:'paid',status:'complete',livemode:false,currency:'pln',amount_total:12345,metadata:{booking_id:'b',client_id:'u'},client_reference_id:'b',payment_intent:'pi_test'};
test('Stripe fee is exact server PLN amount, not supplier rental',()=>assert.equal(verifyApiPayment(booking,session,false).event_amount,12345));
for(const patch of [{amount_total:12344},{currency:'eur'},{payment_status:'unpaid'},{status:'open'},{id:'cs_other'},{metadata:{booking_id:'other',client_id:'u'}},{livemode:true},{payment_intent:null}])test('reject mismatched Stripe '+JSON.stringify(patch),()=>assert.throws(()=>verifyApiPayment(booking,{...session,...patch},false)));

test('existing supplier reference is reconciled by status without re-saving',async()=>{
 const s=setup({row:{state:'provider_pending',provider_reference:'26-P2-8302'},
   status:{status:'confirmed',booking_reference:'26-P2-8302'}});
 const result=await advanceApiPayment(s.deps,'b');
 assert.equal(result.state,'confirmed');
 assert.equal(s.row.provider_reference,'26-P2-8302');
 assert.deepEqual(s.calls,['status','voucher-email-push']);
 assert.ok(!s.calls.includes('create'));
});

test('Arvent overdue approval enters manual review with original reference and no financial action',async()=>{
 const s=setup({row:{state:'provider_pending',provider_reference:'A-1',
  paid_at:new Date(Date.now()-61*60000).toISOString(),prepared_quote:{provider:'arvent_kolaycar'}}});
 await advanceApiPayment(s.deps,'b');
 assert.equal(s.row.state,'unknown');
 assert.equal(s.row.provider_reference,'A-1');
 assert.equal(s.row.last_error,'ARVENT_APPROVAL_OVERDUE');
 assert.deepEqual(s.calls,[]);
});

test('overdue Arvent approval keeps read-only reconciliation: stays flagged while pending, confirms on approval',async()=>{
 const base={state:'unknown',provider_reference:'A-1',last_error:'ARVENT_APPROVAL_OVERDUE',
  paid_at:new Date(Date.now()-61*60000).toISOString(),prepared_quote:{provider:'arvent_kolaycar'}};
 const waiting=setup({row:base,recovered:{status:'pending',booking_reference:'A-1'}});
 await advanceApiPayment(waiting.deps,'b');
 assert.equal(waiting.row.state,'unknown');assert.deepEqual(waiting.calls,['lookup']);
 const approved=setup({row:base,recovered:{status:'confirmed',booking_reference:'A-1'}});
 await advanceApiPayment(approved.deps,'b');
 assert.equal(approved.row.state,'confirmed');assert.deepEqual(approved.calls,['lookup','voucher-email-push']);
 assert.ok(!approved.calls.includes('create'));
});

test('definite Arvent failure before save qualifies for full refund, ambiguous transport failure does not',async()=>{
 for(const [error,expected] of [[new DefiniteApiFailure('ARVENT_FAILED_BEFORE_SAVE'),'refund_pending'],[Error('timeout'),'unknown']]){
  const s=setup({createError:error});
  s.deps.revalidate=async()=>({provider:'arvent_kolaycar'});
  await advanceApiPayment(s.deps,'b');
  assert.equal(s.row.state,expected);
 }
});

const late={state:'provider_pending',provider_reference:'A-1',
 paid_at:new Date(Date.now()-25*3600000).toISOString(),
 prepared_quote:{provider:'arvent_kolaycar',pickup_date:'2030-06-01',pickup_time:'10:00'}};
test('Arvent not approved within 24h: cancelled at supplier first, then full refund',async()=>{
 const s=setup({row:late});
 await advanceApiPayment(s.deps,'b');
 assert.equal(s.row.state,'refund_pending');assert.equal(s.row.last_error,'ARVENT_APPROVAL_TIMEOUT');
 assert.deepEqual(s.calls,['status','cancel']);
 await advanceApiPayment(s.deps,'b');
 assert.equal(s.row.state,'refunded');assert.ok(s.calls.includes('refund'));assert.ok(!s.calls.includes('create'));
});
test('Arvent timeout without confirmed supplier cancellation never refunds',async()=>{
 for(const opt of [{cancel:{status:'pending',booking_reference:'A-1',needs_manual_review:true}},{cancelError:Error('timeout')}]){
  const s=setup({row:late,...opt});
  await advanceApiPayment(s.deps,'b');
  assert.equal(s.row.state,'unknown');assert.equal(s.row.last_error,'ARVENT_TIMEOUT_CANCEL_UNCONFIRMED');
  assert.ok(!s.calls.includes('refund'));
 }
});
test('Arvent approval read at the deadline still confirms instead of cancelling',async()=>{
 const s=setup({row:late,status:{status:'confirmed',booking_reference:'A-1'}});
 await advanceApiPayment(s.deps,'b');
 assert.equal(s.row.state,'confirmed');assert.ok(!s.calls.includes('cancel'));
});
test('Arvent approval deadline is 24h after payment, but at least 2h before local pickup',()=>{
 const paid='2026-11-19T14:40:00Z';
 assert.equal(arventApprovalDeadline({paid_at:paid,prepared_quote:{provider:'arvent_kolaycar',pickup_date:'2027-02-16',pickup_time:'10:00:00'}}),Date.parse('2026-11-20T14:40:00Z'));
 assert.equal(arventApprovalDeadline({paid_at:paid,prepared_quote:{provider:'arvent_kolaycar',pickup_date:'2026-11-20',pickup_time:'09:00'}}),Date.parse('2026-11-20T04:00:00Z'));
 assert.equal(arventApprovalDeadline({paid_at:paid,prepared_quote:{provider:'renteon_aggregator'}}),null);
});
test('other providers never use the Arvent approval timeout',async()=>{
 const s=setup({row:{...late,prepared_quote:{provider:'renteon_aggregator'}}});
 await advanceApiPayment(s.deps,'b');
 assert.ok(!s.calls.includes('cancel'));assert.equal(s.row.state,'provider_pending');
});
