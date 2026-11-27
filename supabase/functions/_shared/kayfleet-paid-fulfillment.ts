// Fast Rent / KayFleet in Ride24's existing Stripe-first paid provider workflow.
// No special Stripe implementation or customer-visible booking lifecycle.
import { partnerApiRequest, sanitizePartnerPayload } from "./partner-api.ts";
import { cyprusIso, kayfleetQuoteWithExtras } from "./kayfleet-adapter.ts";
import { kayfleetCounts, kayfleetSnapshot } from "./kayfleet-pricing.mjs";
import { kayfleetBookingRequest, verifyKayfleetBookingSnapshot } from "./kayfleet-contract.mjs";
import { serviceCents } from "./provider-services.mjs";
import { DefiniteApiFailure } from "./api-payment-flow.mjs";

const fail=(code:string):never=>{throw new DefiniteApiFailure("KAYFLEET_"+code);};
const str=(v:unknown):string=>typeof v==="string"?v.trim():"";
const money=(v:unknown):number=>{
  const n=Number(v);
  if((typeof v!=="number"&&typeof v!=="string")||!Number.isFinite(n)||n<0)fail("AMOUNT_INVALID");
  return Math.round(n*100);
};
const stable=(v:unknown):string=>JSON.stringify(v==null?null:
  Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):
  typeof v==="object"?Object.fromEntries(Object.keys(v as object).sort().map(k=>[k,JSON.parse(stable((v as any)[k]))])):v);
