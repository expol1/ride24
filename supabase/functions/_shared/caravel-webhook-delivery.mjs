/**
 * Caravel SANDBOX durable webhook delivery orchestration.
 *
 * No Ride24 customer booking, Stripe, voucher or partner rows are mutated here.
 * The storage repository MUST enforce atomic claims, claim leases and revision
 * monotonicity across Edge instances; a JS Map is NOT an acceptable repository.
 *
 * Signed payloads only trigger a re-fetch. Never apply webhook .data as truth.
 */
import {verifyCaravelSignature, parseCaravelWebhookEvent} from "./caravel-webhooks.ts";

const MAX_BYTES=32768;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const enc=new TextEncoder();

export async function handleCaravelSandboxDelivery({
  method="POST", path, rawBody, signature, secrets, repository, fetchBooking, nowSecs,
}={}){
  if(method!=="POST")return {status:405,accepted:false,reason:"METHOD_NOT_ALLOWED"};
  if(typeof rawBody!=="string" || enc.encode(rawBody).byteLength>MAX_BYTES)
    return {status:413,accepted:false,reason:"BODY_TOO_LARGE"};
  if(!Array.isArray(secrets)||!secrets.some(x=>typeof x==="string"&&x.length>0))
    return {status:503,accepted:false,reason:"WEBHOOK_SECRET_UNAVAILABLE"};
  if(!await verifyCaravelSignature(signature,secrets,{method:"POST",path,body:rawBody},{nowSecs}))
    return {status:401,accepted:false,reason:"INVALID_SIGNATURE"};
  const event=parseCaravelWebhookEvent(rawBody);
  if(!event || !ID.test(event.booking_id) || !ID.test(event.operator_id) ||
    !ID.test(event.event_id) || !ID.test(event.supplier_id??"") ||
    !Number.isFinite(Date.parse(event.occurred_at)) ||
    (event.sequence!==null && event.sequence<1))
    return {status:400,accepted:false,reason:"INVALID_SIGNED_EVENT"};
  if(!repository?.claim || !repository?.finalize || !repository?.release ||
    typeof fetchBooking!=="function")
    return {status:503,accepted:false,reason:"DURABLE_RECEIVER_NOT_CONFIGURED"};
  const lease=crypto.randomUUID();
  let claimed=false;
  try{
    const acquired=await repository.claim(event,lease);
    if(acquired==="complete")return {status:200,accepted:true,reason:"DUPLICATE_ALREADY_PROCESSED"};
    if(acquired==="busy")return {status:503,accepted:false,reason:"EVENT_IN_PROGRESS"};
    if(acquired!=="claimed")throw new Error("CLAIM_INVALID");
    claimed=true;

    // Authority is GET /v1/bookings/{booking_id}. The signed snapshot is NOT
    // applied, and no customer/driver data is persisted in sandbox bookkeeping.
    const booking=await fetchBooking(event.booking_id,event.supplier_id);
    if(!booking || booking.booking_id!==event.booking_id ||
      (booking.supplier_id!==undefined && booking.supplier_id!==null &&
        booking.supplier_id!==event.supplier_id) ||
      !Number.isSafeInteger(booking.revision) || booking.revision<event.revision ||
      typeof booking.status!=="string" || !booking.status)
      throw new Error("BOOKING_REFETCH_NOT_CONFIRMED");
    const finalized=await repository.finalize(event,lease,{
      booking_id:booking.booking_id,revision:booking.revision,status:booking.status,
    });
    if(!finalized || !["applied","stale"].includes(finalized.outcome))
      throw new Error("ATOMIC_FINALIZE_UNCONFIRMED");
    return {status:202,accepted:true,reason:finalized.outcome==="stale"
      ? "STALE_EVENT_RECORDED":"EVENT_REFETCHED_AND_RECORDED",
      // Safe audit metadata only; if a sequence gap is observed, a SEPARATE
      // reconciliation job must page GET /v1/bookings?updated_since.
      sequence_gap:finalized.sequence_gap===true,needs_reconciliation:finalized.sequence_gap===true};
  }catch{
    if(claimed){
      try{await repository.release(event,lease);}catch{}
    }
    // Non-2xx is deliberate: Caravel should redeliver if storage/fetch failed.
    return {status:503,accepted:false,reason:"RETRYABLE_DELIVERY_FAILURE"};
  }
}
