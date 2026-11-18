/**
 * Caravel-only pre-Stripe booking INSERT payload, constructed solely from the
 * persisted Ride24 api_quotes row and certified server-preflight decision.
 * ISOLATED; not an HTTP endpoint and not yet wired into live booking creation.
 * It never claims quotes, inserts bookings, contacts suppliers or starts Stripe.
 *
 * The eventual server must use a single DB transaction to claim the quote
 * and insert this payload, then create Stripe session only if that succeeds.
 */
import {prepareCaravelPrepayment}
 from "./caravel-prepayment-gate.ts";
import {assertApiQuoteContext}
 from "./api-quote-contract.mjs";
type Rec=Record<string,unknown>;
const obj=(x:unknown):Rec|null=>x!==null&&typeof x==="object"&&
 !Array.isArray(x)?x as Rec:null;
const uid=(x:unknown):x is string=>typeof x==="string"&&
 /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const money=(x:unknown):number|null=>{
 const v=typeof x==="number"?x:typeof x==="string"?Number(x):NaN;
 const n=Math.round(v*100);return Number.isSafeInteger(n)&&n>=0&&
 Math.abs(v*100-n)<0.00001?n:null;
};
const time=(x:unknown):number|null=>typeof x==="string"&&Number.isFinite(Date.parse(x))?
 Date.parse(x):null;
