import { arventLicenseEligible } from "./arvent-driver-eligibility.mjs";
import { partnerApiRequest, sanitizePartnerPayload, type PartnerApiCredentials, type ApiLocation, type ApiVehicleGroup } from "./partner-api.ts";
import { serviceClient } from "./ride24-security.ts";
import { rentalDuration } from "./rental-duration.ts";
import { arventSelectedExtrasQuote,arventReceiptExtrasMatch } from "./arvent-extras-pricing.mjs";
import {
 ARVENT_ORIGIN, ARVENT_PATHS, arventDate, arventQuery, supplierData,
 arventLocationRows, arventGroupRows, arventOfferRows, arventCatalogRows, arventOfferExtrasRows, arventAssertVehicleOnlyExtrasSafe,
 arventOneWayFee, arventTermsKey, arventInsuranceIncluded, arventOfferMatchesTerms, arventReservationStatus, arventSavePayload, arventSavedRouteMatches,
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
 extra_selections?:Array<{billing?:string;code:string;quantity:number;total_cents:number;required?:boolean}>;
 driver_code?:string;
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
 if(rentalDuration(input.pickup_date,input.return_date,input.pickup_time||"",input.return_time||"").fullDays<3 ||
    !arventLeadTimeAllowed(input.pickup_date,input.pickup_time) ||
    (input.pickup_location_id!==input.dropoff_location_id && Deno.env.get("ARVENT_ONE_WAY_CERTIFIED")!=="true"))return [];
 const response=await request(c,searchPath(input));
 return arventOfferRows(response,{...input,currency:"EUR"}) as ApiVehicleGroup[];
}
// Read-only offer-specific extras preview. This verifies the same SIPP, private
// supplier vehicle id, exact EUR rental price, full-insurance terms and route
// as the customer's selected Ride24 quote BEFORE requesting GET /extras.
// A new ephemeral reservationToken never leaves this server function.
export async function arventReadOfferExtras(c:PartnerApiCredentials,input:SearchInput,
 quote:{vehicle_id:string;sipp:string;total_amount:number;terms_key?:string;one_way_fee?:number}):Promise<
 {status:"none"|"present";items:ReturnType<typeof arventOfferExtrasRows>;billed_days:number|null}> {
 const vehicleId=String(quote?.vehicle_id||"");
 const sipp=String(quote?.sipp||"").toUpperCase();
 const amount=Number(quote?.total_amount);
 if(!/^[1-9][0-9]*$/.test(vehicleId)||!/^[A-Z]{4}$/.test(sipp)
    ||!Number.isFinite(amount)||amount<=0)throw Error("PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED");
 const live=supplierData(await request(c,searchPath(input)));
 const vehicles=Array.isArray(live)?live:(live&&typeof live==="object"
  &&Array.isArray((live as any).vehicles)?(live as any).vehicles:[]);
 const vehicle=vehicles.find((x:any)=>(String(x?.vehicleId)===vehicleId || (!!quote.terms_key && arventTermsKey(x)===quote.terms_key))
  && (!quote.terms_key || arventTermsKey(x)===quote.terms_key)
  && arventOneWayFee(x,input)===(quote.one_way_fee??0)
  &&String(x?.sippCode||"").toUpperCase()===sipp
  &&arventOfferMatchesTerms(x,"EUR")&&x.totalPrice===amount);
 if(!vehicle)throw Error("PARTNER_API_ERROR:ARVENT_OFFER_CHANGED");
 const data=supplierData(await request(c,ARVENT_PATHS.extras+"?"+arventQuery({
  reservationToken:vehicle.reservationToken,languageCode:"EN"})));
 if(!data||typeof data!=="object")throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_SHAPE");
 const priced=(data as any).vehicle;
 if(!priced||String(priced.vehicleId)!==String(vehicle.vehicleId)
  ||arventTermsKey(priced)!==arventTermsKey(vehicle)||arventOneWayFee(priced,input)!==arventOneWayFee(vehicle,input)
  ||String(priced.sippCode||"").toUpperCase()!==sipp
  ||!arventOfferMatchesTerms(priced,"EUR")
  ||priced.totalPrice!==amount
  ||priced.reservationToken!==vehicle.reservationToken
  ||!arventSavedRouteMatches({
   pickupLocationId:priced.pickupLocationId,returnLocationId:priced.returnLocationId,
   pickupDate:priced.pickupDateTime,returnDate:priced.returnDateTime,
  },input))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED");
 // The supplier must explicitly state whether each offer-bound
 // service is mandatory. Never treat a missing flag as "optional" and
 // accidentally show a total that excludes a required charge.
 const rawExtras=(data as any).extras;
 if(Array.isArray(rawExtras)&&rawExtras.some((x:any)=>typeof x?.isRequired!=="boolean"))
   throw Error("PARTNER_API_ERROR:ARVENT_REQUIRED_EXTRAS_UNVERIFIED");
 // Mandatory payable extras are totalled by the certified Arvent-only
 // booking-options engine, rather than suppressed in the read-only lookup.
 const items=arventOfferExtrasRows(rawExtras);
 const sourceDays=Number(vehicle.rentalDuration);
 const pricedDays=Number(priced.rentalDuration);
 const validDays=(x:number)=>Number.isInteger(x)&&x>=1&&x<=366;
 if(validDays(sourceDays)&&validDays(pricedDays)&&sourceDays!==pricedDays)
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED");
 const billedDays=validDays(pricedDays)?pricedDays:validDays(sourceDays)?sourceDays:null;
 return {status:items.length?"present":"none",items,billed_days:billedDays};
}

