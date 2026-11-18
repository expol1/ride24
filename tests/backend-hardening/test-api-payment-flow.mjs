import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceApiPayment,verifyApiPayment,DefiniteApiFailure} from '../../supabase/functions/_shared/api-payment-flow.mjs';
function setup(options={}) {
 let row={booking_id:'b',state:'paid',paid_at:'2026-11-13T10:00:00Z',payment_intent:'pi_test',updated_at:new Date().toISOString(),...options.row};
 const calls=[];
 const deps={get:async()=>structuredClone(row),move:async(id,from,p)=>{if(row.state!==from)return null;Object.assign(row,p);return structuredClone(row);},
 claimValidation:async(id,w)=>{if(row.state!==w.state||row.updated_at!==w.updated_at)return null;row.state='revalidating';return structuredClone(row);},
 claimDispatch:async()=>{if(row.state!=='revalidating')return null;row.state='dispatching';return structuredClone(row);},
 revalidate:async()=>{calls.push('revalidate');if(options.revalidateError)throw options.revalidateError;return {total:100};},
 create:async()=>{calls.push('create');if(options.createError)throw options.createError;return options.result||{status:'confirmed',booking_reference:'demo-1'};},
 recover:async()=>{calls.push('lookup');return options.recovered||null;},
 status:async()=>options.status||{status:'pending',booking_reference:'demo-1'},
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
 assert.deepEqual(s.calls,['voucher-email-push']);
 assert.ok(!s.calls.includes('create'));
});
