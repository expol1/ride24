// Durable API-only workflow. State transitions are compare-and-set operations.
// Provider create is never retried after an ambiguous response or worker death.
export const API_PAYMENT_STATES = ['awaiting_payment','paid','revalidating','dispatching','unknown','provider_pending','confirmed','refund_pending','refunding','refunded','refund_failed','abandoned'];
export function verifyApiPayment(booking, session, liveMode) {
  const cents=Math.round(Number(booking.online_payment_pln)*100);
  if(session.mode!=='payment'||session.payment_status!=='paid'||session.status!=='complete'
    ||session.livemode!==liveMode||session.currency!=='pln'||!Number.isSafeInteger(cents)||cents<=0
    ||session.amount_total!==cents||session.id!==booking.stripe_session_id
    ||session.metadata?.booking_id!==booking.id||session.metadata?.client_id!==booking.client_id
    ||session.client_reference_id!==booking.id||typeof session.payment_intent!=='string'
    ||!session.payment_intent.startsWith('pi_'))throw Error('API_PAYMENT_MISMATCH');
  return {session_id:session.id,event_amount:cents,currency:'pln',payment_intent:session.payment_intent};
}
export class DefiniteApiFailure extends Error {}

export async function advanceApiPayment(deps,id) {
  let w=await deps.get(id);
  if(!w||!w.paid_at||!w.payment_intent||['awaiting_payment','abandoned'].includes(w.state))return {skipped:true};
  const move=async(from,state,extra={})=>deps.move(id,from,{state,updated_at:new Date().toISOString(),...extra});
  if(w.state==='confirmed') {await deps.finalize(id);return {state:'confirmed'};}
  if(w.state==='refunded'||w.state==='refund_failed') {await deps.refundNotice(id);return {state:w.state};}
  if(w.state==='dispatching') {
    if(Date.now()-Date.parse(w.updated_at)<120000)return {state:'dispatching'};
    w=await move('dispatching','unknown',{last_error:'WORKER_INTERRUPTED_AFTER_DISPATCH'});
    if(!w)return {skipped:true};
  }
  if(w.state==='unknown') {
    // Lookup is read-only. An empty/unsupported lookup is NOT proof of absence.
    const recovered=await deps.recover(id,w).catch(()=>null);
    if(!recovered)return {state:'unknown'};
    return await acceptResult(recovered,'unknown');
  }
  if(w.state==='provider_pending') {
    const result=await deps.status(id,w);return await acceptResult(result,'provider_pending');
  }
  if(w.state==='refund_pending'||w.state==='refunding') {
    // Stripe uses a stable idempotency key, plus read-back by payment intent.
    if(w.state==='refund_pending')w=await move('refund_pending','refunding',{refund_started_at:new Date().toISOString()});
    if(!w)return {skipped:true};
    const refund=await deps.refund(id,w);
    const state=refund.status==='succeeded'?'refunded':['failed','canceled'].includes(refund.status)?'refund_failed':'refunding';
    await move('refunding',state,{refund_id:refund.id,refund_status:refund.status});
    await deps.refundNotice(id);return {state};
  }
  if(w.state==='revalidating' && Date.now()-Date.parse(w.updated_at)<120000)return {state:'revalidating'};
  if(!['paid','revalidating'].includes(w.state))return {skipped:true};
  w=await deps.claimValidation(id,w);
  if(!w)return {skipped:true};
  let prepared;
  try {prepared=await deps.revalidate(id,w);}
  catch(error) {
    if(error instanceof DefiniteApiFailure) {
      await move('revalidating','refund_pending',{last_error:error.message});
      return {state:'refund_pending'};
    }
    await move('revalidating','paid',{last_error:'REVALIDATION_UNAVAILABLE'});
    return {state:'paid',retry:true};
  }
  // Cancellation is checked again under the database row lock in this transition.
  w=await deps.claimDispatch(id,prepared);
  if(!w)return {skipped:true};
  let result;
  try {result=await deps.create(id,prepared);}
  catch {
    await move('dispatching','unknown',{last_error:'PROVIDER_CREATE_OUTCOME_UNKNOWN'});
    return {state:'unknown'};
  }
  return await acceptResult(result,'dispatching');

  async function acceptResult(result,from) {
    const reference=typeof result?.booking_reference==='string'?result.booking_reference:result?.reference;
    if(result?.status==='rejected' && result?.definitive_rejection===true) {
      await move(from,'refund_pending',{provider_reference:reference||null,last_error:'PROVIDER_REJECTED'});
      return {state:'refund_pending'};
    }
    if(!reference||result?.needs_manual_review===true||!['confirmed','pending'].includes(result.status)) {
      await move(from,'unknown',{provider_reference:reference||null,last_error:'PROVIDER_RESPONSE_REQUIRES_REVIEW'});
      return {state:'unknown'};
    }
    const state=result.status==='confirmed'?'confirmed':'provider_pending';
    const saved=await move(from,state,{provider_reference:reference,provider_response:result});
    if(saved && state==='confirmed')await deps.finalize(id);
    return {state};
  }
}
