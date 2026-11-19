import {ride24ClassFromAcriss,canonicalApiLocation} from "./provider-normalization.mjs";
// Arvent/kolayCAR pure contract: no network, credentials or supplier mutations.
// Partner Postman Collection v2.1, received 2026-11-17.
export const ARVENT_PROVIDER="arvent_kolaycar";
export const ARVENT_ORIGIN="https://racapi.arventcarrental.com";
export const ARVENT_INITIAL_AIRPORT_IATAS=Object.freeze(["SAW","IST","SZF","ASR","DLM","AYT","ADB","EDO","AOE","TZX"]);
const allowedAirports=new Set(ARVENT_INITIAL_AIRPORT_IATAS);
// Normalized Ride24 airport labels, independent of supplier spelling/typos.
// Only map airports that are actually returned by the live provider API.
export const ARVENT_AIRPORT_DISPLAY=Object.freeze({
 SAW:{city:"Istanbul",name:"Istanbul Sabiha Gökçen Airport"},
 IST:{city:"Istanbul",name:"Istanbul Airport"},
 SZF:{city:"Samsun",name:"Samsun Çarşamba Airport"},
 ASR:{city:"Kayseri",name:"Kayseri Erkilet Airport"},
 DLM:{city:"Dalaman",name:"Dalaman Airport"},
 AYT:{city:"Antalya",name:"Antalya Airport"},
 ADB:{city:"Izmir",name:"Izmir Adnan Menderes Airport"},
 TZX:{city:"Trabzon",name:"Trabzon Airport"},
});
export const ARVENT_PATHS=Object.freeze({
 auth:"/users/authenticate",locations:"/locations",cities:"/locations/cities",
 countries:"/locations/countries",groups:"/vehicles/list",search:"/vehicles",
 extras_catalog:"/extras/list",extras:"/extras",booking_create:"/reservations/save",
 booking_status:"/reservations",booking_cancel:"/reservations/cancel"
});
const record=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const num=v=>typeof v==="number"&&Number.isFinite(v)?v:null;
const str=(v,max=250)=>(typeof v==="string"||typeof v==="number")?String(v).trim().slice(0,max):"";
const id=v=>/^\d+$/.test(str(v))&&Number(v)>0?String(v):null;
export function supplierData(e) {
 if(!record(e)||e.success!==true||(e.resultCode!==undefined&&e.resultCode!==0))
  throw Error("PARTNER_API_ERROR:ARVENT_BUSINESS_FAILURE");
 return e.data;
}
export function arventDate(v) {
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v,12));
 if(!m)throw Error("PARTNER_API_ERROR:ARVENT_DATE_INVALID");
 const [y,mo,d]=m.slice(1).map(Number);
 const t=new Date(Date.UTC(y,mo-1,d));
 if(t.getUTCFullYear()!==y||t.getUTCMonth()!==mo-1||t.getUTCDate()!==d)
  throw Error("PARTNER_API_ERROR:ARVENT_DATE_INVALID");
 return [m[3],m[2],m[1]].join(".");
}
export function arventQuery(p) {
 const q=new URLSearchParams();
 for(const [k,v] of Object.entries(p))if(v!==null&&v!==undefined&&v!=="")q.set(k,String(v));
 return q.toString();
}
export function arventLocationRows(e,cities=[]) {
 const data=supplierData(e);
 if(!Array.isArray(data))throw Error("PARTNER_API_ERROR:ARVENT_LOCATIONS_SHAPE");
 const cn=new Map(Array.isArray(cities)?cities.filter(record).map(c=>[String(c.CityId??c.cityId),str(c.CityName??c.cityName)]):[]);
 return data.slice(0,10000).filter(record).flatMap(x=>{
  const k=id(x.locationId),name=str(x.locationName);
  if(!k||!name||str(x.countryCode).toUpperCase()!=="TR"||x.isAirport!==true)return [];
  // The first rollout is limited to the ten agreed airports. An unknown
  // IATA/location code cannot silently grant a new pickup point.
  // Real account 2026-11-18: ADB is "(ADB)" and TZX has a blank
  // iataCode but an explicit terminal "(TZX)" in locationName.
  // Never infer a code from city/region (or create unreturned airports).
  const iata=str(x.iataCode,12).toUpperCase().replace(/^\(([A-Z]{3})\)$/,"$1");
  const locationCode=str(x.locationCode,12).toUpperCase();
  const nameCode=/\(([A-Z]{3})\)\s*$/.exec(name.toUpperCase())?.[1]||"";
  const airport=allowedAirports.has(iata)?iata
   :allowedAirports.has(locationCode)?locationCode
   :allowedAirports.has(nameCode)?nameCode:null;
  if(!airport)return [];
  const standard=ARVENT_AIRPORT_DISPLAY[airport];
  const city=standard?.city||cn.get(String(x.cityId))||str(x.cityName)||null;
  const normalizedName=standard?.name||name;
  return [canonicalApiLocation({external_id:k,country:"Turkey",region:city||name,city,location_name:normalizedName,
   display_name:normalizedName,iata_code:airport,
   type:"airport",return_only:x.isPickup===false,
   extra_fee:false,extra_fee_amount:null,contact_required:false,active:true})];
 });
}
const sipp=v=>str(v,16).toUpperCase();
const count=v=>{const m=/\d+/.exec(str(v));return m?Number(m[0]):null;};
const image=x=>{
 const v=Array.isArray(x.vehicleImages)?x.vehicleImages[0]?.url:null;
 try{const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password?u.toString().slice(0,2000):null;}
 catch{return null;}
};
// Same A-F taxonomy as AVIA. Supplier vehicleId is NEVER a Ride24
// group ID: it is only a token-bound quote choice for supplier checkout.
const classNames=Object.freeze({
 A:"Economy",B:"Compact",C:"Sedan",D:"SUV",E:"Premium",F:"Van / Family",
});
const normalizedTransmission=code=>["A","B"].includes(code[2])?"Automatic":["M","N"].includes(code[2])?"Manual":null;
function category(x,price,currency,input) {
 const vehicleId=id(x.vehicleId),code=sipp(x.sippCode);
 if(!vehicleId||!/^[A-Z]{4}$/.test(code))return null;
 const seats=count(x.passangerQuantityName);
 // Seat count belongs to a representative supplier model, not to the
 // ACRISS group itself. A given live SIPP has both 5- and 7-seat models.
 // A-F display class must be stable for the SAME SIPP (as in AVIA).
 const ride24Class=ride24ClassFromAcriss(code);
 if(!ride24Class)return null;
 const className=classNames[ride24Class];
 const model=str(x.vehicleName)||null;
 return {external_id:code,class_code:ride24Class,public_price:price,currency,
  // Example model only; the contract guarantees category, never an exact car.
  example_model:model,model:null,
  transmission:normalizedTransmission(code),
  fuel_type:null,seats,bags:count(x.baggageQuantityName),image:image(x),
  description:className+(model?" — "+model+" or similar":" — or similar"),
  features:{provider:ARVENT_PROVIDER,sipp:code,category_name:className,
   representative_model:model,image_is_representative:true,
   air_conditioning:x.isThereAirCondition===true,
   noCreditCard:true,noCardHold:true},
  driver_included:false,seasonal_prices:null,
  location_external_ids:input?[input.pickup_location_id,input.dropoff_location_id].filter(Boolean):null};
}
export function arventGroupRows(e) {
 const data=supplierData(e);
 if(!Array.isArray(data))throw Error("PARTNER_API_ERROR:ARVENT_GROUPS_SHAPE");
 const groups=new Map();
 for(const x of data.slice(0,10000)) {
  if(!record(x))continue;
  const c=category(x,0,"EUR",null);
  if(c&&!groups.has(c.external_id))
   groups.set(c.external_id,{...c,active:true,mileage_limit:null,deposit_amount:0});
 }
 return [...groups.values()];
}
export function arventInsuranceIncluded(x) {
 // Live Arvent returns an array of structured rentalConditions; some API
 // versions serialize that array as JSON text. Do not trust text from an
 // unrelated vehicle description or an undocumented 'fullCredit' flag.
 if(!record(x)||num(x.excess)!==0)return false;
 let conditions=x.rentalConditions;
 if(typeof conditions==="string") {
  try {conditions=JSON.parse(conditions)}catch{return false}
 }
 return Array.isArray(conditions)&&conditions.some(c=>record(c)
   &&str(c.conditionName,200).trim().toLowerCase()==="full insurance");
}
export function arventOfferMatchesTerms(x,currency="EUR") {
 // Fail closed: don't silently rewrite nonzero deposit, required card hold or mileage cap.
 return record(x)&&x.isAvailable===true&&str(x.currencyCode).toUpperCase()===currency.toUpperCase()
  &&arventInsuranceIncluded(x)
  &&num(x.depositPrice)===0&&x.depositCreditCardRequired===false
  &&num(x.totalKMLimit)===0&&num(x.totalPrice)!==null&&x.totalPrice>0
  &&Boolean(str(x.reservationToken,500));
}
export function arventOfferRows(e,input) {
 const payload=supplierData(e);
 const data=Array.isArray(payload)?payload:record(payload)&&Array.isArray(payload.vehicles)?payload.vehicles:null;
 if(!data)throw Error("PARTNER_API_ERROR:ARVENT_OFFERS_SHAPE");
 const currency=str(input.currency||"EUR").toUpperCase();
 const start=Date.parse(input.pickup_date+"T00:00:00Z"),end=Date.parse(input.return_date+"T00:00:00Z");
 const days=Math.ceil((end-start)/86400000);
 if(!(days>0&&days<=366))throw Error("PARTNER_API_ERROR:ARVENT_DATES_INVALID");
 const grouped=new Map();
 for(const x of data.slice(0,10000)) {
  if(!arventOfferMatchesTerms(x,currency))continue;
  const total=x.totalPrice;
  const supplierDays=num(x.rentalDuration);
  const billedDays=supplierDays!==null&&Number.isInteger(supplierDays)&&supplierDays>0&&supplierDays<=366
   ?supplierDays:days;
  const c=category(x,Number((total/billedDays).toFixed(6)),currency,input);
  if(!c)continue;
  const offer={...c,active:true,deposit_amount:0,mileage_limit:null,
   price_is_total:true,public_price_total:total,
   quote_reference:[c.external_id,id(x.vehicleId)].join(":").slice(0,500),
   quote_expires_at:null,
   features:{...c.features,
    min_license_years:num(x.vendorMinimumDrivingLicenseAge),
    minimum_driver_age:num(x.vendorMinimumDriverAge),
    insurance_unverified:false,full_insurance_included:true,insurance_excess_eur:0},
   provider_quote_data:{provider:ARVENT_PROVIDER,
    vehicle_id:id(x.vehicleId),sipp:c.external_id,
    total_amount:total,currency,pickup_location_id:input.pickup_location_id,
    dropoff_location_id:input.dropoff_location_id,quote_requires_live_revalidation:true}
  };
  // One offer per SIPP, cheapest eligible *supplier* vehicle within it.
  // Deterministic tie-break is the numeric supplier vehicleId.
  const previous=grouped.get(c.external_id);
  if(!previous||total<previous.public_price_total
   ||(total===previous.public_price_total
    && Number(id(x.vehicleId))<Number(previous.provider_quote_data.vehicle_id)))
   grouped.set(c.external_id,offer);
 }
 return [...grouped.values()].sort((a,b)=>
  a.class_code.localeCompare(b.class_code)||a.external_id.localeCompare(b.external_id));
}
// Mustafa's 2026-11-18 production status enum supersedes the synthetic
// Postman sample (which had used -4 for cancellation).
// Never infer approval from payment completion or vehicle handover alone.
export const ARVENT_STATUS_LABELS=Object.freeze({
 0:"received",1:"approved",2:"payment_completed",3:"cancelled",
 4:"awaiting_payment",5:"vehicle_handed_over",6:"unapproved",
});
export function arventReservationStatus(e) {
 const d=supplierData(e);
 if(!record(d))throw Error("PARTNER_API_ERROR:ARVENT_BOOKING_SHAPE");
 const reference=str(d.reservationNumber,500)||null,raw=num(d.reservationStatusType);
 const label=Object.hasOwn(ARVENT_STATUS_LABELS,raw)?ARVENT_STATUS_LABELS[raw]:"unknown";
 const status=raw===1?"confirmed":raw===3?"cancelled":"pending";
 return {booking_reference:reference,reference,id:reference,status,
  supplier_status_type:raw,supplier_status_label:label,
  // 0 is a real "received/awaiting approval" state, not an error.
  // Keep it pending so the durable Stripe-paid workflow can poll status 1.
  // Unknown/ambiguous statuses require manual review; no premature voucher.
  needs_manual_review:raw!==0&&raw!==1&&raw!==3,
  definitive_rejection:false};
}
export function arventDateOfBirth(value) {
 // A missing date must stay missing; do not derive DOB from driver's age.
 if(value===undefined||value===null||value==="")return "";
 const raw=str(value,20);
 if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return arventDate(raw);
 const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
 if(!m)throw Error("PARTNER_API_ERROR:ARVENT_BIRTHDAY_INVALID");
 const [day,month,year]=m.slice(1).map(Number);
 const date=new Date(Date.UTC(year,month-1,day));
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)
  throw Error("PARTNER_API_ERROR:ARVENT_BIRTHDAY_INVALID");
 return raw;
}
export function arventSavePayload({reservationToken,reference,customer,extras=[]}) {
 if(!/^[0-9a-f-]{36}$/i.test(str(reservationToken,200)))
  throw Error("PARTNER_API_ERROR:ARVENT_TOKEN_REQUIRED");
 if(!str(reference,150)||!record(customer)||!str(customer.name)||!str(customer.surname)
    ||!str(customer.email)||!str(customer.phoneNumber))
  throw Error("PARTNER_API_ERROR:ARVENT_CUSTOMER_INCOMPLETE");
 if(!Array.isArray(extras)||extras.some(e=>!record(e)||!str(e.code,200)||!Number.isInteger(e.piece)||e.piece<1))
  throw Error("PARTNER_API_ERROR:ARVENT_EXTRAS_INVALID");
 return {reservationToken,languageCode:"EN",
  customer:{name:str(customer.name),surname:str(customer.surname),phoneNumber:str(customer.phoneNumber,80),
   email:str(customer.email,250),birthDay:arventDateOfBirth(customer.birthDay),personalNumber:"",address:"",note:""},
  pricing:{paidAmount:0,extraAmount:0,specialDailyPrice:-1,specialOneWayFee:-1},
  payment:{paymentType:3,extraPricePayToDelivery:true,oneWayFeePayToDelivery:true},
  extras:extras.map(e=>({code:e.code,piece:e.piece})),
  sendReservationMail:false,agencyReservationReference:str(reference,150),
  flightNumberArrival:"",flightNumberDeparture:"",departureInfo:"",
  fullCredit:false,creditType:0,contactPermission:false};
}

