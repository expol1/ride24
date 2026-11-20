import { arventLicenseEligible } from "./arvent-driver-eligibility.mjs";
import { partnerApiRequest, sanitizePartnerPayload, type PartnerApiCredentials, type ApiLocation, type ApiVehicleGroup } from "./partner-api.ts";
import { serviceClient } from "./ride24-security.ts";
import { rentalDuration } from "./rental-duration.ts";
import { arventSelectedExtrasQuote,arventReceiptExtrasMatch } from "./arvent-extras-pricing.mjs";
import {
 ARVENT_ORIGIN, ARVENT_PATHS, arventDate, arventQuery, supplierData,
 arventLocationRows, arventGroupRows, arventOfferRows, arventCatalogRows, arventOfferExtrasRows, arventAssertVehicleOnlyExtrasSafe,
 arventOfferMatchesTerms, arventReservationStatus, arventSavePayload, arventSavedRouteMatches,
 arventLeadTimeAllowed,
} from "./arvent-kolaycar-contract.mjs";

type SearchInput={
 pickup_location_id:string;dropoff_location_id:string;pickup_date:string;return_date:string;
 pickup_time?:string|null;return_time?:string|null;currency?:string|null;
};
type BookingInput=SearchInput&{
 idempotency_key:string;ride24_booking_id:string;reservation_code?:string|null;
 vehicle_group_id:string|null;main_driver?:{name?:string|null;age?:number|null;license_first_issued?:string|null}|null;
 client_email?:string|null;client_phone?:string|null;
 partner_discount_percent?:number|null;partner_amount?:number|null;
 provider_quote_data?:unknown;
 additional_driver?:{name?:string|null;age?:number|null;license_first_issued?:string|null}|null;
 rental_amount?:number|null;extras_amount?:number|null;
 extra_selections?:Array<{code:string;quantity:number;total_cents:number;required?:boolean}>;
 extra_billing_map?:Record<string,string>;
 extras_pricing_certified?:boolean;
 supplier_note?:string|null;
};

const sessions=new Map<string,{token:string;until:number}>();
function safeCredentials(c:PartnerApiCredentials):void {
 if(c.api_url!==ARVENT_ORIGIN)throw Error("PARTNER_API_ERROR:ARVENT_ORIGIN");
 if(!c.partner_id||!c.username||!c.password)
  throw Error("PARTNER_API_ERROR:ARVENT_CREDENTIALS_MISSING");
}
async function bearer(c:PartnerApiCredentials,force=false):Promise<string>{
 safeCredentials(c);
 const key=c.partner_id;
 const prior=sessions.get(key);
 if(!force&&prior&&prior.until>Date.now())return prior.token;
 // The auth request must never send credentials in request headers or URL.
 const unauth={...c,auth_type:"custom_headers",api_key:null,api_secret:null,
  username:null,password:null,bearer_token:null,extra_headers:{}};
 const response=await partnerApiRequest<unknown>(unauth,ARVENT_PATHS.auth,{
  method:"POST",body:{username:c.username,password:c.password}});
 const data=supplierData(response);
 const token=data&&typeof data==="object"&&(data as Record<string,unknown>).token;
 if(typeof token!=="string"||!token||token.length>8000)
  throw Error("PARTNER_API_ERROR:ARVENT_AUTH_TOKEN_INVALID");
 // Supplier doesn't document expiry. Cache for five minutes, retry once on 401.
 sessions.set(key,{token,until:Date.now()+5*60*1000});
 return token;
}
async function request(c:PartnerApiCredentials,path:string,options:{method?:string;body?:unknown}={}):Promise<unknown>{
 safeCredentials(c);
 for(let attempt=0;attempt<2;attempt++){
  const token=await bearer(c,attempt===1);
  const auth={...c,auth_type:"bearer",bearer_token:token,username:null,
   password:null,api_key:null,api_secret:null,extra_headers:{}};
  try {
   return await partnerApiRequest<unknown>(auth,path,options);
  } catch(error){
   // Never automatically replay supplier creation/cancellation POST requests:
   // agencyReservationReference is not an idempotency guarantee.
   if(attempt===0&&(options.method||"GET").toUpperCase()==="GET"&&error instanceof Error&&error.message==="PARTNER_API_ERROR:HTTP:401"){
    sessions.delete(c.partner_id);continue;
   }
   throw error;
  }
 }
 throw Error("PARTNER_API_ERROR:ARVENT_AUTH_FAILED");
}
function language(path:string):string{return path+"?"+arventQuery({languageCode:"EN"});}
export async function arventTestConnection(c:PartnerApiCredentials):Promise<void>{
 const response=await request(c,language(ARVENT_PATHS.locations));
 const rows=arventLocationRows(response);
 if(!rows.length)throw Error("PARTNER_API_ERROR:ARVENT_LOCATIONS_EMPTY");
}
export async function arventFetchLocations(c:PartnerApiCredentials):Promise<ApiLocation[]>{
 const [locations,cities]=await Promise.all([
  request(c,language(ARVENT_PATHS.locations)),
  request(c,ARVENT_PATHS.cities+"?"+arventQuery({countryCode:"TR"}))
   .then(supplierData).catch(()=>[]),
 ]);
 return arventLocationRows(locations,cities) as ApiLocation[];
}
export async function arventFetchGroups(c:PartnerApiCredentials):Promise<ApiVehicleGroup[]>{
 const response=await request(c,language(ARVENT_PATHS.groups));
 return arventGroupRows(response) as ApiVehicleGroup[];
}
const extrasCatalogCache=new Map<string,{until:number;items:Array<{code:string;name:string}>}>();
// Read-only global catalogue. Item names are not proof of availability or price.
export async function arventFetchExtrasCatalog(c:PartnerApiCredentials):Promise<Array<{code:string;name:string}>>{
 const cached=extrasCatalogCache.get(c.partner_id);
 if(cached&&cached.until>Date.now())return cached.items;
 const items=arventCatalogRows(await request(c,language(ARVENT_PATHS.extras_catalog)));
 extrasCatalogCache.set(c.partner_id,{until:Date.now()+10*60*1000,items});
 return items;
}

