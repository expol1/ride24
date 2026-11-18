/**
 * Caravel-only signed Stripe payment to durable supplier-dispatch queue.
 *
 * ISOLATED. Not connected to the production Stripe webhook and NOT DEPLOYED.
 * Before using: (1) apply reviewed Caravel migrations; (2) implement the
 * certified Caravel-only checkout, showing/recording immutable terms and
 * Premium exclusion consent; (3) supply a Stripe SDK signature verifier
 * configured with the production STRIPE_WEBHOOK_SECRET; (4) service-role DB
 * client, quote and partner verified from trusted server records.
 *
 * A signed checkout.session.completed event MUST also be payment_status=paid,
 * with booking id, client id, session id, currency and exact fee matching.
 * The compare-and-swap state change queues a supplier dispatch but NEVER
 * calls Caravel, marks paid, issues a voucher or sends a confirmation.
 */
import {verifyCaravelPaidCheckoutForSupplierQueue}
  from "./caravel-payment-sequence.ts";
const CARAVEL_ID="78721481-7619-44df-a9b7-5faa344b69bb";
const uuid=(x:unknown):x is string=>
 typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
type Rec=Record<string,unknown>;
const rec=(x:unknown):Rec|null=>
 x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Rec:null;
type Result={data:Rec|null;error:{message?:string}|null};
type Query={
  select:(columns:string)=>Query;
  update:(payload:Rec)=>Query;
  eq:(column:string,value:unknown)=>Query;
  is:(column:string,value:null)=>Query;
  maybeSingle:()=>Promise<Result>;
};
export type CaravelPaymentAdmin={
  from:(name:"bookings")=>Query;
};
export type CaravelPaymentCommitResult=
 |{ok:true;action:"queued"|"already_queued";bookingId:string;
    supplierDispatchRequired:boolean;generateVoucher:false;notifyConfirmed:false}
 |{ok:false;action:"hold_for_manual_review"|"reject_invalid_signature";
    reason:string;generateVoucher:false};
const fail=(reason:string,invalidSignature=false):CaravelPaymentCommitResult=>({
  ok:false,action:invalidSignature?"reject_invalid_signature":"hold_for_manual_review",
  reason,generateVoucher:false,
});
export async function recordVerifiedCaravelStripePayment(args:{
  admin:CaravelPaymentAdmin;
  rawBody:string;
  stripeSignature:string;
  /** Must be the real Stripe SDK constructEventAsync bound to Stripe's
   * secret in the authenticated webhook, NEVER a browser callback. */
  constructVerifiedEvent:(body:string,signature:string)=>Promise<unknown>;
  /** Trusted service-role quote data for exactly this bookings.api_quote_id. */
  providerQuote:unknown;
  nowIso:string;
}):Promise<CaravelPaymentCommitResult>{
  if(!args||!args.admin||typeof args.admin.from!=="function"||
     typeof args.rawBody!=="string"||!args.rawBody||
     typeof args.stripeSignature!=="string"||!args.stripeSignature||
     typeof args.constructVerifiedEvent!=="function"||
     typeof args.nowIso!=="string"||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(args.nowIso)||
     !Number.isFinite(Date.parse(args.nowIso)))
    return fail("CARAVEL_PAYMENT_WEBHOOK_INPUT_INVALID",true);

  let rawEvent:unknown;
  try {
    rawEvent=await args.constructVerifiedEvent(args.rawBody,args.stripeSignature);
  }catch{
    return fail("CARAVEL_PAYMENT_STRIPE_SIGNATURE_INVALID",true);
  }
  const event=rec(rawEvent);
  const data=rec(event?.data);
  const session=rec(data?.object);
  const metadata=rec(session?.metadata);
  if(event?.type!=="checkout.session.completed"||!session||
     !uuid(metadata?.booking_id))
    return fail("CARAVEL_PAYMENT_EVENT_NOT_CONFIRMED_CHECKOUT");
  const bookingId=metadata.booking_id as string;
  let lookup:Result;
  try{
    lookup=await args.admin.from("bookings").select(
      "id,client_id,partner_id,provider_type,status,api_status,api_booking_reference,cancelled_at,manual_review,online_payment_pln,stripe_session_id,stripe_currency,stripe_amount_cents,api_quote_id,caravel_supplier_quote_id,caravel_supplier_id,caravel_terms_document_id,caravel_terms_content_hash,caravel_terms_language,partners!bookings_partner_id_fkey(api_provider,api_enabled)"
    ).eq("id",bookingId).maybeSingle();
  }catch{return fail("CARAVEL_PAYMENT_DB_READ_FAILED");}
  if(lookup.error||!lookup.data)return fail("CARAVEL_PAYMENT_BOOKING_NOT_FOUND");
  const b=lookup.data,relation=Array.isArray(b.partners)?b.partners[0]:b.partners;
  const partner=rec(relation),q=rec(args.providerQuote);
  if(b.partner_id!==CARAVEL_ID||b.provider_type!=="api"||
     partner?.api_provider!=="caravel"||partner?.api_enabled!==true)
    return fail("CARAVEL_PAYMENT_PARTNER_NOT_CERTIFIED");
  // Supplier quote and immutable accepted document MUST have been persisted
  // atomically before Stripe. A new/bogus browser quote cannot replace them.
  if(!q||q.provider!=="caravel"||!uuid(q.quote_id)||
     q.quote_id!==b.caravel_supplier_quote_id||
     q.supplier_id!==b.caravel_supplier_id||
     !uuid(b.api_quote_id)||
     b.caravel_terms_document_id!==q.terms_document_id||
     b.caravel_terms_content_hash!==q.terms_content_hash||
     b.caravel_terms_language!==q.terms_language)
    return fail("CARAVEL_PAYMENT_QUOTE_OR_TERMS_UNVERIFIED");
  if(!uuid(b.client_id)||metadata?.client_id!==b.client_id)
    return fail("CARAVEL_PAYMENT_CLIENT_ID_MISMATCH");

  const decision=verifyCaravelPaidCheckoutForSupplierQueue(
    {...b,api_provider:partner.api_provider},session,args.nowIso);
  if("action" in decision){
    if(decision.action==="already_waiting_for_supplier")
      return {ok:true,action:"already_queued",bookingId,
       supplierDispatchRequired:false,generateVoucher:false,notifyConfirmed:false};
    return fail(decision.reason);
  }
  let updated:Result;
  try{
    updated=await args.admin.from("bookings").update({
      status:decision.transition.status,
      api_status:decision.transition.api_status,
      manual_review:decision.transition.manual_review,
      caravel_stripe_payment_confirmed_at:
        decision.transition.caravel_stripe_payment_confirmed_at,
      stripe_currency:decision.transition.stripe_currency,
      stripe_amount_cents:decision.transition.stripe_amount_cents,
    })
      .eq("id",bookingId)
      .eq("partner_id",CARAVEL_ID)
      .eq("status",decision.transition.fromStatus)
      .eq("stripe_session_id",session.id)
      .is("cancelled_at",null)
      .is("api_booking_reference",null)
      .select("id").maybeSingle();
  }catch{return fail("CARAVEL_PAYMENT_DB_WRITE_UNCERTAIN");}
  if(updated.error)return fail("CARAVEL_PAYMENT_DB_WRITE_FAILED");
  if(!updated.data)return fail("CARAVEL_PAYMENT_CONCURRENT_STATE_CHANGE");
  return {ok:true,action:"queued",bookingId,
    supplierDispatchRequired:true,generateVoucher:false,notifyConfirmed:false};
}
