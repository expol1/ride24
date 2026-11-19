import { aggregatorAvailability, aggregatorQuoteOptions, aggregatorBook, aggregatorStatus } from './renteon-aggregator.ts';
import { arventSearch, arventCreateBooking, arventBookingStatus } from './arvent-kolaycar.ts';
import { arventLicenseEligible } from './arvent-driver-eligibility.mjs';
import { selectedServices, serviceCents } from './provider-services.mjs';
import { DefiniteApiFailure } from './api-payment-flow.mjs';

// A new adapter must implement all four operations before it can accept payment.
// Generic HTTP endpoints are not evidence of safe post-payment fulfillment.
function arventPaymentApproved():boolean {
 // Supplier terms currently say "supplier approval before Stripe"; Ride24's
 // existing API flow is Stripe-first. A written amendment is required.
 // Neither customer traffic nor a merchant-approved transaction can use the
 // Arvent branch unless BOTH separate server flags are explicitly enabled.
 return typeof Deno!=='undefined'
   &&Deno.env.get('ARVENT_KOLAYCAR_WRITE_ALLOWED')==='true'
   &&Deno.env.get('ARVENT_STRIPE_FIRST_APPROVED')==='true';
}
export function hasPaidFulfillmentAdapter(provider:unknown) {
 return provider==='renteon_aggregator'
  ||(provider==='arvent_kolaycar'&&arventPaymentApproved());
}
const fail=(code:string):never=>{throw new DefiniteApiFailure(code);};
const stable=(v:any):string=>JSON.stringify(v==null?null:Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
function terms(offer:any) {
 const omit=new Set(['Amount','CarRentalAmount','PriceDate','ModelName','CarModelImageURL','SortOrder','SortOrderWeb']);
 // Book the category, never the representative model/photo or display order.
 // Preserve equipment, seating, insurance and all other contractual constraints.
 return Object.fromEntries(Object.entries(offer).filter(([k])=>!omit.has(k)));
}
function servicesContract(model:any) {
 return selectedServices(model).map((s:any)=>({id:s.ServiceId,code:s.Code,quantity:s.Quantity,
   name:s.Name,additionalName:s.AdditionalName,mandatory:s.IsMandatory,prepaid:s.Prepaid,
   price:s.ServicePrice})).sort((a:any,b:any)=>a.id-b.id);
}
export async function revalidatePaidProvider(credentials:any,booking:any,quote:any) {
 if(!hasPaidFulfillmentAdapter(booking.partners.api_provider))fail('ADAPTER_NOT_READY');
 if(booking.partners.api_provider==='arvent_kolaycar')
  return revalidatePaidArvent(credentials,booking,quote);
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
// Supplier live offers are SIPP groups. The technical vehicleId is private
// and is allowed to change between browsing and revalidation ONLY if the
// customer-selected SIPP, rental total and explicitly verified conditions
// remain identical. Do not trust stale reservationTokens or displayed models.
async function revalidatePaidArvent(credentials:any,booking:any,quote:any) {
 if(booking.cancelled_at||['cancelled','rejected','expired','payment_expired'].includes(booking.status))
  fail('CANCELLED_BEFORE_DISPATCH');
 if(!quote||quote.booking_id!==booking.id||quote.partner_id!==booking.partner_id
   ||quote.car_class_id!==booking.car_class_id||booking.api_quote_id!==quote.id
   ||quote.start_date!==booking.start_date||quote.end_date!==booking.end_date)
  fail('ACCEPTED_QUOTE_MISMATCH');
 if(!booking.partner_terms_snapshot||!booking.partner_rules_snapshot
   ||booking.partners.rental_terms_url!==booking.partner_terms_snapshot
   ||booking.partners.rental_rules_url!==booking.partner_rules_snapshot)
  fail('PARTNER_DOCUMENTS_CHANGED');
 const old=quote.raw_response?.provider_quote_data;
 const sipp=String(quote.external_group_id||'');
 const vehicleId=String(old?.vehicle_id||'');
 const cents=(v:any):number|null=>{
  // Supabase numeric columns may be returned as numbers or decimal strings.
  if(typeof v!=='number'&&(typeof v!=='string'||v.trim()===''))return null;
  const n=Number(v);
  if(!Number.isFinite(n)||n<0||n>1000000)return null;
  return serviceCents(n);
 };
 const net=cents(booking.partner_net_price_snapshot);
 if(old?.provider!=='arvent_kolaycar'||!/^[A-Z]{4}$/.test(sipp)
   ||old?.sipp!==sipp||!/^\d+$/.test(vehicleId)
   ||quote.currency!=='EUR'||booking.partner_currency!=='EUR'
   ||Number(quote.partner_discount_percent)!==0
   ||net===null||net<=0||net!==cents(quote.partner_net_total)
   ||net!==cents(old.total_amount)
   ||(cents(booking.online_payment_pln)??0)<=0)
  fail('ACCEPTED_QUOTE_MISMATCH');
 if(booking.add_driver_name||booking.add_driver_age||!booking.main_driver_name
   ||!booking.client_email||!booking.client_phone)
  fail('ARVENT_DRIVER_DETAILS_UNSUPPORTED');
 const pickup=String(quote.pickup_location_external_id||'');
 const dropoff=String(quote.dropoff_location_external_id||pickup);
 const cleanTime=(v:any)=>/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(v||''))?String(v).slice(0,5):null;
 const pickupTime=cleanTime(booking.pickup_time),returnTime=cleanTime(booking.return_time);
 if(!/^\d+$/.test(pickup)||!/^\d+$/.test(dropoff)
   ||old.pickup_location_id!==pickup||old.dropoff_location_id!==dropoff
   ||!pickupTime||!returnTime)fail('ACCEPTED_QUOTE_MISMATCH');
 // Our API pricing layer must have no supplier-side optional extras or
 // prepaid rental components for this first protected rollout.
 if(quote.raw_response?.ride24_options?.binding?.selections?.length)
  fail('ARVENT_EXTRAS_UNSUPPORTED');
 const input={pickup_location_id:pickup,dropoff_location_id:dropoff,
   pickup_date:booking.start_date,return_date:booking.end_date,
   pickup_time:pickupTime,return_time:returnTime,currency:'EUR'};
 const live=await arventSearch(credentials,input);
 const match=live.find((offer:any)=>offer.external_id===sipp
   &&offer.currency==='EUR'&&offer.deposit_amount===0
   &&cents(offer.public_price_total)===net);
 if(!match)fail(live.some((offer:any)=>offer.external_id===sipp)
   ?'PROVIDER_PRICE_OR_TERMS_CHANGED':'PROVIDER_UNAVAILABLE');
 if(pickup!==dropoff)fail('ARVENT_ONE_WAY_PAYMENT_UNVERIFIED');
 // Supplier requires the actual length of licence tenure. Validate
 // a first-issued date self-declared by the selected main driver; never
 // infer tenure from age and never allow a missing/future issue date.
 const minLicenceYears=match.features?.min_license_years;
 if(!arventLicenseEligible(booking.main_driver_license_since,
     booking.start_date,minLicenceYears))
   fail('ARVENT_LICENCE_TENURE_UNVERIFIED');
 const age=Number(booking.main_driver_age);
 const minAge=match.features?.minimum_driver_age;
 if(!Number.isInteger(age)||age<18
   ||typeof minAge!=="number"||!Number.isInteger(minAge)||minAge<18||age<minAge)
  fail('ARVENT_DRIVER_AGE_NOT_ALLOWED');
 const selected=match.provider_quote_data as Record<string,unknown>|null;
 if(selected?.provider!=='arvent_kolaycar'
   ||selected.sipp!==sipp
   ||!/^\d+$/.test(String(selected.vehicle_id||'')))
  fail('PROVIDER_TERMS_CHANGED');
 return {
   provider:'arvent_kolaycar',idempotency_key:'ride24:'+booking.id,
   ride24_booking_id:booking.id,reservation_code:booking.reservation_code,
   vehicle_group_id:sipp,...input,partner_amount:net/100,
   partner_discount_percent:0,provider_quote_data:match.provider_quote_data,
   main_driver:{name:booking.main_driver_name,age,
     license_first_issued:booking.main_driver_license_since},
   additional_driver:null,
   client_email:booking.client_email,client_phone:booking.client_phone,
 };
}
export async function createPaidProvider(credentials:any,input:any) {
 if(input?.provider==='arvent_kolaycar'){
   if(!arventPaymentApproved())fail('ADAPTER_NOT_READY');
   try {
     return await arventCreateBooking(credentials,input);
   } catch(error) {
     if(error instanceof Error&&error.message==='ARVENT_FAILED_BEFORE_SAVE')fail('ARVENT_FAILED_BEFORE_SAVE');
     throw error;
   }
 }
 if(input?.provider&&input.provider!=='renteon_aggregator')fail('ADAPTER_NOT_READY');
 return aggregatorBook(credentials,input);
}
export async function readPaidProviderStatus(credentials:any,reference:string,prepared:any) {
 if(prepared?.provider==='arvent_kolaycar'){
  if(!arventPaymentApproved())fail('ADAPTER_NOT_READY');
  const result=await arventBookingStatus(credentials,reference);
  return result.status==='cancelled'
   ?{...result,status:'rejected',definitive_rejection:true}
   :result;
 }
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
