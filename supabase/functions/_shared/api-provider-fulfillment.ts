import { aggregatorAvailability, aggregatorQuoteOptions, aggregatorBook, aggregatorStatus } from './renteon-aggregator.ts';
import { selectedServices, serviceCents } from './provider-services.mjs';
import { DefiniteApiFailure } from './api-payment-flow.mjs';

// A new adapter must implement all four operations before it can accept payment.
// Generic HTTP endpoints are not evidence of safe post-payment fulfillment.
export function hasPaidFulfillmentAdapter(provider:unknown) { return provider === 'renteon_aggregator'; }
const fail=(code:string):never=>{throw new DefiniteApiFailure(code);};
const stable=(v:any):string=>JSON.stringify(v==null?null:Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
function terms(offer:any) {
 const omit=new Set(['Amount','CarRentalAmount','PriceDate']);
 // Conservatively compare every offered field except price/quote timestamp.
 return Object.fromEntries(Object.entries(offer).filter(([k])=>!omit.has(k)));
}
function servicesContract(model:any) {
 return selectedServices(model).map((s:any)=>({id:s.ServiceId,code:s.Code,quantity:s.Quantity,
   name:s.Name,additionalName:s.AdditionalName,mandatory:s.IsMandatory,prepaid:s.Prepaid,
   price:s.ServicePrice})).sort((a:any,b:any)=>a.id-b.id);
}
export async function revalidatePaidProvider(credentials:any,booking:any,quote:any) {
 if(!hasPaidFulfillmentAdapter(booking.partners.api_provider))fail('ADAPTER_NOT_READY');
 if(booking.cancelled_at || ['cancelled','rejected','expired','payment_expired'].includes(booking.status))fail('CANCELLED_BEFORE_DISPATCH');
 if(!quote)fail('ACCEPTED_QUOTE_REQUIRED');
 const raw=quote.raw_response,old=raw?.provider_quote_data,options=raw?.ride24_options;
 if(!old?.offer||!old.calculated||!options?.binding||!options.snapshot)fail('ACCEPTED_QUOTE_REQUIRED');
 if(quote.booking_id!==booking.id||quote.partner_id!==booking.partner_id||quote.car_class_id!==booking.car_class_id
   ||serviceCents(booking.partner_net_price_snapshot)!==options.snapshot.partner_cents
   ||serviceCents(booking.online_payment_pln)!==options.snapshot.online_pln_cents
   ||booking.partner_currency!==options.snapshot.currency)fail('ACCEPTED_QUOTE_MISMATCH');
 if(booking.partners.rental_terms_url!==booking.partner_terms_snapshot||booking.partners.rental_rules_url!==booking.partner_rules_snapshot)
   fail('PARTNER_DOCUMENTS_CHANGED');
 const input={pickup_location_id:quote.pickup_location_external_id,dropoff_location_id:quote.dropoff_location_external_id,
   pickup_date:booking.start_date,return_date:booking.end_date,pickup_time:booking.pickup_time,return_time:booking.return_time,currency:booking.partner_currency};
 // Never use an expired stored availability response, even if its old price still calculates.
 const available=await aggregatorAvailability(credentials,input);
 const match=available.find((x:any)=>x.external_id===quote.external_group_id
   &&stable(terms(x.provider_quote_data?.offer||{}))===stable(terms(old.offer)));
 if(!match)fail(available.some((x:any)=>x.external_id===quote.external_group_id)?'PROVIDER_TERMS_CHANGED':'PROVIDER_UNAVAILABLE');
 const result=await aggregatorQuoteOptions(credentials,match.provider_quote_data,options.binding.selections,options.binding.ages);
 if(serviceCents(result.calculated.Total)!==options.snapshot.partner_cents
   ||stable(servicesContract(result.calculated))!==stable(servicesContract(old.calculated)))fail('PROVIDER_PRICE_OR_SERVICES_CHANGED');
 return {idempotency_key:'ride24:'+booking.id,ride24_booking_id:booking.id,reservation_code:booking.reservation_code,
   vehicle_group_id:quote.external_group_id,...input,partner_amount:options.snapshot.partner_cents/100,
   partner_discount_percent:Number(quote.partner_discount_percent),provider_quote_data:result.provider_quote_data,
   main_driver:{name:booking.main_driver_name,age:Number(booking.main_driver_age)},
   additional_driver:booking.add_driver_name?{name:booking.add_driver_name,age:Number(booking.add_driver_age)}:null,
   client_email:booking.client_email,client_phone:booking.client_phone};
}
export async function createPaidProvider(credentials:any,input:any) { return aggregatorBook(credentials,input); }
export async function readPaidProviderStatus(credentials:any,reference:string,prepared:any) {
 const result=await aggregatorStatus(credentials,reference);
 if(result.status==='cancelled')return {...result,status:'rejected',definitive_rejection:true};
 const row:any=result.provider_payload;
 const expected=prepared?.provider_quote_data?.calculated;
 const localDate=(v:any)=>String(v||'').replace(/(?:\.000)?Z$/,'').slice(0,19);
 // Provider status alone does not certify unchanged money and equipment.
 try {
   if(!expected || row?.Currency!==expected.Currency||row?.Prepaid!==false||row?.CarCategory!==expected.CarCategory
     ||localDate(row?.PickupDate)!==localDate(expected.PickupDate)||localDate(row?.DropOffDate)!==localDate(expected.DropOffDate)
     ||!expected.PickupOffice?.LocationCode||!expected.DropOffOffice?.LocationCode
     ||row?.PickupOffice?.LocationCode!==expected.PickupOffice.LocationCode||row?.DropOffOffice?.LocationCode!==expected.DropOffOffice.LocationCode
     ||serviceCents(row?.Total)!==serviceCents(prepared.partner_amount)
     ||stable(servicesContract(row))!==stable(servicesContract(prepared.provider_quote_data.calculated)))
     return {...result,needs_manual_review:true};
 } catch {return {...result,needs_manual_review:true};}
 return result;
}