const err=(reason:string)=>({ok:false as const,reason});
const PID="78721481-7619-44df-a9b7-5faa344b69bb";
export type CaravelInsertBuilderArgs={
 preflight:Parameters<typeof prepareCaravelPrepayment>[0];
 /** Only a service-role backend may supply this fetched api_quotes row. */
 storedQuote:unknown;
 /** Authenticated Supabase user id, not a browser parameter. */
 authenticatedClientId:string;
 selectedClassId:string;
 pickupLocationId:string;dropoffLocationId:string;
 /** Both location rows must be separately read from the Ride24 DB. */
 storedPickupLocation:unknown;storedDropoffLocation:unknown;
 startDate:string;endDate:string;
 pickupTime:string;returnTime:string;
 pickupName:string;returnName:string;
 /** Trusted server-owned FX snapshot, never browser-supplied. */
 exchangeRatePln:number;
 reservationFeePln:number;
 mainDriverName:string;mainDriverAge:number;
 clientEmail:string;clientPhone:string;
};
export function buildCertifiedCaravelBookingInsert(a:CaravelInsertBuilderArgs):
 {ok:true;payload:Rec;quoteId:string}|{ok:false;reason:string}{
 const row=obj(a?.storedQuote),raw=obj(row?.raw_response);
 const provider=obj(raw?.provider_quote_data);
 if(!row||!provider||row.partner_id!==PID||
    !uid(row.id)||!uid(row.car_class_id)||
    !uid(a.authenticatedClientId)||a.selectedClassId!==row.car_class_id||
    !uid(a.pickupLocationId)||!uid(a.dropoffLocationId)||
    !/^\d{4}-\d\d-\d\d$/.test(a.startDate)||
    !/^\d{4}-\d\d-\d\d$/.test(a.endDate)||
    row.start_date!==a.startDate||row.end_date!==a.endDate||
    row.used_at!=null||row.booking_id!=null)
  return err("CARAVEL_BOOKING_QUOTE_SCOPE_INVALID");
 const pl=obj(a.storedPickupLocation),dl=obj(a.storedDropoffLocation);
 if(!pl||!dl||
    pl.id!==a.pickupLocationId||dl.id!==a.dropoffLocationId||
    pl.partner_id!==PID||dl.partner_id!==PID||
    pl.active!==true||dl.active!==true||
    pl.is_api_managed!==true||dl.is_api_managed!==true||
    pl.return_only===true||
    pl.external_id!==row.pickup_location_external_id||
    dl.external_id!==row.dropoff_location_external_id||
    pl.location_name!==a.pickupName||dl.location_name!==a.returnName)
   return err("CARAVEL_BOOKING_LOCATION_BINDING_INVALID");
 if(a.startDate>=a.endDate||
    typeof a.mainDriverName!=="string"||!a.mainDriverName.trim()||
    !Number.isSafeInteger(a.mainDriverAge)||a.mainDriverAge<18||
    a.mainDriverAge>90||
    typeof a.clientEmail!=="string"||!a.clientEmail.includes("@")||
    typeof a.clientPhone!=="string"||!a.clientPhone.trim())
  return err("CARAVEL_BOOKING_CUSTOMER_SCOPE_INVALID");
 try{
  assertApiQuoteContext(raw,{
   pickup_time:a.pickupTime,return_time:a.returnTime,
   pickup_location:a.pickupName,return_location:a.returnName,
  });
 }catch{return err("CARAVEL_BOOKING_QUOTE_CONTEXT_CHANGED");}
 const now=a.preflight?.nowEpochMs;
 if(!Number.isSafeInteger(now)||time(row.expires_at)===null||
    time(row.expires_at)!<=now+10*60*1000||
    time(provider.expires_at)!==time(row.expires_at)||
    provider.quote_id!==row.external_quote_reference||
    provider.vehicle_id!==row.external_group_id||
    a.preflight.serverQuote!==provider)
  return err("CARAVEL_BOOKING_QUOTE_EXPIRED_OR_CHANGED");
 const p=prepareCaravelPrepayment(a.preflight);
 if("errors" in p)return err(p.errors[0]??"CARAVEL_BOOKING_PRESTRIPE_BLOCK");
 const rent=money(row.partner_net_total),fee=money(row.commission_total);
 const full=money(row.final_total),discount=Number(row.partner_discount_percent);
 const margin=Number(row.platform_margin_percent);
 if(rent===null||fee===null||full===null||
    p.amountMinor!==rent||row.currency!==p.currency||
    rent+fee!==full||fee<=0||discount!==0||
    !Number.isFinite(margin)||margin<=0||margin>100||
    Math.abs(fee-Math.round(rent*margin/100))>1)
  return err("CARAVEL_BOOKING_RIDE24_PRICE_MISMATCH");
 if(!Number.isFinite(a.exchangeRatePln)||a.exchangeRatePln<=0||
    !Number.isFinite(a.reservationFeePln)||a.reservationFeePln<=0||
    Math.abs(a.reservationFeePln-fee/100*a.exchangeRatePln)>0.02)
  return err("CARAVEL_BOOKING_FX_FEE_MISMATCH");
 if(!Number.isSafeInteger(Math.round(a.reservationFeePln*100))||
    Math.round(a.reservationFeePln*100)<1)
  return err("CARAVEL_BOOKING_STRIPE_FEE_INVALID");
 const quoteId=p.quoteId;
 if(quoteId!==row.external_quote_reference||
    p.supplierId!==provider.supplier_id)
  return err("CARAVEL_BOOKING_SUPPLIER_SCOPE_CHANGED");
 const iso=new Date(now).toISOString();
 const payload:Rec={
  partner_id:PID,car_class_id:row.car_class_id,client_id:a.authenticatedClientId,
  pickup_location_id:a.pickupLocationId,dropoff_location_id:a.dropoffLocationId,
  start_date:a.startDate,end_date:a.endDate,
  pickup_time:a.pickupTime,return_time:a.returnTime,
  pickup_location:a.pickupName,return_location:a.returnName,
  status:"awaiting_payment",provider_type:"api",
  api_status:"caravel_awaiting_stripe",manual_review:false,
  api_quote_id:row.id,
  caravel_supplier_quote_id:quoteId,caravel_supplier_id:p.supplierId,
  partner_currency:p.currency,partner_discount_snapshot:0,
  partner_net_price_snapshot:rent/100,
  final_price_snapshot:full/100,commission_snapshot:fee/100,
  online_payment_pln:a.reservationFeePln,
  pickup_payment_partner_currency:rent/100,
  platform_margin_snapshot:margin,
  exchange_rate_snapshot:a.exchangeRatePln,
  deposit_snapshot:0,
  main_driver_name:a.mainDriverName,main_driver_age:a.mainDriverAge,
  client_email:a.clientEmail,client_phone:a.clientPhone,
  terms_accepted:true,terms_accepted_at:iso,
  ...p.bookingSnapshot,
 };
 return {ok:true,payload,quoteId:row.id as string};
}