function searchPath(input:SearchInput):string {
 const pickup=String(input.pickup_location_id||"").trim();
 const dropoff=String(input.dropoff_location_id||pickup).trim();
 if(!/^[1-9]\d{0,9}$/.test(pickup)||!/^[1-9]\d{0,9}$/.test(dropoff))
  throw Error("PARTNER_API_ERROR:ARVENT_LOCATION_ID_INVALID");
 if(String(input.currency||"EUR").toUpperCase()!=="EUR")
  throw Error("PARTNER_API_ERROR:ARVENT_CURRENCY_UNSUPPORTED");
 const time=(value:string|null|undefined)=>{
  const match=/^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(value||"");
  if(!match)throw Error("PARTNER_API_ERROR:ARVENT_TIME_INVALID");
  return match[1]+":"+match[2];
 };
 return ARVENT_PATHS.search+"?"+arventQuery({
  pickupLocationId:pickup,returnLocationId:dropoff,
  pickupDate:arventDate(input.pickup_date),returnDate:arventDate(input.return_date),
  pickupTime:time(input.pickup_time),returnTime:time(input.return_time),
  currencyCode:"EUR",languageCode:"EN",
 });
}
export async function arventSearch(c:PartnerApiCredentials,input:SearchInput):Promise<ApiVehicleGroup[]>{
 // Less than 47h before pickup: no offers. The same search runs again before
 // SaveReservation, so a paid booking that crosses the limit is refunded
 // before anything is sent to Arvent.
 if(!arventLeadTimeAllowed(input.pickup_date,input.pickup_time))return [];
 const response=await request(c,searchPath(input));
 return arventOfferRows(response,{...input,currency:"EUR"}) as ApiVehicleGroup[];
}
// Read-only offer-specific extras preview. This verifies the same SIPP, private
// supplier vehicle id, exact EUR rental price, full-insurance terms and route
// as the customer's selected Ride24 quote BEFORE requesting GET /extras.
// A new ephemeral reservationToken never leaves this server function.
export async function arventReadOfferExtras(c:PartnerApiCredentials,input:SearchInput,
 quote:{vehicle_id:string;sipp:string;total_amount:number}):Promise<
 {status:"none"|"present";items:ReturnType<typeof arventOfferExtrasRows>;billed_days:number|null}> {
 const vehicleId=String(quote?.vehicle_id||"");
 const sipp=String(quote?.sipp||"").toUpperCase();
 const amount=Number(quote?.total_amount);
 if(!/^[1-9][0-9]*$/.test(vehicleId)||!/^[A-Z]{4}$/.test(sipp)
    ||!Number.isFinite(amount)||amount<=0)throw Error("PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED");
 const live=supplierData(await request(c,searchPath(input)));
 const vehicles=Array.isArray(live)?live:(live&&typeof live==="object"
  &&Array.isArray((live as any).vehicles)?(live as any).vehicles:[]);
 const vehicle=vehicles.find((x:any)=>String(x?.vehicleId)===vehicleId
  &&String(x?.sippCode||"").toUpperCase()===sipp
  &&arventOfferMatchesTerms(x,"EUR")&&x.totalPrice===amount);
 if(!vehicle)throw Error("PARTNER_API_ERROR:ARVENT_OFFER_CHANGED");
 const data=supplierData(await request(c,ARVENT_PATHS.extras+"?"+arventQuery({
  reservationToken:vehicle.reservationToken,languageCode:"EN"})));
 if(!data||typeof data!=="object")throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_SHAPE");
 const priced=(data as any).vehicle;
 if(!priced||String(priced.vehicleId)!==vehicleId
  ||String(priced.sippCode||"").toUpperCase()!==sipp
  ||!arventOfferMatchesTerms(priced,"EUR")
  ||priced.totalPrice!==amount
  ||priced.reservationToken!==vehicle.reservationToken
  ||!arventSavedRouteMatches({
   pickupLocationId:priced.pickupLocationId,returnLocationId:priced.returnLocationId,
   pickupDate:priced.pickupDateTime,returnDate:priced.returnDateTime,
  },input))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED");
 // Do not decide mandatory-item billing here. The Arvent-only booking
 // options route applies the certified billing map to the offer-bound items.
 // A vehicle-only SaveReservation still rejects unpriced mandatory items.
 const items=arventOfferExtrasRows((data as any).extras);
 const sourceDays=Number(vehicle.rentalDuration);
 const pricedDays=Number(priced.rentalDuration);
 const validDays=(x:number)=>Number.isInteger(x)&&x>=1&&x<=366;
 if(validDays(sourceDays)&&validDays(pricedDays)&&sourceDays!==pricedDays)
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED");
 const billedDays=validDays(pricedDays)?pricedDays:validDays(sourceDays)?sourceDays:null;
 return {status:items.length?"present":"none",items,billed_days:billedDays};
}

