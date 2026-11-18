// Arvent/kolayCAR pure contract: no network, credentials or supplier mutations.
// Partner Postman Collection v2.1, received 2026-11-17.
export const ARVENT_PROVIDER="arvent_kolaycar";
export const ARVENT_ORIGIN="https://racapi.arventcarrental.com";
export const ARVENT_INITIAL_AIRPORT_IATAS=Object.freeze(["SAW","IST","SZF","ASR","DLM","AYT","ADB","EDO","AOE","TZX"]);
const allowedAirports=new Set(ARVENT_INITIAL_AIRPORT_IATAS);
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
  const iata=str(x.iataCode,12).toUpperCase();
  const locationCode=str(x.locationCode,12).toUpperCase();
  const airport=allowedAirports.has(iata)?iata:allowedAirports.has(locationCode)?locationCode:null;
  if(!airport)return [];
  const city=cn.get(String(x.cityId))||str(x.cityName)||null;
  return [{external_id:k,country:"Turkey",region:city||name,city,location_name:name,
   display_name:name,iata_code:airport,
   type:x.isAirport===true?"airport":x.isOffice===true?"office":"city",
   return_only:x.isPickup===false,extra_fee:false,extra_fee_amount:null,
   contact_required:false,active:true}];
 });
}
const sipp=v=>str(v,16).toUpperCase();
const classCode=v=>/^[A-Z]/.test(sipp(v))?sipp(v)[0]:"A";
const count=v=>{const m=/\d+/.exec(str(v));return m?Number(m[0]):null;};
const image=x=>{
 const v=Array.isArray(x.vehicleImages)?x.vehicleImages[0]?.url:null;
 try{const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password?u.toString().slice(0,2000):null;}
 catch{return null;}
};
function category(x,price,currency,input) {
 const k=id(x.vehicleId);
 if(!k)return null;
 return {external_id:k,class_code:classCode(x.sippCode),public_price:price,currency,
  example_model:str(x.vehicleName)||null,model:str(x.vehicleName)||null,
  transmission:str(x.transmissionTypeName)||null,fuel_type:str(x.fuelTypeName)||null,
  seats:count(x.passangerQuantityName),bags:count(x.baggageQuantityName),image:image(x),
  description:str(x.vehicleDescription)||str(x.vehicleName)||"Arvent category",
  features:{provider:ARVENT_PROVIDER,sipp:sipp(x.sippCode),arvent_vehicle_id:k,
   air_conditioning:x.isThereAirCondition===true},
  driver_included:false,seasonal_prices:null,
  location_external_ids:input?[input.pickup_location_id,input.dropoff_location_id].filter(Boolean):null};
}
export function arventGroupRows(e) {
 const data=supplierData(e);
 if(!Array.isArray(data))throw Error("PARTNER_API_ERROR:ARVENT_GROUPS_SHAPE");
 return data.slice(0,10000).filter(record).flatMap(x=>{
  const c=category(x,0,null,null);
  return c?[{...c,active:true,mileage_limit:null,deposit_amount:null}]:[];
 });
}
export function arventOfferMatchesTerms(x,currency="EUR") {
 // Fail closed: don't silently rewrite nonzero deposit, required card hold or mileage cap.
 return record(x)&&x.isAvailable===true&&str(x.currencyCode).toUpperCase()===currency.toUpperCase()
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
 return data.slice(0,10000).filter(x=>arventOfferMatchesTerms(x,currency)).flatMap(x=>{
  const total=x.totalPrice,c=category(x,Number((total/days).toFixed(6)),currency,input);
  if(!c)return [];
  return [{...c,active:true,deposit_amount:0,mileage_limit:null,
   price_is_total:true,public_price_total:total,
   quote_reference:[c.external_id,str(x.sippCode,20)].join(":").slice(0,500),
   quote_expires_at:null,
   features:{...c.features,noCreditCard:true,noCardHold:true,
    min_license_years:num(x.vendorMinimumDrivingLicenseAge),
    minimum_driver_age:num(x.vendorMinimumDriverAge),
    insurance_unverified:true},
   provider_quote_data:{provider:ARVENT_PROVIDER,vehicle_id:c.external_id,sipp:sipp(x.sippCode),
    total_amount:total,currency,pickup_location_id:input.pickup_location_id,
    dropoff_location_id:input.dropoff_location_id,quote_requires_live_revalidation:true}
  }];
 });
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
  // A negative enum from illustrative examples is *not* an approved state.
  needs_manual_review:raw!==1&&raw!==3,
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
   &&idString(saved.pickupLocationId)===idString(expected.pickup_location_id)
   &&idString(saved.returnLocationId)===idString(expected.dropoff_location_id)
   &&start.date===str(expected.pickup_date,10)
   &&end.date===str(expected.return_date,10)
   &&start.time===startTime[1]+":"+startTime[2]
   &&end.time===endTime[1]+":"+endTime[2]);
}
