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
 vehicle_group_id:string|null;main_driver?:{name?:string|null;age?:number|null}|null;
 client_email?:string|null;client_phone?:string|null;
 partner_discount_percent?:number|null;partner_amount?:number|null;
 provider_quote_data?:unknown;
 additional_driver?:{name?:string|null;age?:number|null}|null;
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
   if(attempt===0&&error instanceof Error&&error.message==="PARTNER_API_ERROR:HTTP:401"){
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
 const time=(v:string|null|undefined)=>/^\d{2}:\d{2}$/.test(v||"")?v:"10:00";
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
 client_email:string;partner_currency:unknown;partner_net_price_snapshot:unknown;
 api_quote_id:string|null;start_date:string;end_date:string;pickup_time:string;return_time:string;
}> {
 const admin=serviceClient();
 const {data,error}=await admin.from("bookings").select("client_email,partner_currency,partner_net_price_snapshot,api_quote_id,start_date,end_date,pickup_time,return_time")
  .eq("partner_id",c.partner_id).eq("api_booking_reference",reference).limit(1).maybeSingle();
 if(error||typeof data?.client_email!=="string"||!data.client_email)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_EMAIL_NOT_FOUND");
 return data;
}
function confirmedContract(d:Record<string,unknown>,expectedPrice:unknown):boolean {
 const wanted=Number(expectedPrice);
 return Number.isFinite(wanted)&&wanted>0
  &&typeof d.totalPrice==="number"&&Number.isFinite(d.totalPrice)
  &&Math.abs(d.totalPrice-wanted)<=0.01
  &&d.currencyCode==="EUR"&&d.depositPrice===0
  &&d.depositCreditCardRequired===false&&d.totalKMLimit===0;
}
export async function arventBookingStatus(c:PartnerApiCredentials,reference:string):Promise<Record<string,unknown>> {
 const booking=await bookingContextFor(c,reference);
 const response=await request(c,ARVENT_PATHS.booking_status+"?"+arventQuery({
  reservationNumber:reference,customerEmail:booking.client_email}));
 const status=arventReservationStatus(response),d=supplierData(response) as Record<string,unknown>;
 const admin=serviceClient();
 const {data:quote,error:quoteError}=booking.api_quote_id
  ?await admin.from("api_quotes")
    .select("pickup_location_external_id,dropoff_location_external_id")
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
  &&routeValid===true;
 // If status is "approved" but supplier price/terms cannot be proved, do
 // NOT return confirmed to the shared booking-status-sync handler.
 const confirmed=status.status==="confirmed"&&verified;
 return {...status,status:status.status==="confirmed"&&!confirmed?"pending":status.status,
  needs_manual_review:status.needs_manual_review||(status.status==="confirmed"&&!confirmed),
  provider_payload:sanitizePartnerPayload(d,12000)};
}
// Read-only reconciliation using Ride24's reference and the original email.
// agencyReservationReference is not a unique/idempotent create guarantee.
// A lookup failure or empty result MUST NOT trigger a second supplier POST.
export async function arventLookupByAgencyReference(c:PartnerApiCredentials,reference:string,email:string):Promise<Record<string,unknown>|null> {
 if(!/^[A-Za-z0-9_-]{1,150}$/.test(reference)||!/^\S+@\S+\.\S+$/.test(email))
  throw Error("PARTNER_API_ERROR:ARVENT_LOOKUP_INVALID");
 const response=await request(c,ARVENT_PATHS.booking_status+"?"+arventQuery({
  agencyReservationReference:reference,customerEmail:email,
 }));
 const data=supplierData(response);
 if(data===null)return null;
 if(!data||typeof data!=="object"||Array.isArray(data))
  throw Error("PARTNER_API_ERROR:ARVENT_LOOKUP_UNCERTAIN");
 const record=data as Record<string,unknown>;
 // Confirm that the supplier actually returned this exact agency reference.
 if(record.agencyReservationReference!==reference)
  throw Error("PARTNER_API_ERROR:ARVENT_REFERENCE_MISMATCH");
 return {...arventReservationStatus(response),
  provider_payload:sanitizePartnerPayload(data,12000)};
}
function allowSupplierMutation():void {
 // Different from api_enabled: explicit server-side provider certification gate.
 if(Deno.env.get("ARVENT_KOLAYCAR_WRITE_ALLOWED")!=="true")
  throw Error("PARTNER_API_ERROR:ARVENT_WRITES_NOT_CERTIFIED");
}
export async function arventCreateBooking(c:PartnerApiCredentials,input:BookingInput):Promise<Record<string,unknown>>{
 allowSupplierMutation();
 if(Number(input.partner_discount_percent??0)!==0||!Number.isFinite(input.partner_amount)
  ||(input.partner_amount??0)<=0||input.additional_driver)
  throw Error("PARTNER_API_ERROR:ARVENT_PRICING_OR_EXTRAS_UNSUPPORTED");
 if(!input.vehicle_group_id||!input.main_driver?.name||!input.client_email||!input.client_phone)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_INPUT_MISSING");
 const quote=input.provider_quote_data as Record<string,unknown>|null;
 if(!quote||quote.provider!=="arvent_kolaycar"||quote.vehicle_id!==input.vehicle_group_id)
  throw Error("PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED");
 // Re-price with a newly issued token. Never use or persist an old reservationToken.
 const live=supplierData(await request(c,searchPath(input)));
 const list=Array.isArray(live)?live:(live&&typeof live==="object"&&Array.isArray((live as any).vehicles)?(live as any).vehicles:[]);
 const current=list.find((x:any)=>String(x?.vehicleId)===input.vehicle_group_id&&arventOfferMatchesTerms(x,"EUR"));
 if(!current)throw Error("PARTNER_API_ERROR:ARVENT_OFFER_CHANGED");
 const actual=Number(current.totalPrice);
 if(Math.abs(actual-Number(input.partner_amount))>0.01)
  throw Error("PARTNER_API_ERROR:ARVENT_PRICE_CHANGED");
 const extraData=supplierData(await request(c,ARVENT_PATHS.extras+"?"+arventQuery({
  reservationToken:current.reservationToken,languageCode:"EN"})));
 if(!extraData||typeof extraData!=="object"||!Array.isArray((extraData as any).extras))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_SHAPE");
 const required=(extraData as any).extras.filter((x:any)=>x&&x.isRequired===true);
 if(required.some((x:any)=>!x.code||Number(x.price||0)!==0))
  throw Error("PARTNER_API_ERROR:ARVENT_REQUIRED_EXTRAS_UNPRICED");
 const name=String(input.main_driver.name).trim().split(/\s+/);
 const first=name.shift()||"",surname=name.join(" ");
 if(!surname)throw Error("PARTNER_API_ERROR:ARVENT_SURNAME_REQUIRED");
 const payload=arventSavePayload({
  reservationToken:current.reservationToken,reference:input.reservation_code||input.ride24_booking_id,
  customer:{name:first,surname,email:input.client_email,phoneNumber:input.client_phone,birthDay:""},
  extras:required.map((x:any)=>({code:x.code,piece:1})),
 });
 // This call creates a real supplier booking; only reachable after external certification.
 const result=await request(c,ARVENT_PATHS.booking_create,{method:"POST",body:payload});
 const status=arventReservationStatus(result);
 if(!status.booking_reference)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_REFERENCE_MISSING");
 const d=supplierData(result) as Record<string,unknown>;
 const confirmedPrice=typeof d.totalPrice==="number"&&Number.isFinite(d.totalPrice)?d.totalPrice:null;
 const priceMismatch=confirmedPrice===null||Math.abs(confirmedPrice-Number(input.partner_amount))>0.01;
 // A confirmed status alone does not prove that the booking preserves the
 // no-deposit/no-card/unlimited-km contract and EUR payable amount.
 const termsMismatch=d.currencyCode!=="EUR"||d.depositPrice!==0
  ||d.depositCreditCardRequired!==false||d.totalKMLimit!==0;
 const routeMismatch=!arventSavedRouteMatches(d,input);
 return {...status,
  // Do not leak "confirmed" into generic handlers if money/terms mismatch.
  status:status.status==="confirmed"&&(priceMismatch||termsMismatch||routeMismatch)?"pending":status.status,
  needs_manual_review:status.needs_manual_review||priceMismatch||termsMismatch||routeMismatch,
  provider_payload:sanitizePartnerPayload(d,12000),
  price_mismatch:priceMismatch,terms_mismatch:termsMismatch,route_mismatch:routeMismatch,
 };
}
export async function arventCancelBooking(c:PartnerApiCredentials,reference:string,body:Record<string,unknown>={}):Promise<Record<string,unknown>> {
 allowSupplierMutation();
 const email=(await bookingContextFor(c,reference)).client_email;
 const response=await request(c,ARVENT_PATHS.booking_cancel+"?"+arventQuery({
  reservationNumber:reference,customerEmail:email,cancelNote:typeof body.reason==="string"?body.reason:"Ride24 customer cancellation",
  languageCode:"EN",cancelReasonId:0,
 }),{method:"POST"});
 const parsed=arventReservationStatus(response);
 return {...parsed,status:parsed.status==="cancelled"?"cancelled":"pending",
  provider_payload:sanitizePartnerPayload(supplierData(response),12000)};
}