function assertLiveCredential(credentials:any) {
  if(!credentials?.api_key||!str(credentials.api_key).startsWith("kf_live_"))
    fail("LIVE_CREDENTIAL_REQUIRED");
}
export function kayfleetPaymentApproved():boolean {
  return typeof Deno!=="undefined"
    &&Deno.env.get("KAYFLEET_STRIPE_FIRST_APPROVED")==="true"
    &&Deno.env.get("KAYFLEET_LIVE_WRITE_ALLOWED")==="true";
}
const validTime=(v:unknown)=>/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(str(v));
export async function revalidatePaidKayfleet(credentials:any,booking:any,quote:any) {
  if(!kayfleetPaymentApproved())fail("PAID_FLOW_NOT_APPROVED");
  assertLiveCredential(credentials);
  if(booking.cancelled_at||!["pending","awaiting_payment"].includes(booking.status))
    fail("BOOKING_NOT_PAYABLE");
  if(!quote||booking.api_quote_id!==quote.id||quote.booking_id!==booking.id
    ||quote.partner_id!==booking.partner_id||quote.car_class_id!==booking.car_class_id
    ||quote.start_date!==booking.start_date||quote.end_date!==booking.end_date
    ||quote.currency!=="EUR"||booking.partner_currency!=="EUR"
    ||Number(quote.partner_discount_percent)!==0)
    fail("ACCEPTED_QUOTE_MISMATCH");
  if(!booking.partner_terms_snapshot||!booking.partner_rules_snapshot
    ||booking.partners.rental_terms_url!==booking.partner_terms_snapshot
    ||booking.partners.rental_rules_url!==booking.partner_rules_snapshot)
    fail("PARTNER_DOCUMENTS_CHANGED");
  const saved=quote.raw_response?.provider_quote_data;
  const accepted=saved?.quote, options=quote.raw_response?.ride24_options;
  if(saved?.kayfleet!==true||!accepted||accepted.requested_full_insurance!==true
    ||accepted.deposit_amount!==0||accepted.insurance_excess!==0
    ||!options?.snapshot||options.snapshot.version!==2||!options?.binding)
    fail("ACCEPTED_QUOTE_REQUIRED");
  const snapshot=options.snapshot;
  if(money(booking.partner_net_price_snapshot)!==snapshot.partner_cents
    ||money(booking.final_price_snapshot)!==snapshot.gross_cents
    ||money(booking.online_payment_pln)!==snapshot.online_pln_cents
    ||money(quote.partner_net_total)!==snapshot.partner_cents
    ||money(quote.final_total)!==snapshot.gross_cents
    ||money(accepted.grand_total)!==snapshot.partner_cents
    ||money(booking.pickup_payment_partner_currency)!==snapshot.partner_cents)
    fail("ACCEPTED_PRICE_MISMATCH");
  const binding=options.binding;
  if(binding.user_id!==booking.client_id||binding.driver_id!==(booking.driver_id||null)
    ||binding.additional_driver_id!==(booking.additional_driver_id||null)
    ||!Array.isArray(binding.selections))
    fail("ACCEPTED_OPTIONS_MISMATCH");
  let extras:any;
  try {extras=kayfleetCounts(binding.selections,binding.additional_driver_id);}catch{fail("EXTRAS_BINDING_INVALID");}
  if((extras.additional_drivers===1)!==Boolean(booking.add_driver_name)
    ||!str(booking.main_driver_name)||!str(booking.client_email)||!str(booking.client_phone))
    fail("DRIVER_DETAILS_MISSING");
  const ages=[Number(booking.main_driver_age),...(extras.additional_drivers?[Number(booking.add_driver_age)]:[])];
  if(ages.some(x=>!Number.isSafeInteger(x)||x<25))
    fail("DRIVER_AGE_NOT_ALLOWED");
  if(stable(binding.ages)!==stable(ages))fail("DRIVER_AGE_CHANGED");
  if(!validTime(booking.pickup_time)||!validTime(booking.return_time))fail("TIME_INVALID");
  const pickup=str(quote.pickup_location_external_id);
  const dropoff=str(quote.dropoff_location_external_id);
  if(!pickup||!dropoff||pickup!==saved.pickup_location||dropoff!==saved.dropoff_location
    ||saved.pickup_datetime!==cyprusIso(booking.start_date,booking.pickup_time)
    ||saved.return_datetime!==cyprusIso(booking.end_date,booking.return_time))
    fail("ROUTE_CHANGED");
  if(accepted.group_id!==quote.external_group_id||accepted.pickup_location!==pickup
    ||accepted.dropoff_location!==dropoff)
    fail("GROUP_OR_ROUTE_CHANGED");
  const params=new URLSearchParams({
    pickup_datetime:saved.pickup_datetime,return_datetime:saved.return_datetime,
  });
  const available:any=await partnerApiRequest(credentials,"/api/partner/availability?"+params.toString(),{method:"GET"});
  const stock=Array.isArray(available?.vehicle_groups)?
    available.vehicle_groups.find((x:any)=>x?.group_id===quote.external_group_id):null;
  if(stock?.available!==true||!Number.isInteger(stock.available_count)||stock.available_count<1)
    fail("PROVIDER_UNAVAILABLE");

  // A fresh quote may get a different reference but must have EXACTLY the
  // customer's accepted price, extras, insurance and delivery conditions.
  const window={pickup_location_id:pickup,dropoff_location_id:dropoff,
    pickup_date:booking.start_date,return_date:booking.end_date,
    pickup_time:booking.pickup_time,return_time:booking.return_time,currency:"EUR"};
  const fresh=await kayfleetQuoteWithExtras(credentials,window,quote.external_group_id,extras);
  const recomputed=kayfleetSnapshot(fresh,{
    marginPercent:Number(quote.platform_margin_percent),
    loyaltyPercent:Number(booking.loyalty_discount_percent)||0,
    exchangeRate:Number(snapshot.exchange_rate),
  });
  if(stable(recomputed)!==stable(snapshot))fail("SUPPLIER_PRICE_OR_TERMS_CHANGED");
  const request=kayfleetBookingRequest({
    quote:{...fresh,full_insurance:true},
    group_id:quote.external_group_id,approved_partner_total:snapshot.partner_cents/100,
    approved_extras:extras,quoted_extras:fresh.extras,
    pickup_datetime:saved.pickup_datetime,return_datetime:saved.return_datetime,
    pickup_location:pickup,dropoff_location:dropoff,
    partner_ref:str(booking.reservation_code)||"R24-"+booking.id,
    idempotency_key:"ride24:"+booking.id,
    customer:{full_name:str(booking.main_driver_name),email:str(booking.client_email),
      phone:str(booking.client_phone)},
  });
  return {
    provider:"kayfleet",ride24_booking_id:booking.id,
    pickup_location_id:pickup,dropoff_location_id:dropoff,
    pickup_date:booking.start_date,return_date:booking.end_date,
    pickup_time:str(booking.pickup_time),return_time:str(booking.return_time),
    vehicle_group_id:quote.external_group_id,currency:"EUR",
    idempotency_key:"ride24:"+booking.id,
    ...request,
    expected:{
      quote_reference:fresh.quote_reference,
      partner_ref:request.body.partner_ref,
      pickup_datetime:request.body.pickup_datetime,
      return_datetime:request.body.return_datetime,
      pickup_location:pickup,dropoff_location:dropoff,
      group_name:fresh.group_name,grand_total:fresh.grand_total,extras,
    },
  };
}
function requirePaidResponse(payload:any,prepared:any) {
  const reference=str(payload?.reference);
  if(!reference||payload?.test_mode===true||str(payload?.booking_number).startsWith("TEST-")
    ||payload?.partner_ref!==prepared.expected.partner_ref)
    return {booking_reference:reference||null,reference:reference||null,status:"pending",
      needs_manual_review:true,provider_payload:sanitizePartnerPayload(payload,12000)};
  if(payload?.status==="denied"||payload?.status==="cancelled")
    return {booking_reference:reference,reference,status:"rejected",
      definitive_rejection:true,provider_payload:sanitizePartnerPayload(payload,12000)};
  try {
    verifyKayfleetBookingSnapshot(payload,prepared.expected,{allowPending:true});
    return {booking_reference:reference,reference,
      status:payload.status==="confirmed"?"confirmed":"pending",
      provider_payload:sanitizePartnerPayload(payload,12000)};
  } catch {
    return {booking_reference:reference,reference,status:"pending",
      needs_manual_review:true,provider_payload:sanitizePartnerPayload(payload,12000)};
  }
}
export async function createPaidKayfleet(credentials:any,prepared:any) {
  if(!kayfleetPaymentApproved())fail("PAID_FLOW_NOT_APPROVED");
  assertLiveCredential(credentials);
  if(prepared?.provider!=="kayfleet"||prepared?.path!=="/api/partner/bookings"
    ||!prepared?.expected||!prepared?.body)fail("REQUEST_UNVERIFIED");
  try {
    const payload=await partnerApiRequest(credentials,prepared.path,{
      method:"POST",headers:prepared.headers,body:prepared.body,
    });
    return requirePaidResponse(payload,prepared);
  } catch(error) {
    // 409 quote_expired/used/mismatch is a definite no-booking condition.
    // Never auto-replay a paid supplier POST. Refund the Ride24 booking fee.
    if(error instanceof Error&&error.message==="PARTNER_API_ERROR:HTTP:409")
      fail("QUOTE_CONFLICT_NO_BOOKING");
    throw error; // timeout/network/5xx -> unknown, read-only recovery
  }
}
export async function readPaidKayfleetStatus(credentials:any,reference:string,prepared:any) {
  if(!kayfleetPaymentApproved()||prepared?.provider!=="kayfleet")fail("PAID_FLOW_NOT_APPROVED");
  assertLiveCredential(credentials);
  if(!reference||reference.length>200)fail("REFERENCE_MISSING");
  const payload:any=await partnerApiRequest(credentials,
    "/api/partner/bookings/"+encodeURIComponent(reference),{method:"GET"});
  if(payload?.reference!==reference)fail("REFERENCE_MISMATCH");
  return requirePaidResponse(payload,prepared);
}
export async function cancelPaidKayfleetAfterTimeout(credentials:any,reference:string,prepared:any) {
  if(!kayfleetPaymentApproved()||prepared?.provider!=="kayfleet")fail("PAID_FLOW_NOT_APPROVED");
  assertLiveCredential(credentials);
  if(!reference||reference.length>200)fail("REFERENCE_MISSING");
  const before=await readPaidKayfleetStatus(credentials,reference,prepared);
  if(before.status==="rejected")return {status:"cancelled",reference,booking_reference:reference};
  if(before.status==="confirmed"||before.needs_manual_review===true) return {...before,needs_manual_review:true};
  const payload:any=await partnerApiRequest(credentials,
    "/api/partner/bookings/"+encodeURIComponent(reference)+"/cancel",
    {method:"POST",body:{reason:"Ride24 supplier confirmation deadline exceeded"}});
  if(payload?.reference!==reference||payload?.status!=="cancelled")return {status:"pending",needs_manual_review:true};
  const confirmed=await readPaidKayfleetStatus(credentials,reference,prepared);
  return confirmed.status==="rejected"
    ?{status:"cancelled",reference,booking_reference:reference}
    :{status:"pending",needs_manual_review:true};
}