async function bookingContextFor(c:PartnerApiCredentials,reference:string):Promise<{
 id:string;client_email:string;partner_currency:unknown;partner_net_price_snapshot:unknown;
 api_quote_id:string|null;start_date:string;end_date:string;pickup_time:string;return_time:string;
}> {
 const admin=serviceClient();
 const {data,error}=await admin.from("bookings").select("id,client_email,partner_currency,partner_net_price_snapshot,api_quote_id,start_date,end_date,pickup_time,return_time")
  .eq("partner_id",c.partner_id).eq("api_booking_reference",reference).limit(1).maybeSingle();
 if(error||typeof data?.client_email!=="string"||!data.client_email)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_EMAIL_NOT_FOUND");
 return data;
}
// Retain only the supplier evidence required for reconciliation.
function statusEvidence(data:Record<string,unknown>){
 const fields=["reservationNumber","agencyReservationReference","reservationStatusType","sippCode",
  "currencyCode","totalPrice","depositPrice","depositCreditCardRequired","totalKMLimit",
  "pickupLocationId","returnLocationId","pickupDate","returnDate"];
 return sanitizePartnerPayload(Object.fromEntries(fields.map(key=>[key,data[key]])),4000);
}
// Live Arvent reservation responses (save and GET /reservations, verified
// 2026-11-19 on 17BFA78FB3F6) do NOT include sippCode. The SIPP group is
// bound earlier: the reservationToken comes from the exact offer whose SIPP,
// price and terms were rechecked immediately before SaveReservation. A
// sippCode that IS returned must still match; only its absence is tolerated.
function sippConsistent(d:Record<string,unknown>,expected:unknown):boolean {
 if(typeof expected!=="string"||!/^[A-Z]{4}$/.test(expected))return false;
 if(d.sippCode===undefined||d.sippCode===null||d.sippCode==="")return true;
 return typeof d.sippCode==="string"&&d.sippCode.toUpperCase()===expected;
}
function confirmedContract(d:Record<string,unknown>,expectedPrice:unknown):boolean {
 const wanted=Number(expectedPrice);
 return Number.isFinite(wanted)&&wanted>0
  &&typeof d.totalPrice==="number"&&Number.isFinite(d.totalPrice)
  &&d.totalPrice===wanted
  &&d.currencyCode==="EUR"&&d.depositPrice===0
  &&d.depositCreditCardRequired===false&&d.totalKMLimit===0;
}
export async function arventBookingStatus(c:PartnerApiCredentials,reference:string):Promise<Record<string,unknown>> {
 const booking=await bookingContextFor(c,reference);
 const response=await request(c,ARVENT_PATHS.booking_status+"?"+arventQuery({
  reservationNumber:reference,customerEmail:booking.client_email}));
 const status=arventReservationStatus(response),d=supplierData(response) as Record<string,unknown>;
 if(status.booking_reference!==reference)
  throw Error("PARTNER_API_ERROR:ARVENT_REFERENCE_MISMATCH");
 const admin=serviceClient();
 const {data:quote,error:quoteError}=booking.api_quote_id
  ?await admin.from("api_quotes")
    .select("external_group_id,pickup_location_external_id,dropoff_location_external_id,raw_response")
    .eq("id",booking.api_quote_id).eq("partner_id",c.partner_id).maybeSingle()
  :{data:null,error:null};
 const routeValid=!quoteError&&quote
  &&arventSavedRouteMatches(d,{
   pickup_location_id:quote.pickup_location_external_id,
   dropoff_location_id:quote.dropoff_location_external_id,
   pickup_date:booking.start_date,return_date:booking.end_date,
   pickup_time:booking.pickup_time,return_time:booking.return_time,
  });
 const expectedExtras=quote?.raw_response?.ride24_options?.arvent_extra?.selected||[];
 const extrasVerified=arventReceiptExtrasMatch(d.reservationExtras??d.extras,expectedExtras);
 const verified=booking.partner_currency==="EUR"&&confirmedContract(d,booking.partner_net_price_snapshot)
  &&routeValid===true&&sippConsistent(d,quote?.external_group_id)&&extrasVerified;
 // If status is "approved" but supplier price/terms cannot be proved, do
 // NOT return confirmed to the shared booking-status-sync handler.
 const confirmed=status.status==="confirmed"&&verified;
 return {...status,status:status.status==="confirmed"&&!confirmed?"pending":status.status,
  needs_manual_review:status.needs_manual_review||(status.status==="confirmed"&&!confirmed),
  // Money, EUR, zero deposit/card hold, unlimited km, route, times and SIPP
  // match the paid booking (independent of the supplier status code).
  terms_verified:verified===true,
  extras_verified:extrasVerified===true,
  provider_payload:statusEvidence(d)};
}
// Supplier documentation only supports GET /reservations by supplier
// reservationNumber + original customerEmail. It does NOT document a lookup
// by agencyReservationReference, so do not send an unsupported query or
// falsely treat an empty response as proof that a timed-out POST failed.
// An ambiguous SaveReservation outcome requires manual reconciliation with
// Arvent until they document a supported idempotency/recovery mechanism.
export async function arventLookupByAgencyReference(
 _c:PartnerApiCredentials,_reference:string,_email:string,
):Promise<Record<string,unknown>|null>{
 throw Error("PARTNER_API_ERROR:ARVENT_AGENCY_LOOKUP_UNSUPPORTED");
}
function allowSupplierMutation():void {
 // Different from api_enabled: explicit server-side provider certification gate.
 if(Deno.env.get("ARVENT_KOLAYCAR_WRITE_ALLOWED")!=="true")
  throw Error("PARTNER_API_ERROR:ARVENT_WRITES_NOT_CERTIFIED");
}
async function prepareReservation(c:PartnerApiCredentials,input:BookingInput){
 if(input.pickup_location_id!==input.dropoff_location_id)
  throw Error("PARTNER_API_ERROR:ARVENT_ONE_WAY_PAYMENT_UNVERIFIED");
 if(Number(input.partner_discount_percent??0)!==0||!Number.isFinite(input.partner_amount)
  ||(input.partner_amount??0)<=0)
  throw Error("PARTNER_API_ERROR:ARVENT_PRICING_OR_EXTRAS_UNSUPPORTED");
 const accepted=Array.isArray(input.extra_selections)?input.extra_selections:[];
 if(accepted.length && input.extras_pricing_certified!==true)
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_NOT_CERTIFIED");
 if(Boolean(input.additional_driver)!==accepted.some(x=>x.code==="2"))
  throw Error("PARTNER_API_ERROR:ARVENT_ADDITIONAL_DRIVER_MISMATCH");
 if(!input.vehicle_group_id||!input.main_driver?.name||!input.client_email||!input.client_phone)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_INPUT_MISSING");
 if(!arventLeadTimeAllowed(input.pickup_date,input.pickup_time))
  throw Error("PARTNER_API_ERROR:ARVENT_MIN_LEAD_TIME");
 const quote=input.provider_quote_data as Record<string,unknown>|null;
 // Ride24 sells ACRISS/SIPP groups like AVIA. Keep the chosen supplier
 // vehicleId only in the private quote payload; never present it as a category.
 const supplierVehicleId=String(quote?.vehicle_id||"");
 if(!quote||quote.provider!=="arvent_kolaycar"
  ||quote.sipp!==input.vehicle_group_id
  ||!/^\d+$/.test(supplierVehicleId)
  ||!Number.isFinite(Number(quote.total_amount))
  ||Number(quote.total_amount)!==Number(input.rental_amount??input.partner_amount))
  throw Error("PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED");
 // Re-price with a newly issued token. Never use or persist an old reservationToken.
 const live=supplierData(await request(c,searchPath(input)));
 const list=Array.isArray(live)?live:(live&&typeof live==="object"&&Array.isArray((live as any).vehicles)?(live as any).vehicles:[]);
 const current=list.find((x:any)=>String(x?.vehicleId)===supplierVehicleId
  &&String(x?.sippCode||"").toUpperCase()===input.vehicle_group_id
  &&arventOfferMatchesTerms(x,"EUR"));
 if(!current)throw Error("PARTNER_API_ERROR:ARVENT_OFFER_CHANGED");
 const actual=Number(current.totalPrice);
 if(actual!==Number(input.rental_amount??input.partner_amount))
  throw Error("PARTNER_API_ERROR:ARVENT_PRICE_CHANGED");
 const extraData=supplierData(await request(c,ARVENT_PATHS.extras+"?"+arventQuery({
  reservationToken:current.reservationToken,languageCode:"EN"})));
 if(!extraData||typeof extraData!=="object"
  ||((extraData as any).extras!==null&&!Array.isArray((extraData as any).extras)))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_SHAPE");
 // Live Arvent /extras may legitimately return `extras:null`.
 // Its vehicle is still the final reservation-token quotation and must
 // match the user's accepted period, route, price, currency and terms.
 const pricedVehicle=(extraData as any).vehicle;
 if(!pricedVehicle||String(pricedVehicle.vehicleId)!==supplierVehicleId
  ||String(pricedVehicle.sippCode||"").toUpperCase()!==input.vehicle_group_id
  ||!arventOfferMatchesTerms(pricedVehicle,"EUR")
  ||pricedVehicle.totalPrice!==actual
  ||pricedVehicle.reservationToken!==current.reservationToken
  ||!arventSavedRouteMatches({
    pickupLocationId:pricedVehicle.pickupLocationId,
    returnLocationId:pricedVehicle.returnLocationId,
    pickupDate:pricedVehicle.pickupDateTime,
    returnDate:pricedVehicle.returnDateTime,
  },input))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED");
 const age=input.main_driver.age;
 for(const vehicle of [current,pricedVehicle]){
  if(!arventLicenseEligible(input.main_driver?.license_first_issued,
       input.pickup_date,vehicle.vendorMinimumDrivingLicenseAge)
    ||!Number.isInteger(vehicle.vendorMinimumDriverAge)||vehicle.vendorMinimumDriverAge<18
    ||typeof age!=="number"||!Number.isInteger(age)||age<vehicle.vendorMinimumDriverAge)
   throw Error("PARTNER_API_ERROR:ARVENT_DRIVER_ELIGIBILITY_UNVERIFIED");
 }
 const extras=(extraData as any).extras||[];
 if(extras.some((item:any)=>typeof item?.isRequired!=="boolean"))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_SHAPE");
 const required=extras.filter((item:any)=>item.isRequired);
 if(!accepted.length){
   // Unchanged vehicle-only booking: allow confirmed free mandatory services
   // and never silently omit a payable service.
   arventAssertVehicleOnlyExtrasSafe((extraData as any).extras);
 }
 const duration=rentalDuration(input.pickup_date,input.return_date,input.pickup_time,input.return_time);
 const vehicleDays=Number(current.rentalDuration),confirmedDays=Number(pricedVehicle.rentalDuration);
 const validDays=(n:number)=>Number.isInteger(n)&&n>=1&&n<=366;
 if(validDays(vehicleDays)&&validDays(confirmedDays)&&vehicleDays!==confirmedDays)
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED");
 const supplierDays=validDays(confirmedDays)?confirmedDays:validDays(vehicleDays)?vehicleDays:null;
 if(accepted.some(x=>x.billing==="day"&&x.total_cents>0)&&supplierDays===null)
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_BILLING_DAYS_UNVERIFIED");
 const extrasQuote=accepted.length
    ?arventSelectedExtrasQuote({items:arventOfferExtrasRows(extras),
       selections:accepted.filter(x=>!x.required).map(x=>({id:x.code,quantity:x.quantity})),
       additionalDriverId:input.additional_driver?"provided":null,
       billedDays:supplierDays??duration.billedDays,certified:true,certifiedMap:input.extra_billing_map||{}})
    :{items:required.map((x:any)=>({code:String(x.code),quantity:1,total_cents:0,required:true})),
       total_cents:0,selected:required.map((x:any)=>({code:String(x.code),piece:1}))};
 if(accepted.length){
    if(extrasQuote.items.length!==accepted.length
      ||extrasQuote.items.some((x:any)=>!accepted.some(y=>x.code===y.code
        &&x.quantity===y.quantity&&x.total_cents===y.total_cents))
      ||extrasQuote.total_cents!==Math.round(Number(input.extras_amount)*100))
      throw Error("PARTNER_API_ERROR:ARVENT_EXTRA_PRICE_CHANGED");
 }
 if(Math.round((actual+extrasQuote.total_cents/100)*100)!==Math.round(Number(input.partner_amount)*100))
   throw Error("PARTNER_API_ERROR:ARVENT_EXTRA_PRICE_CHANGED");
 if(input.additional_driver){
   if(!arventLicenseEligible(input.additional_driver.license_first_issued,
         input.pickup_date,pricedVehicle.vendorMinimumDrivingLicenseAge)
      ||!Number.isInteger(Number(input.additional_driver.age))
      ||Number(input.additional_driver.age)<Number(pricedVehicle.vendorMinimumDriverAge)
      ||String(input.additional_driver.name||"").trim().split(/\s+/).length<2)
     throw Error("PARTNER_API_ERROR:ARVENT_ADDITIONAL_DRIVER_INELIGIBLE");
 }
 const name=String(input.main_driver.name).trim().split(/\s+/);
 const first=name.shift()||"",surname=name.join(" ");
 if(!surname)throw Error("PARTNER_API_ERROR:ARVENT_SURNAME_REQUIRED");
 return arventSavePayload({
  reservationToken:current.reservationToken,reference:input.reservation_code||input.ride24_booking_id,
  customer:{name:first,surname,email:input.client_email,phoneNumber:input.client_phone,birthDay:"",
   note:((typeof input.supplier_note==="string"?input.supplier_note:"")
      +(input.additional_driver?(" | Additional driver: "+String(input.additional_driver.name)
          +" / licence since "+String(input.additional_driver.license_first_issued)):"")).slice(0,250)},
  extras:extrasQuote.selected,
 });
}
export async function arventVerifyCheckout(c:PartnerApiCredentials,input:BookingInput):Promise<void>{
 await prepareReservation(c,input);
}
export async function arventCreateBooking(c:PartnerApiCredentials,input:BookingInput):Promise<Record<string,unknown>>{
 allowSupplierMutation();
 if(Deno.env.get("ARVENT_STRIPE_FIRST_APPROVED")!=="true")
  throw Error("PARTNER_API_ERROR:ARVENT_STRIPE_FIRST_UNAPPROVED");
 let payload;
 try {
  payload=await prepareReservation(c,input);
 } catch {
  // All supplier calls above are reads. No SaveReservation was attempted.
  throw Error("ARVENT_FAILED_BEFORE_SAVE");
 }
 // This call creates a real supplier booking; only reachable after external certification.
 const result=await request(c,ARVENT_PATHS.booking_create,{method:"POST",body:payload});
 const status=arventReservationStatus(result);
 if(!status.booking_reference)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_REFERENCE_MISSING");
 const d=supplierData(result) as Record<string,unknown>;
 const confirmedPrice=typeof d.totalPrice==="number"&&Number.isFinite(d.totalPrice)?d.totalPrice:null;
 const priceMismatch=confirmedPrice===null||confirmedPrice!==input.partner_amount;
 // A confirmed status alone does not prove that the booking preserves the
 // no-deposit/no-card/unlimited-km contract and EUR payable amount.
 const termsMismatch=d.agencyReservationReference!==payload.agencyReservationReference
  ||!sippConsistent(d,input.vehicle_group_id)
  ||d.currencyCode!=="EUR"||d.depositPrice!==0
  ||d.depositCreditCardRequired!==false||d.totalKMLimit!==0;
 const routeMismatch=!arventSavedRouteMatches(d,input);
 // A supplier reference is insufficient proof that payable equipment or an
 // additional driver was accepted. Missing reservationExtras means review.
 const expectedExtras=Array.isArray(input.extra_selections)?input.extra_selections:[];
 const extrasMismatch=!arventReceiptExtrasMatch(d.reservationExtras??d.extras,expectedExtras);
 return {...status,
  // Do not leak "confirmed" into generic handlers without full verification.
  status:status.status==="confirmed"&&(priceMismatch||termsMismatch||routeMismatch||extrasMismatch)?"pending":status.status,
  needs_manual_review:status.needs_manual_review||priceMismatch||termsMismatch||routeMismatch||extrasMismatch,
  provider_payload:statusEvidence(d),
  price_mismatch:priceMismatch,terms_mismatch:termsMismatch,route_mismatch:routeMismatch,
  extras_mismatch:extrasMismatch,
 };
}
export async function arventCancelBooking(c:PartnerApiCredentials,reference:string,body:Record<string,unknown>={}):Promise<Record<string,unknown>> {
 allowSupplierMutation();
 const booking=await bookingContextFor(c,reference);
 const email=booking.client_email;
 // All cancellation entry points share one durable claim per Ride24 booking.
 // A previous attempt may have reached Arvent even if its HTTP response was lost.
 const {error}=await serviceClient().from("arvent_cancel_attempts").insert({booking_id:booking.id});
 if(error?.code==="23505")return arventBookingStatus(c,reference);
 if(error)throw Error("PARTNER_API_ERROR:ARVENT_CANCEL_CLAIM_FAILED");
 // supplierData() throws on a business failure, so a rejected cancellation is
 // never read back as success. The live response shape of a successful
 // cancellation is not documented, so the authoritative proof is the
 // supplier's own reservation status (3=cancelled) read back by GET.
 supplierData(await request(c,ARVENT_PATHS.booking_cancel+"?"+arventQuery({
  reservationNumber:reference,customerEmail:email,cancelNote:typeof body.reason==="string"?body.reason:"Ride24 customer cancellation",
  languageCode:"EN",cancelReasonId:0,
 }),{method:"POST"}));
 const confirmed=await arventBookingStatus(c,reference);
 return {...confirmed,status:confirmed.status==="cancelled"?"cancelled":"pending",
  needs_manual_review:confirmed.status!=="cancelled"||confirmed.needs_manual_review===true};
}
