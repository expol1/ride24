import { arventLicenseEligible } from "./arvent-driver-eligibility.mjs";
import { partnerApiRequest, sanitizePartnerPayload, type PartnerApiCredentials, type ApiLocation, type ApiVehicleGroup } from "./partner-api.ts";
import { serviceClient } from "./ride24-security.ts";
import {
 ARVENT_ORIGIN, ARVENT_PATHS, arventDate, arventQuery, supplierData,
 arventLocationRows, arventGroupRows, arventOfferRows,
 arventOfferMatchesTerms, arventReservationStatus, arventSavePayload, arventSavedRouteMatches,
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
 additional_driver?:{name?:string|null;age?:number|null}|null;
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
 const response=await request(c,searchPath(input));
 return arventOfferRows(response,{...input,currency:"EUR"}) as ApiVehicleGroup[];
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
    .select("external_group_id,pickup_location_external_id,dropoff_location_external_id")
    .eq("id",booking.api_quote_id).eq("partner_id",c.partner_id).maybeSingle()
  :{data:null,error:null};
 const routeValid=!quoteError&&quote
  &&arventSavedRouteMatches(d,{
   pickup_location_id:quote.pickup_location_external_id,
   dropoff_location_id:quote.dropoff_location_external_id,
   pickup_date:booking.start_date,return_date:booking.end_date,
   pickup_time:booking.pickup_time,return_time:booking.return_time,
  });
 const verified=booking.partner_currency==="EUR"&&confirmedContract(d,booking.partner_net_price_snapshot)
  &&routeValid===true&&typeof d.sippCode==="string"
  &&d.sippCode.toUpperCase()===quote?.external_group_id;
 // If status is "approved" but supplier price/terms cannot be proved, do
 // NOT return confirmed to the shared booking-status-sync handler.
 const confirmed=status.status==="confirmed"&&verified;
 return {...status,status:status.status==="confirmed"&&!confirmed?"pending":status.status,
  needs_manual_review:status.needs_manual_review||(status.status==="confirmed"&&!confirmed),
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
  ||(input.partner_amount??0)<=0||input.additional_driver)
  throw Error("PARTNER_API_ERROR:ARVENT_PRICING_OR_EXTRAS_UNSUPPORTED");
 if(!input.vehicle_group_id||!input.main_driver?.name||!input.client_email||!input.client_phone)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_INPUT_MISSING");
 const quote=input.provider_quote_data as Record<string,unknown>|null;
 // Ride24 sells ACRISS/SIPP groups like AVIA. Keep the chosen supplier
 // vehicleId only in the private quote payload; never present it as a category.
 const supplierVehicleId=String(quote?.vehicle_id||"");
 if(!quote||quote.provider!=="arvent_kolaycar"
  ||quote.sipp!==input.vehicle_group_id
  ||!/^\d+$/.test(supplierVehicleId)
  ||!Number.isFinite(Number(quote.total_amount))
  ||Number(quote.total_amount)!==input.partner_amount)
  throw Error("PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED");
 // Re-price with a newly issued token. Never use or persist an old reservationToken.
 const live=supplierData(await request(c,searchPath(input)));
 const list=Array.isArray(live)?live:(live&&typeof live==="object"&&Array.isArray((live as any).vehicles)?(live as any).vehicles:[]);
 const current=list.find((x:any)=>String(x?.vehicleId)===supplierVehicleId
  &&String(x?.sippCode||"").toUpperCase()===input.vehicle_group_id
  &&arventOfferMatchesTerms(x,"EUR"));
 if(!current)throw Error("PARTNER_API_ERROR:ARVENT_OFFER_CHANGED");
 const actual=Number(current.totalPrice);
 if(actual!==input.partner_amount)
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
 if(required.some((x:any)=>!x.code||x.price!==0))
  throw Error("PARTNER_API_ERROR:ARVENT_REQUIRED_EXTRAS_UNPRICED");
 const name=String(input.main_driver.name).trim().split(/\s+/);
 const first=name.shift()||"",surname=name.join(" ");
 if(!surname)throw Error("PARTNER_API_ERROR:ARVENT_SURNAME_REQUIRED");
 return arventSavePayload({
  reservationToken:current.reservationToken,reference:input.reservation_code||input.ride24_booking_id,
  customer:{name:first,surname,email:input.client_email,phoneNumber:input.client_phone,birthDay:"",
   note:typeof input.supplier_note==="string"?input.supplier_note:""},
  extras:required.map((x:any)=>({code:x.code,piece:1})),
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
  ||typeof d.sippCode!=="string"||d.sippCode.toUpperCase()!==input.vehicle_group_id
  ||d.currencyCode!=="EUR"||d.depositPrice!==0
  ||d.depositCreditCardRequired!==false||d.totalKMLimit!==0;
 const routeMismatch=!arventSavedRouteMatches(d,input);
 return {...status,
  // Do not leak "confirmed" into generic handlers if money/terms mismatch.
  status:status.status==="confirmed"&&(priceMismatch||termsMismatch||routeMismatch)?"pending":status.status,
  needs_manual_review:status.needs_manual_review||priceMismatch||termsMismatch||routeMismatch,
  provider_payload:statusEvidence(d),
  price_mismatch:priceMismatch,terms_mismatch:termsMismatch,route_mismatch:routeMismatch,
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
