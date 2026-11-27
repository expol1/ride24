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

// Arvent must approve (status 1) within 24 hours of ACCEPTING the paid
// reservation in its API (status 0 received), agreed 2026-11-20. The deadline
// is persisted on the workflow (supplier_deadline_at) when the supplier first
// accepts it, and is never later than 2h before local pickup (UTC+3).
export const ARVENT_APPROVAL_HOURS=24;
function arventPickupMs(q) {
  const d=String(q?.pickup_date||''),t=String(q?.pickup_time||'');
  return /^\d{4}-\d{2}-\d{2}$/.test(d)&&/^\d{2}:\d{2}/.test(t)?Date.parse(d+'T'+t.slice(0,5)+':00+03:00'):NaN;
}
export function arventDeadlineFrom(receivedMs,prepared) {
  if(!Number.isFinite(receivedMs))return null;
  let deadline=receivedMs+ARVENT_APPROVAL_HOURS*3600000;
  const pickup=arventPickupMs(prepared);
  if(Number.isFinite(pickup))deadline=Math.min(deadline,pickup-2*3600000);
  return deadline;
}
export function arventApprovalDeadline(w) {
  if(w?.prepared_quote?.provider!=='arvent_kolaycar')return null;
  const stored=Date.parse(w.supplier_deadline_at);
  if(Number.isFinite(stored))return stored;
  // Legacy rows without a stored receipt time: payment time is the earliest bound.
  return arventDeadlineFrom(Date.parse(w.supplier_received_at||w.paid_at),w.prepared_quote);
}
const ARVENT_TIMEOUT_STATES=new Set(['ARVENT_APPROVAL_OVERDUE','ARVENT_TIMEOUT_CANCELLING','ARVENT_TIMEOUT_CANCEL_UNCONFIRMED']);

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
  // Arvent did not approve in time. In provider_pending: read once more (an
  // approval at the deadline still confirms), then CLAIM the cancellation with
  // a compare-and-set to unknown/ARVENT_TIMEOUT_CANCELLING so no parallel
  // worker can confirm (voucher) while this one cancels (refund). From the
  // claim on, only the supplier's cancelled status 3 leads to a refund.
  if(w.provider_reference&&(w.state==='provider_pending'||(w.state==='unknown'&&ARVENT_TIMEOUT_STATES.has(w.last_error)))) {
    const deadline=arventApprovalDeadline(w);
    if(deadline!==null&&Date.now()>=deadline&&deps.cancel) {
      if(w.state==='provider_pending') {
        // Arvent only: a confirmation email delivered before the (never reset)
        // deadline that is still being fetched or verified wins this race.
        // A failed lookup must not let the cancellation through either.
        if(deps.emailConfirmationPending
          && await deps.emailConfirmationPending(id,w,deadline).catch(()=>true))
          return {state:'provider_pending',email_pending:true};
        const current=await deps.status(id,w).catch(()=>null);
        // Never cancel blind: a failed status GET could conceal a freshly
        // approved booking. Stay provider_pending and retry the read next tick.
        if(!current)return {state:'provider_pending',retry:true};
        if(current?.status==='confirmed'&&current.needs_manual_review!==true)return await acceptResult(current,'provider_pending');
        if(current?.needs_manual_review===true){
          // A supplier approval with mismatched price, route, extra or Ride24
          // reference is not a request to cancel a potentially valid booking.
          // Reconcile it manually before ANY cancellation or Stripe refund.
          await move('provider_pending','unknown',{last_error:'ARVENT_RECONCILIATION_REQUIRED'});
          return {state:'unknown'};
        }
        if(current?.status==='rejected'&&current.definitive_rejection===true)return await acceptResult(current,'provider_pending');
        // Only an explicitly observed pending request can be cancelled
        // automatically at the approval deadline. Any other response needs
        // reconciliation instead of a supplier POST.
        if(current.status!=='pending'){
          await move('provider_pending','unknown',{last_error:'ARVENT_RECONCILIATION_REQUIRED'});
          return {state:'unknown'};
        }
        w=await move('provider_pending','unknown',{last_error:'ARVENT_TIMEOUT_CANCELLING'});
        if(!w)return {skipped:true};
      }
      // Idempotent: a repeated call never re-POSTs (durable claim per booking)
      // and only reads the supplier status back.
      const cancelled=await deps.cancel(id,w).catch(()=>null);
      if(cancelled?.status==='cancelled' && cancelled.supplier_status_type===3
        && cancelled.booking_reference===w.provider_reference && cancelled.needs_manual_review===false) {
        await move('unknown','refund_pending',{last_error:'ARVENT_APPROVAL_TIMEOUT',provider_response:cancelled});
        return {state:'refund_pending'};
      }
      if(w.last_error!=='ARVENT_TIMEOUT_CANCEL_UNCONFIRMED')
        await move('unknown','unknown',{last_error:'ARVENT_TIMEOUT_CANCEL_UNCONFIRMED'});
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
    if(prepared.provider==='arvent_kolaycar'&&error instanceof DefiniteApiFailure&&/^ARVENT_FAILED_BEFORE_SAVE(?::ARVENT_[A-Z_]+)?$/.test(error.message)){
      await move('dispatching','refund_pending',{last_error:error.message});
      return {state:'refund_pending'};
    }
    await move('dispatching','unknown',{last_error:'PROVIDER_CREATE_OUTCOME_UNKNOWN'});
    return {state:'unknown'};
  }
  return await acceptResult(result,'dispatching');

  async function acceptResult(result,from) {
    const reference=typeof result?.booking_reference==='string'?result.booking_reference:result?.reference;
    // Arvent-specific fail-safe: no voucher or Stripe refund if the supplier
    // reference, rate, route or purchased extras have not been reconciled.
    // Do not change AVIA/Caravel/local partners' payment handling.
    if(w.prepared_quote?.provider==='arvent_kolaycar'&&result?.needs_manual_review===true){
      await move(from,'unknown',{provider_reference:reference||null,
        last_error:'ARVENT_RECONCILIATION_REQUIRED'});
      return {state:'unknown'};
    }
    if(result?.status==='rejected' && result?.definitive_rejection===true) {
      await move(from,'refund_pending',{provider_reference:reference||null,last_error:'PROVIDER_REJECTED'});
      return {state:'refund_pending'};
    }
    if(!reference||result?.needs_manual_review===true||!['confirmed','pending'].includes(result.status)) {
      await move(from,'unknown',{provider_reference:reference||null,last_error:'PROVIDER_RESPONSE_REQUIRES_REVIEW'});
      return {state:'unknown'};
    }
    const state=result.status==='confirmed'?'confirmed':'provider_pending';
    const extra={provider_reference:reference,provider_response:result};
    if(w.prepared_quote?.provider==='arvent_kolaycar'&&!w.supplier_received_at) {
      // First supplier acceptance: start the persisted 24h approval window.
      const received=from==='unknown' && Number.isFinite(Date.parse(w.paid_at))
        ?Math.min(Date.now(),Date.parse(w.paid_at)):Date.now();
      extra.supplier_received_at=new Date(received).toISOString();
      const deadline=arventDeadlineFrom(received,w.prepared_quote);
      if(deadline!==null)extra.supplier_deadline_at=new Date(deadline).toISOString();
    }
    const saved=await move(from,state,extra);
    if(saved && state==='confirmed')await deps.finalize(id);
    return {state};
  }
}
