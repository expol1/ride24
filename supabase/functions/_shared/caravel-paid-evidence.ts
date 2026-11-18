/**
 * Caravel ONLY — resolve a Stripe-paid booking and the supplier quote from
 * trusted service-role Ride24 DB rows; never from a client JSON payload.
 *
 * NOT WIRED or DEPLOYED. The Caravel quote must be saved under
 * api_quotes.raw_response.provider_quote_data by the future audited server-side
 * Caravel search/quote path BEFORE client checkout. This deliberately
 * rejects today's API quote rows without that provenance.
 *
 * This component makes NO supplier requests, DB writes, refunds or vouchers.
 * Returns only server-hydrated data for the isolated paid orchestrator;
 * further current terms, protection, licence and certification checks are
 * mandatory before a remote POST.
 */
import {verifyCaravelRide24PaymentContract}
  from "./caravel-payment-contract.ts";
import type {Ride24BookingInput} from "./caravel-booking.ts";
import type {CaravelBookingTermsSnapshot}
  from "./caravel-terms-lifecycle.ts";

type Rec=Record<string,unknown>;
type DbResult={data:Rec|null;error:{message?:string}|null};
type Query={eq:(column:string,value:unknown)=>Query;
  maybeSingle:()=>Promise<DbResult>};
export type CaravelEvidenceAdmin={
 from:(name:"bookings"|"api_quotes")=>{select:(columns:string)=>Query};
};
export type CaravelHydratedEvidence={
 bookingInput:Ride24BookingInput;
 bookingTerms:CaravelBookingTermsSnapshot;
 coverageConsent:Rec|null;
 paidBooking:Rec;
 storedQuoteId:string;
};
export type CaravelEvidenceResult=
 |{ok:true;evidence:CaravelHydratedEvidence}
 |{ok:false;reason:string};
const PARTNER_ID="78721481-7619-44df-a9b7-5faa344b69bb";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const SUPPLIER=/^[A-Za-z0-9_-]{1,128}$/;
const record=(x:unknown):Rec|null=>
 x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Rec:null;
const uuid=(x:unknown):x is string=>
 typeof x==="string"&&UUID.test(x);
const validDate=(x:unknown):number|null=>{
 if(typeof x!=="string")return null;
 const t=Date.parse(x);return Number.isFinite(t)?t:null;
};
function cents(x:unknown):number|null{
 if(typeof x!=="number"&&typeof x!=="string")return null;
 const n=Number(x);
 if(!Number.isFinite(n)||n<=0)return null;
 const k=Math.round(n*100);
 return Number.isSafeInteger(k)&&Math.abs(k/100-n)<1e-7?k:null;
}
const fail=(reason:string):CaravelEvidenceResult=>({ok:false,reason});

/**
 * Only a service-role backend may call this; clients must never see its
 * raw DB query or the PII contained in returned bookingInput.
 */
