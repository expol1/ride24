/**
 * Caravel ONLY: paid-before-supplier reservation sequence.
 * PURE, ISOLATED, NOT DEPLOYED OR CONNECTED TO THE STRIPE WEBHOOK.
 *
 * Standard Ride24 API partners book at supplier BEFORE creating the Stripe
 * reservation-fee checkout. Caravel explicitly requires the opposite order.
 * NEVER reuse standard api-booking-dispatch or standard webhook voucher/email
 * path for Caravel until a separate post-payment dispatcher is connected.
 *
 * All booking fields MUST be service-role reads; the Stripe session MUST be
 * provided only after validating Stripe's webhook signature with Stripe SDK.
 */
type Rec=Record<string,unknown>;
const rec=(v:unknown):Rec|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Rec:null;
const uuid=(v:unknown):v is string=>
  typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const nonempty=(v:unknown):v is string=>typeof v==="string"&&v.length>0;
const isValidServerTimestamp=(v:unknown):v is string=>
  typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&
  Number.isFinite(Date.parse(v));
export const CARAVEL_PAID_AWAITING_SUPPLIER="caravel_paid_awaiting_supplier" as const;

type StripeCheckpoint={
  ready:true;
  transition:{
    fromStatus:"awaiting_payment";
    status:"pending";
    api_status:typeof CARAVEL_PAID_AWAITING_SUPPLIER;
    manual_review:false;
    caravel_stripe_payment_confirmed_at:string;
    stripe_currency:"pln";
    stripe_amount_cents:number;
  };
  /** Keep voucher/email generation OFF until provider confirmation persisted. */
  generateVoucher:false;
  notifyCustomerConfirmed:false;
}|{
  ready:false; action:"hold_for_manual_review"|"already_waiting_for_supplier"|"already_completed";
  reason:string;generateVoucher:false;
};
function expectedPlnMinor(b:Rec):number|null{
  const cents=b.stripe_amount_cents;
  if(typeof cents==="number" && Number.isSafeInteger(cents) && cents>0)
    return cents;
  const major=b.online_payment_pln;
  if(typeof major!=="number"||!Number.isFinite(major)||major<=0)
    return null;
  const rounded=Math.round(major*100);
  return Number.isSafeInteger(rounded)&&Math.abs(major*100-rounded)<0.00001
    ?rounded:null;
}
export function verifyCaravelPaidCheckoutForSupplierQueue(
  bookingInput:unknown,verifiedStripeSessionInput:unknown,
  serverVerifiedAtIso:unknown,
):StripeCheckpoint{
  const b=rec(bookingInput),s=rec(verifiedStripeSessionInput);
  const meta=rec(s?.metadata);
  const amount=b?expectedPlnMinor(b):null;
  if(!b||!s||!uuid(b.id)||
    b.provider_type!=="api"||b.api_provider!=="caravel"||
    !uuid(b.client_id)||meta?.client_id!==b.client_id||
    !nonempty(b.stripe_session_id)||b.stripe_session_id!==s.id||
    s.client_reference_id!==b.id||meta?.booking_id!==b.id||
    s.payment_status!=="paid"||s.status!=="complete"||
    s.currency!=="pln"||amount===null||s.amount_total!==amount||
    (b.stripe_currency!=null&&b.stripe_currency!=="pln"))
    return {ready:false,action:"hold_for_manual_review",
      reason:"CARAVEL_STRIPE_PAYMENT_EVIDENCE_MISMATCH",generateVoucher:false};
  if(b.manual_review===true)
    return {ready:false,action:"hold_for_manual_review",
      reason:"CARAVEL_BOOKING_ALREADY_HELD_FOR_MANUAL_REVIEW",generateVoucher:false};
  if(b.cancelled_at!=null||["cancelled","rejected","expired","payment_expired"].includes(String(b.status)))
    return {ready:false,action:"hold_for_manual_review",
      reason:"CARAVEL_BOOKING_NOT_ELIGIBLE_AFTER_PAYMENT",generateVoucher:false};
  if(b.status==="pending"&&b.api_status===CARAVEL_PAID_AWAITING_SUPPLIER&&
     b.api_booking_reference==null)
    return {ready:false,action:"already_waiting_for_supplier",
      reason:"CARAVEL_PAYMENT_ALREADY_RECORDED",generateVoucher:false};
  if(b.status==="paid"&&b.api_status==="confirmed"&&nonempty(b.api_booking_reference))
    return {ready:false,action:"already_completed",
      reason:"CARAVEL_SUPPLIER_ALREADY_CONFIRMED",generateVoucher:false};
  // The atomic Caravel-only quote+booking RPC writes this exact initial
  // marker. No other awaiting_payment API path may be queued by Stripe.
  if(b.status!=="awaiting_payment"||
     b.api_status!=="caravel_awaiting_stripe"||
     b.api_booking_reference!=null)
    return {ready:false,action:"hold_for_manual_review",
      reason:"CARAVEL_PREPAYMENT_BOOKING_STATE_INVALID",generateVoucher:false};
  if(!isValidServerTimestamp(serverVerifiedAtIso) ||
     Date.parse(serverVerifiedAtIso)>Date.now()+300000)
    return {ready:false,action:"hold_for_manual_review",
      reason:"CARAVEL_STRIPE_SERVER_TIMESTAMP_REQUIRED",generateVoucher:false};
  return {ready:true,
    transition:{
      fromStatus:"awaiting_payment",status:"pending",
      api_status:CARAVEL_PAID_AWAITING_SUPPLIER,manual_review:false,
      caravel_stripe_payment_confirmed_at:serverVerifiedAtIso,
      stripe_currency:"pln",stripe_amount_cents:amount,
    },generateVoucher:false,notifyCustomerConfirmed:false};
}
export function verifyCaravelProviderDispatchMayStart(bookingInput:unknown):
  {ok:true}|{ok:false;reason:string}{
  const b=rec(bookingInput);
  if(!b||b.provider_type!=="api"||b.api_provider!=="caravel"||
     b.status!=="pending"||b.api_status!==CARAVEL_PAID_AWAITING_SUPPLIER||
     b.cancelled_at!=null||b.api_booking_reference!=null||
     b.manual_review===true||!uuid(b.id)||!nonempty(b.stripe_session_id)||
     !isValidServerTimestamp(b.caravel_stripe_payment_confirmed_at))
    return {ok:false,reason:"CARAVEL_PAID_DISPATCH_NOT_AUTHORIZED"};
  return {ok:true};
}
/**
 * Only the stored post-payment CONFIRMED provider reference may authorize
 * the existing Ride24 voucher and confirmation notification paths. Caller
 * must persist provider confirmation before testing this predicate.
 */
export function canReleaseCaravelVoucher(bookingInput:unknown):boolean{
  const b=rec(bookingInput);
  return !!b&&b.provider_type==="api"&&b.api_provider==="caravel"&&
    b.status==="paid"&&b.api_status==="confirmed"&&
    nonempty(b.api_booking_reference)&&b.cancelled_at==null&&
    b.manual_review!==true&&
    isValidServerTimestamp(b.caravel_stripe_payment_confirmed_at);
}
