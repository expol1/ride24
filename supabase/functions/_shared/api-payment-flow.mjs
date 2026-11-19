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

// Arvent must approve (status 1) within 30 minutes of payment (agreed with
// Arvent 2026-11-19: manual approval, vehicle assigned within 30 min), and
// never later than 2h before local pickup (Turkey, UTC+3). Epoch ms or null.
export const ARVENT_APPROVAL_MINUTES=30;
export function arventApprovalDeadline(w) {
  if(w?.prepared_quote?.provider!=='arvent_kolaycar')return null;
  const paid=Date.parse(w.paid_at);
  if(!Number.isFinite(paid))return null;
  let deadline=paid+ARVENT_APPROVAL_MINUTES*60000;
  const d=String(w.prepared_quote.pickup_date||''),t=String(w.prepared_quote.pickup_time||'');
  const pickup=/^\d{4}-\d{2}-\d{2}$/.test(d)&&/^\d{2}:\d{2}/.test(t)?Date.parse(d+'T'+t.slice(0,5)+':00+03:00'):NaN;
  if(Number.isFinite(pickup))deadline=Math.min(deadline,pickup-2*3600000);
  return deadline;
}
const ARVENT_TIMEOUT_STATES=new Set(['ARVENT_APPROVAL_OVERDUE','ARVENT_TIMEOUT_CANCEL_UNCONFIRMED']);

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
  // Arvent did not approve in time: read once more, then cancel at Arvent and
  // refund ONLY after the supplier itself shows the reservation cancelled.
  if(w.provider_reference&&(w.state==='provider_pending'||(w.state==='unknown'&&ARVENT_TIMEOUT_STATES.has(w.last_error)))) {
    const deadline=arventApprovalDeadline(w);
    if(deadline!==null&&Date.now()>=deadline&&deps.cancel) {
      const current=await deps.status(id,w).catch(()=>null);
      if(current?.status==='confirmed'&&current.needs_manual_review!==true)return await acceptResult(current,w.state);
      if(current?.status==='rejected'&&current.definitive_rejection===true)return await acceptResult(current,w.state);
      const cancelled=await deps.cancel(id,w).catch(()=>null);
      if(cancelled?.status==='cancelled'&&cancelled.needs_manual_review!==true) {
        await move(w.state,'refund_pending',{last_error:'ARVENT_APPROVAL_TIMEOUT'});
        return {state:'refund_pending'};
      }
      if(!(w.state==='unknown'&&w.last_error==='ARVENT_TIMEOUT_CANCEL_UNCONFIRMED'))
        await move(w.state,'unknown',{last_error:'ARVENT_TIMEOUT_CANCEL_UNCONFIRMED'});
      return {state:'unknown'};
    }
  }
  if(w.state==='unknown') {
    // Lookup is read-only. An empty/unsupported lookup is NOT proof of absence.
    const recovered=await deps.recover(id,w).catch(()=>null);
    if(!recovered)return {state:'unknown'};
    // Still awaiting Arvent approval: stay flagged instead of bouncing states.
    if(w.last_error==='ARVENT_APPROVAL_OVERDUE'&&recovered.status==='pending'&&recovered.needs_manual_review!==true)
      return {state:'unknown'};
    return await acceptResult(recovered,'unknown');
  }
  if(w.state==='provider_pending') {
    // Use the immutable payment time. Polling refreshes updated_at on each pass.
    // Arvent approval timeout (30 min) is handled above, before this read.
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
  catch(error) {
    if(prepared.provider==='arvent_kolaycar'&&error instanceof DefiniteApiFailure&&error.message==='ARVENT_FAILED_BEFORE_SAVE'){
      await move('dispatching','refund_pending',{last_error:error.message});
      return {state:'refund_pending'};
    }
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