export async function loadCaravelPaidEvidence(args:{
 admin:CaravelEvidenceAdmin;bookingId:string;nowEpochMs:number;
}):Promise<CaravelEvidenceResult>{
 if(!args||!args.admin||typeof args.admin.from!=="function"||
    !uuid(args.bookingId)||!Number.isSafeInteger(args.nowEpochMs))
   return fail("CARAVEL_EVIDENCE_INVALID_REQUEST");
 let bookingResult:DbResult;
 try{
  bookingResult=await args.admin.from("bookings").select(
   "id,partner_id,client_id,car_class_id,api_quote_id,provider_type,status,api_status,manual_review,cancelled_at,api_booking_reference,stripe_session_id,stripe_currency,stripe_amount_cents,caravel_stripe_payment_confirmed_at,caravel_supplier_quote_id,caravel_supplier_id,caravel_terms_document_id,caravel_terms_language,caravel_terms_content_hash,caravel_coverage_supplier_id,caravel_coverage_quote_id,caravel_coverage_terms_document_id,caravel_coverage_terms_content_hash,caravel_coverage_excluded_codes,caravel_coverage_damage_admin_fee_minor,caravel_coverage_accepted_at,terms_accepted,terms_accepted_at,main_driver_name,main_driver_age,add_driver_name,add_driver_age,client_email,client_phone,partner_net_price_snapshot,partner_currency,partner_discount_snapshot,reservation_code,partners!bookings_partner_id_fkey(api_provider,api_enabled,active,account_status)"
  ).eq("id",args.bookingId).maybeSingle();
 }catch{return fail("CARAVEL_EVIDENCE_BOOKING_READ_FAILED");}
 const b=bookingResult.data;
 const joined=record(b?.partners);
 if(bookingResult.error||!b||b.id!==args.bookingId||
    b.partner_id!==PARTNER_ID||b.provider_type!=="api"||
    b.status!=="pending"||b.api_status!=="caravel_paid_awaiting_supplier"||
    b.manual_review!==false||b.cancelled_at!=null||
    b.api_booking_reference!=null||
    !uuid(b.client_id)||!uuid(b.api_quote_id)||!uuid(b.car_class_id)||
    joined?.api_provider!=="caravel"||joined?.api_enabled!==true||
    joined?.active!==true||joined?.account_status!=="active")
   return fail("CARAVEL_EVIDENCE_BOOKING_NOT_ELIGIBLE");
 if(typeof b.stripe_session_id!=="string"||
    !b.stripe_session_id.startsWith("cs_")||
    b.stripe_currency!=="pln"||
    !Number.isSafeInteger(b.stripe_amount_cents)||
    (b.stripe_amount_cents as number)<=0||
    validDate(b.caravel_stripe_payment_confirmed_at)===null||
    validDate(b.caravel_stripe_payment_confirmed_at)!>args.nowEpochMs+5000)
   return fail("CARAVEL_EVIDENCE_PAYMENT_NOT_VERIFIED");
 if(b.terms_accepted!==true||validDate(b.terms_accepted_at)===null||
    !uuid(b.caravel_supplier_quote_id)||
    typeof b.caravel_supplier_id!=="string"||
    !SUPPLIER.test(b.caravel_supplier_id)||
    typeof b.caravel_terms_document_id!=="string"||
    !b.caravel_terms_document_id||typeof b.caravel_terms_language!=="string"||
    typeof b.caravel_terms_content_hash!=="string"||
    !HASH.test(b.caravel_terms_content_hash))
   return fail("CARAVEL_EVIDENCE_ACCEPTED_TERMS_MISSING");
 let quoteResult:DbResult;
 try{
  quoteResult=await args.admin.from("api_quotes").select(
    "id,booking_id,partner_id,car_class_id,external_group_id,external_quote_reference,partner_net_total,partner_discount_percent,currency,expires_at,used_at,raw_response"
  ).eq("id",b.api_quote_id)
   .eq("booking_id",args.bookingId)
   .eq("partner_id",PARTNER_ID)
   .maybeSingle();
 }catch{return fail("CARAVEL_EVIDENCE_QUOTE_READ_FAILED");}
 const q=quoteResult.data,raw=record(q?.raw_response);
 const supplierQuote=record(raw?.provider_quote_data);
 if(quoteResult.error||!q||!supplierQuote||
    q.id!==b.api_quote_id||q.booking_id!==args.bookingId||
    q.partner_id!==PARTNER_ID||q.car_class_id!==b.car_class_id||
    validDate(q.used_at)===null||
    !uuid(supplierQuote.quote_id)||
    supplierQuote.quote_id!==b.caravel_supplier_quote_id||
    q.external_quote_reference!==supplierQuote.quote_id||
    supplierQuote.supplier_id!==b.caravel_supplier_id||
    q.external_group_id!==supplierQuote.vehicle_id||
    supplierQuote.provider!=="caravel")
   return fail("CARAVEL_EVIDENCE_QUOTE_PROVENANCE_INVALID");
 const expiry=validDate(q.expires_at),supplierExpiry=validDate(supplierQuote.expires_at);
 if(expiry===null||supplierExpiry===null||
    expiry!==supplierExpiry||expiry<=args.nowEpochMs)
   return fail("CARAVEL_EVIDENCE_QUOTE_EXPIRED_AFTER_STRIPE");
 const pay=verifyCaravelRide24PaymentContract(supplierQuote);
 const bCents=cents(b.partner_net_price_snapshot),qCents=cents(q.partner_net_total);
 if("errors" in pay||bCents===null||qCents===null||
    pay.totalMinor!==bCents||bCents!==qCents||
    pay.currency!==q.currency||pay.currency!==b.partner_currency||
    b.partner_discount_snapshot!==q.partner_discount_percent||
    supplierQuote.terms_document_id!==b.caravel_terms_document_id||
    supplierQuote.terms_language!==b.caravel_terms_language||
    supplierQuote.terms_content_hash!==b.caravel_terms_content_hash)
   return fail("CARAVEL_EVIDENCE_PRICE_OR_TERMS_CHANGED");
 // The limited-cover consent is accepted ONLY when every field matches the
 // same trusted booking. The complete exclusion review still runs later.
 const coverageFields=[
  "caravel_coverage_supplier_id","caravel_coverage_quote_id",
  "caravel_coverage_terms_document_id","caravel_coverage_terms_content_hash",
  "caravel_coverage_excluded_codes",
  "caravel_coverage_damage_admin_fee_minor","caravel_coverage_accepted_at",
 ] as const;
 const count=coverageFields.filter(k=>b[k]!=null).length;
 if(count!==0&&count!==coverageFields.length)
   return fail("CARAVEL_EVIDENCE_COVERAGE_CONSENT_INCOMPLETE");
 if(count&&(
    b.caravel_coverage_supplier_id!==b.caravel_supplier_id||
    b.caravel_coverage_quote_id!==b.caravel_supplier_quote_id||
    b.caravel_coverage_terms_document_id!==b.caravel_terms_document_id||
    b.caravel_coverage_terms_content_hash!==b.caravel_terms_content_hash||
    !Array.isArray(b.caravel_coverage_excluded_codes)||
    validDate(b.caravel_coverage_accepted_at)===null))
   return fail("CARAVEL_EVIDENCE_COVERAGE_CONSENT_MISMATCH");
 const partnerAmount=bCents/100;
 const bookingInput:Ride24BookingInput={
   idempotency_key:`ride24:${args.bookingId}`,
   ride24_booking_id:args.bookingId,
   reservation_code:typeof b.reservation_code==="string"?b.reservation_code:null,
   vehicle_group_id:q.external_group_id as string,
   main_driver:{name:typeof b.main_driver_name==="string"?b.main_driver_name:null,
     age:typeof b.main_driver_age==="number"?b.main_driver_age:null},
   additional_driver:b.add_driver_name||b.add_driver_age?{
     name:typeof b.add_driver_name==="string"?b.add_driver_name:null,
     age:typeof b.add_driver_age==="number"?b.add_driver_age:null,
   }:null,
   client_email:typeof b.client_email==="string"?b.client_email:null,
   client_phone:typeof b.client_phone==="string"?b.client_phone:null,
   partner_amount:partnerAmount,currency:pay.currency,
   partner_discount_percent:typeof b.partner_discount_snapshot==="number"
     ?b.partner_discount_snapshot:0,
   quote_reference:supplierQuote.quote_id as string,
   provider_quote_data:supplierQuote,
 };
 return {ok:true,evidence:{
   bookingInput,
   bookingTerms:{
     caravel_terms_document_id:b.caravel_terms_document_id as string,
     caravel_terms_language:b.caravel_terms_language as string,
     caravel_terms_content_hash:b.caravel_terms_content_hash as string,
   },
   coverageConsent:count?Object.fromEntries(
      coverageFields.map(k=>[k,b[k]])):null,
   paidBooking:{...b,api_provider:joined.api_provider},
   storedQuoteId:q.id as string,
 }};
}