async function bookingContextFor(c:PartnerApiCredentials,reference:string,bookingId?:string):Promise<{
 id:string;reservation_code:string|null;client_email:string;partner_currency:unknown;partner_net_price_snapshot:unknown;
 api_quote_id:string|null;start_date:string;end_date:string;pickup_time:string;return_time:string;
}> {
 const admin=serviceClient();
 const context=admin.from("bookings").select("id,reservation_code,client_email,partner_currency,partner_net_price_snapshot,api_quote_id,start_date,end_date,pickup_time,return_time")
  .eq("partner_id",c.partner_id);
 const {data,error}=await (bookingId?context.eq("id",bookingId):context.eq("api_booking_reference",reference)).maybeSingle();
 if(error||typeof data?.client_email!=="string"||!data.client_email)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_EMAIL_NOT_FOUND");
 return data;
}
async function tokenDigest(token:string) {
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
async function dispatchEvidence(c:PartnerApiCredentials,id:string) {
 const {data,error}=await serviceClient().from("arvent_dispatch_evidence")
   .select("agency_reference,token_digest,sipp,one_way_fee,extras").eq("booking_id",id).eq("partner_id",c.partner_id).maybeSingle();
 if(error)throw Error("PARTNER_API_ERROR:ARVENT_DISPATCH_EVIDENCE_UNAVAILABLE");
 return data;
}
async function receiptTerms(row:Record<string,unknown>,sipp:unknown,evidence:any) {
 if(!sippConsistent(row,sipp))return false;
 const suppliedInsurance=row.excess!=null || row.rentalConditions!=null;
 if(suppliedInsurance && !arventInsuranceIncluded(row))return false;
 if(!evidence)return Boolean(row.sippCode && suppliedInsurance);
 if(evidence.sipp!==sipp || evidence.agency_reference!==row.agencyReservationReference ||
    Number(evidence.one_way_fee)!==(row.oneWayFee??0))return false;
 if(typeof row.reservationTokenText==="string")
   return (await tokenDigest(row.reservationTokenText))===evidence.token_digest;
 return Boolean(row.sippCode && suppliedInsurance);
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
function confirmedContract(d:Record<string,unknown>,expectedPrice:unknown,extrasCents:number,oneWayFee:number):boolean {
 const wanted=Number(expectedPrice);
 return Number.isFinite(wanted)&&wanted>0
  &&typeof d.totalPrice==="number"&&Number.isFinite(d.totalPrice)
  &&d.totalPrice===wanted
  &&d.currencyCode==="EUR"&&d.depositPrice===0
  &&d.depositCreditCardRequired===false&&d.totalKMLimit===0
  &&(d.paidAmount===undefined || d.paidAmount===0)
  &&(oneWayFee===0 || d.oneWayFeePayToDelivery===true)
  &&(extrasCents===0 || d.extraPricePayToDelivery===true);
}
export async function arventBookingStatus(c:PartnerApiCredentials,reference:string,bookingId?:string):Promise<Record<string,unknown>> {
 const booking=await bookingContextFor(c,reference,bookingId);
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
 const evidence=await dispatchEvidence(c,booking.id);
 const expectedExtras=evidence?.extras??quote?.raw_response?.ride24_options?.arvent_extra?.selected??[];
 const extrasVerified=arventReceiptExtrasMatch(d.reservationExtras??d.extras,expectedExtras);
 // Supplier reservationNumber and original customer email identify a record.
 // If Arvent also echoes the Ride24 agency reference it must match exactly,
 // including on cancellation paths (which can trigger a Stripe refund).
 const supplierAgency=typeof d.agencyReservationReference==="string"
  ?d.agencyReservationReference.trim():null;
 const agencyMismatch=!!supplierAgency&&(!booking.reservation_code
  ||supplierAgency!==booking.reservation_code);
 const verified=await receiptTerms(d,quote?.external_group_id,evidence)&&booking.partner_currency==="EUR"&&confirmedContract(d,booking.partner_net_price_snapshot,quote?.raw_response?.ride24_options?.arvent_extra?.extras_cents??0,Number(evidence?.one_way_fee??d.oneWayFee??0))
  &&routeValid===true&&extrasVerified&&!agencyMismatch;
 // If status is "approved" but supplier price/terms cannot be proved, do
 // NOT return confirmed to the shared booking-status-sync handler.
 const confirmed=status.status==="confirmed"&&verified;
 return {...status,status:status.supplier_status_type===6&&verified?"rejected":status.status==="confirmed"&&!confirmed?"pending":status.status,
  // A cancelled booking can trigger an irreversible customer refund.
  // Verify its EUR amount, route, SIPP, deposit, agency reference and extras
  // with the same rigor as an approved booking before automated processing.
  definitive_rejection:status.supplier_status_type===6&&verified,
  needs_manual_review:(status.needs_manual_review && status.supplier_status_type!==6)||agencyMismatch
    ||!verified,
  // Not returned is "unknown", never misreported as a verified match.
  agency_reference_verified:supplierAgency?(!agencyMismatch):null,
  // Money, EUR, zero deposit/card hold, unlimited km, route, times and SIPP
  // match the paid booking (independent of the supplier status code).
  terms_verified:verified===true,
  extras_verified:extrasVerified===true,
  provider_payload:statusEvidence(d)};
}
// Recover a single supplier record using the persisted dispatch payload.
export async function arventLookupByAgencyReference(c:PartnerApiCredentials,input:BookingInput) {
 const reference=input.reservation_code || input.ride24_booking_id;
 const surname=input.main_driver?.name?.trim().split(/\s+/).slice(1).join(" ");
 if(!reference || !surname || !input.client_email)return null;
 const response=supplierData(await request(c,ARVENT_PATHS.booking_status+"?"+arventQuery({
  agencyReservationReference:reference,customerSurname:surname,languageType:"EN"})));
 const rows=Array.isArray(response)?response:response?[response]:[];
 if(!rows.length)return null;
 const manual={status:"pending",needs_manual_review:true};
 if(rows.length!==1)return manual;
 const candidate=rows[0];
 if(candidate?.agencyReservationReference!==reference ||
    typeof candidate?.reservationNumber!=="string" || !candidate.reservationNumber.trim())return manual;
 // Re-read by supplier number and the original email before attaching any reference.
 const detail=await request(c,ARVENT_PATHS.booking_status+"?"+arventQuery({
  reservationNumber:candidate.reservationNumber,customerEmail:input.client_email,languageType:"EN"}));
 const row=supplierData(detail) as Record<string,unknown>;
 const evidence=await dispatchEvidence(c,input.ride24_booking_id);
 if(row?.reservationNumber!==candidate.reservationNumber || row?.agencyReservationReference!==reference ||
    !await receiptTerms(row,input.vehicle_group_id,evidence) || !confirmedContract(row,input.partner_amount,Math.round(Number(input.extras_amount??0)*100),Number(evidence?.one_way_fee??row.oneWayFee??0)) || !arventSavedRouteMatches(row,input) ||

    !arventReceiptExtrasMatch(row.reservationExtras??row.extras,evidence?.extras??input.extra_selections??[]))return manual;
 // Only polling may authorize a voucher or refund. Keep the verified reference in the workflow.
 return {status:"pending",booking_reference:row.reservationNumber,needs_manual_review:false};
}
function allowSupplierMutation():void {
 // Different from api_enabled: explicit server-side provider certification gate.
 if(Deno.env.get("ARVENT_KOLAYCAR_WRITE_ALLOWED")!=="true")
  throw Error("PARTNER_API_ERROR:ARVENT_WRITES_NOT_CERTIFIED");
}
async function prepareReservation(c:PartnerApiCredentials,input:BookingInput){
 if(input.pickup_location_id!==input.dropoff_location_id && Deno.env.get("ARVENT_ONE_WAY_CERTIFIED")!=="true")
  throw Error("PARTNER_API_ERROR:ARVENT_ONE_WAY_PAYMENT_UNVERIFIED");
 if(Number(input.partner_discount_percent??0)!==0||!Number.isFinite(input.partner_amount)
  ||(input.partner_amount??0)<=0)
  throw Error("PARTNER_API_ERROR:ARVENT_PRICING_OR_EXTRAS_UNSUPPORTED");
 const accepted=Array.isArray(input.extra_selections)?input.extra_selections:[];
 // Supplier confirmed code 2 is IMM insurance, not additional driver.
 if(accepted.some(x=>String(x.code)==="2" && !(x.required && x.total_cents===0)))
  throw Error("PARTNER_API_ERROR:ARVENT_IMM_NOT_ADDITIONAL_DRIVER");
 if(accepted.length && input.extras_pricing_certified!==true)
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_NOT_CERTIFIED");
 // An additional driver is a certified extra only. Partner staff verify
 // their licence when the vehicle is delivered; no secondary-driver PII.
 if(input.additional_driver)
  throw Error("PARTNER_API_ERROR:ARVENT_SECONDARY_DRIVER_DATA_NOT_REQUIRED");
 if(!input.vehicle_group_id||!input.main_driver?.name||!input.client_email||!input.client_phone)
  throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_INPUT_MISSING");
 if(!arventLeadTimeAllowed(input.pickup_date,input.pickup_time))
  throw Error("PARTNER_API_ERROR:ARVENT_MIN_LEAD_TIME");
 if(rentalDuration(input.pickup_date,input.return_date,input.pickup_time||"",input.return_time||"").fullDays<3)
  throw Error("PARTNER_API_ERROR:ARVENT_MIN_RENTAL_DAYS");
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
 const current=list.find((x:any)=>(String(x?.vehicleId)===supplierVehicleId || (!!quote.terms_key && arventTermsKey(x)===quote.terms_key))
  && (!quote.terms_key || arventTermsKey(x)===quote.terms_key)
  && x.totalPrice===Number(input.rental_amount??input.partner_amount)
  && arventOneWayFee(x,input)===(quote.one_way_fee??0)
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
 if(!pricedVehicle||String(pricedVehicle.vehicleId)!==String(current.vehicleId)
  ||arventTermsKey(pricedVehicle)!==arventTermsKey(current)||arventOneWayFee(pricedVehicle,input)!==arventOneWayFee(current,input)
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
    ?arventSelectedExtrasQuote({items:arventOfferExtrasRows(extras),driverCode:input.driver_code,
       selections:accepted.filter(x=>!x.required).map(x=>({id:x.code,quantity:x.quantity})),
       additionalDriverId:null,
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
 // No additional-driver identity or licence is required online by Arvent.
 // The exact fee and selected product code were checked before reaching this point.
 const name=String(input.main_driver.name).trim().split(/\s+/);
 const first=name.shift()||"",surname=name.join(" ");
 if(!surname)throw Error("PARTNER_API_ERROR:ARVENT_SURNAME_REQUIRED");
 return arventSavePayload({
  reservationToken:current.reservationToken,reference:input.reservation_code||input.ride24_booking_id,
  customer:{name:first,surname,email:input.client_email,phoneNumber:input.client_phone,birthDay:"",
   note:(typeof input.supplier_note==="string"?input.supplier_note:"").slice(0,250)},
  extras:extrasQuote.selected,driverCode:input.driver_code,
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
 } catch(error) {
  // All supplier calls above are reads. No SaveReservation was attempted.
  const reason=error instanceof Error ? /^(?:PARTNER_API_ERROR:)?(ARVENT_[A-Z_]+)$/.exec(error.message)?.[1] : null;
  throw Error(reason?"ARVENT_FAILED_BEFORE_SAVE:"+reason:"ARVENT_FAILED_BEFORE_SAVE");
 }
 // This call creates a real supplier booking; only reachable after external certification.
 const {error}=await serviceClient().from("arvent_dispatch_evidence").insert({
  booking_id:input.ride24_booking_id,partner_id:c.partner_id,agency_reference:payload.agencyReservationReference,
  sipp:input.vehicle_group_id,token_digest:await tokenDigest(payload.reservationToken),
  one_way_fee:(input.provider_quote_data as Record<string,unknown>).one_way_fee??0,
  extras:payload.extras.map((x:{code:string;piece:number})=>({code:x.code,quantity:x.piece})),
 });
 // A prior claimant may already have sent its POST. Only GET may reconcile it.
 if(error)throw Error("PARTNER_API_ERROR:ARVENT_DISPATCH_CLAIM_UNAVAILABLE");
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
 const expectedExtras=payload.extras.map((x:{code:string;piece:number})=>({code:x.code,quantity:x.piece}));
 const extrasMismatch=!arventReceiptExtrasMatch(d.reservationExtras??d.extras,expectedExtras);
 return {...status,
  // Do not leak "confirmed" into generic handlers without full verification.
  status:status.status==="confirmed"?"pending":status.status,
  needs_manual_review:status.needs_manual_review||priceMismatch||termsMismatch||routeMismatch||extrasMismatch,
  provider_payload:statusEvidence(d),
  price_mismatch:priceMismatch,terms_mismatch:termsMismatch,route_mismatch:routeMismatch,
  extras_mismatch:extrasMismatch,
 };
}
export async function arventCancelBooking(c:PartnerApiCredentials,reference:string,body:Record<string,unknown>={},bookingId?:string):Promise<Record<string,unknown>> {
 allowSupplierMutation();
 const booking=await bookingContextFor(c,reference,bookingId);
 const email=booking.client_email;
 // All cancellation entry points share one durable claim per Ride24 booking.
 // A previous attempt may have reached Arvent even if its HTTP response was lost.
 const {error}=await serviceClient().from("arvent_cancel_attempts").insert({booking_id:booking.id});
 if(error?.code==="23505")return arventBookingStatus(c,reference,bookingId);
 if(error)throw Error("PARTNER_API_ERROR:ARVENT_CANCEL_CLAIM_FAILED");
 // supplierData() throws on a business failure, so a rejected cancellation is
 // never read back as success. The live response shape of a successful
 // cancellation is not documented, so the authoritative proof is the
 // supplier's own reservation status (3=cancelled) read back by GET.
 supplierData(await request(c,ARVENT_PATHS.booking_cancel+"?"+arventQuery({
  reservationNumber:reference,customerEmail:email,cancelNote:typeof body.reason==="string"?body.reason:"Ride24 customer cancellation",
  languageCode:"EN",cancelReasonId:0,
 }),{method:"POST"}));
 const confirmed=await arventBookingStatus(c,reference,bookingId);
 return {...confirmed,status:confirmed.status==="cancelled"?"cancelled":"pending",
  needs_manual_review:confirmed.status!=="cancelled"||confirmed.needs_manual_review===true};
}
