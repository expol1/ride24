/**
 * Isolated Caravel-only one-time, atomic DB dispatch claim.
 *
 * Run ONLY in a secured server process with a service-role Supabase client,
 * AFTER a signature-verified Stripe webhook has committed payment evidence.
 *
 * The compare-and-swap update changes api_status in the WHERE clause:
 * only ONE dispatcher may move a paid booking from
 * caravel_paid_awaiting_supplier -> caravel_supplier_dispatch_claimed.
 * On a second invocation, no row matches, so NO supplier POST occurs.
 *
 * This cannot be deployed before the DRAFT caravel-paid-dispatch-claim.sql
 * and the required Stripe/bookings/orchestration paths have been tested.
 */
import {verifyCaravelClaimedPaidBooking}
  from "./caravel-dispatch-proof.ts";
const PARTNER_ID="78721481-7619-44df-a9b7-5faa344b69bb";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
type Rec=Record<string,unknown>;
type ClaimResponse={
  data:Rec|null;error:{message?:string}|null;
};
type Filter={
  eq:(column:string,value:unknown)=>Filter;
  is:(column:string,value:null)=>Filter;
  not:(column:string,op:"is",value:null)=>Filter;
  select:(columns:string)=>{maybeSingle:()=>Promise<ClaimResponse>};
};
export type CaravelClaimClient={
  from:(table:"bookings")=>{update:(payload:Rec)=>Filter};
};
export type CaravelDispatchClaimResult=
  |{ok:true;persistedBooking:Rec}
  |{ok:false;action:"hold_for_manual_review";reason:string};

/**
 * Caller must load the exact same supplier quote with SERVICE ROLE from
 * api_quotes and confirm authorization, partner activation and amount.
 * This code never contacts Stripe or Caravel and never issues a voucher.
 *
 * On proof failure *after* the UPDATE, the claim remains locked and requires
 * manual review. Never reset it or automatically retry a possible remote POST.
 */
export async function claimCaravelPaidDispatch(args:{
  admin:CaravelClaimClient;
  bookingId:string;
  nowIso:string;
  partnerApiEnabled:boolean;
  providerQuote:unknown;
}):Promise<CaravelDispatchClaimResult>{
  const reject=(reason:string):CaravelDispatchClaimResult=>
    ({ok:false,action:"hold_for_manual_review",reason});
  if(!args || args.partnerApiEnabled!==true||!UUID.test(args.bookingId)||
    typeof args.nowIso!=="string"||!ISO.test(args.nowIso)||
    !Number.isFinite(Date.parse(args.nowIso))||
    !args.admin||typeof args.admin.from!=="function")
    return reject("CARAVEL_CLAIM_INPUT_NOT_AUTHORIZED");
  let result:ClaimResponse;
  try {
    result=await args.admin.from("bookings").update({
      api_status:"caravel_supplier_dispatch_claimed",
      caravel_supplier_dispatch_claimed_at:args.nowIso,
    })
      .eq("id",args.bookingId)
      .eq("partner_id",PARTNER_ID)
      .eq("provider_type","api")
      .eq("status","pending")
      .eq("api_status","caravel_paid_awaiting_supplier")
      .eq("manual_review",false)
      .is("cancelled_at",null)
      .is("api_booking_reference",null)
      .not("caravel_stripe_payment_confirmed_at","is",null)
      .select("id,partner_id,provider_type,status,api_status,api_booking_reference,cancelled_at,manual_review,stripe_session_id,stripe_currency,stripe_amount_cents,caravel_stripe_payment_confirmed_at,caravel_supplier_dispatch_claimed_at,caravel_supplier_quote_id,caravel_supplier_id,caravel_terms_document_id,caravel_terms_content_hash,caravel_terms_language,partners!bookings_partner_id_fkey(api_provider,api_enabled)")
      .maybeSingle();
  }catch{
    return reject("CARAVEL_CLAIM_DB_REQUEST_FAILED");
  }
  if(result.error)return reject("CARAVEL_CLAIM_DB_REQUEST_FAILED");
  if(!result.data)return reject("CARAVEL_CLAIM_ALREADY_TAKEN_OR_INELIGIBLE");
  const b=result.data;
  const p=Array.isArray(b.partners)?b.partners[0]:b.partners;
  if(!p||typeof p!=="object"||Array.isArray(p)||
    (p as Rec).api_provider!=="caravel"||
    (p as Rec).api_enabled!==true)
    return reject("CARAVEL_PARTNER_SCOPE_CHANGED_DURING_CLAIM");
  const persisted={...b,api_provider:(p as Rec).api_provider};
  const check=verifyCaravelClaimedPaidBooking({
    persistedBooking:persisted,ride24BookingId:args.bookingId,
    providerQuote:args.providerQuote,nowEpochMs:Date.parse(args.nowIso),
  });
  if("reason" in check)return reject(check.reason);
  return {ok:true,persistedBooking:persisted};
}
