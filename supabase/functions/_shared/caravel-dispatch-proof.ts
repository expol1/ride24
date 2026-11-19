/**
 * Caravel: proof of the atomically claimed, Stripe-paid Ride24 booking.
 * PURE and NOT DEPLOYED. All fields MUST come from a fresh service-role
 * database read AFTER a conditional (compare-and-swap) UPDATE claiming
 * "caravel_paid_awaiting_supplier" -> "caravel_supplier_dispatch_claimed".
 *
 * A boolean paymentConfirmed supplied by a caller is NEVER sufficient.
 * A Stripe webhook must validate the signature and booking amount/session,
 * persist payment confirmation at the booking row, then a single dispatcher
 * may claim it atomically. No claim = NO remote booking.
 *
 * A claimed row cannot be automatically replayed after a network timeout:
 * reconcile the supplier external_ref (Ride24 booking UUID) first.
 */
const REC=(v:unknown):Record<string,unknown>|null =>
  v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTNER_ID="78721481-7619-44df-a9b7-5faa344b69bb";
const STAMP=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
function ts(v:unknown):number|null{
 if(typeof v!=="string"||!STAMP.test(v))return null;
 const n=Date.parse(v);return Number.isFinite(n)?n:null;
}
export type CaravelPaidDispatchProof=
 |{ok:true;bookingId:string;idempotencyKey:string;supplierId:string;quoteId:string}
 |{ok:false;action:"hold_for_manual_review";reason:string};
export function verifyCaravelClaimedPaidBooking(args:{
  persistedBooking:unknown;
  ride24BookingId:unknown;
  providerQuote:unknown;
  nowEpochMs:number;
}):CaravelPaidDispatchProof {
 const b=REC(args?.persistedBooking),q=REC(args?.providerQuote);
 const reject=(reason:string):CaravelPaidDispatchProof=>
  ({ok:false,action:"hold_for_manual_review",reason});
 if(!b||!q||typeof args.ride24BookingId!=="string"||
    !UUID.test(args.ride24BookingId)||b.id!==args.ride24BookingId)
   return reject("CARAVEL_CLAIM_BOOKING_ID_MISMATCH");
 if(b.partner_id!==PARTNER_ID||b.provider_type!=="api"||
    b.api_provider!=="caravel"||b.status!=="pending"||
    b.api_status!=="caravel_supplier_dispatch_claimed"||
    b.api_booking_reference!=null||b.cancelled_at!=null||
    b.manual_review!==false)
   return reject("CARAVEL_ATOMIC_DISPATCH_CLAIM_REQUIRED");
 if(typeof b.stripe_session_id!=="string"||!b.stripe_session_id.startsWith("cs_")||
    b.stripe_currency!=="pln"||
    typeof b.stripe_amount_cents!=="number"||
    !Number.isSafeInteger(b.stripe_amount_cents)||
    b.stripe_amount_cents<=0)
   return reject("CARAVEL_PERSISTED_STRIPE_EVIDENCE_MISSING");
 const paidAt=ts(b.caravel_stripe_payment_confirmed_at);
 const claimedAt=ts(b.caravel_supplier_dispatch_claimed_at);
 if(paidAt===null||claimedAt===null||
    !Number.isSafeInteger(args.nowEpochMs)||
    paidAt>claimedAt||claimedAt>args.nowEpochMs+5000||
    args.nowEpochMs-claimedAt>120000)
   return reject("CARAVEL_DISPATCH_CLAIM_STALE_OR_UNVERIFIED");
 if(q.provider!=="caravel"||
    typeof q.quote_id!=="string"||!UUID.test(q.quote_id)||
    typeof q.supplier_id!=="string"||
    !/^[A-Za-z0-9_-]{1,128}$/.test(q.supplier_id)||
    b.caravel_supplier_quote_id!==q.quote_id||
    b.caravel_supplier_id!==q.supplier_id)
   return reject("CARAVEL_CLAIM_SUPPLIER_QUOTE_MISMATCH");
 if(b.caravel_terms_document_id!==q.terms_document_id||
    b.caravel_terms_content_hash!==q.terms_content_hash||
    b.caravel_terms_language!==q.terms_language)
   return reject("CARAVEL_CLAIM_TERMS_CHANGED");
 return {ok:true,bookingId:args.ride24BookingId,
   idempotencyKey:args.ride24BookingId,
   supplierId:q.supplier_id as string,quoteId:q.quote_id};
}