// A supplier's "Approved" status and price do not certify the purchased route.
// Refuse automatic confirmation unless the original locations, dates and
// pickup/return clock times are exactly preserved. No implicit timezone shift.
export function arventSavedRouteMatches(saved, expected) {
 if(!record(saved)||!record(expected))return false;
 const idString=v=>/^[1-9]\d*$/.test(str(v,30))?String(Number(v)):null;
 const dateTime=value=>{
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(str(value,50));
  if(!match)return null;
  const hh=Number(match[2]),mm=Number(match[3]);
  if(hh>23||mm>59)return null;
  try { arventDate(match[1]); } catch {return null;}
  return {date:match[1],time:match[2]+":"+match[3]};
 };
 const start=dateTime(saved.pickupDate),end=dateTime(saved.returnDate);
 const startTime=/^(\d{2}):(\d{2})/.exec(str(expected.pickup_time,16));
 const endTime=/^(\d{2}):(\d{2})/.exec(str(expected.return_time,16));
 return Boolean(start&&end&&startTime&&endTime
   &&idString(expected.pickup_location_id)&&idString(expected.dropoff_location_id)
   &&idString(saved.pickupLocationId)===idString(expected.pickup_location_id)
   &&idString(saved.returnLocationId)===idString(expected.dropoff_location_id)
   &&start.date===str(expected.pickup_date,10)
   &&end.date===str(expected.return_date,10)
   &&start.time===startTime[1]+":"+startTime[2]
   &&end.time===endTime[1]+":"+endTime[2]);
}
