import test from "node:test";
import assert from "node:assert/strict";
import {
 supplierData,arventDate,arventQuery,arventLocationRows,arventGroupRows,
 arventOfferMatchesTerms,arventOfferRows,arventReservationStatus,arventDateOfBirth,arventSavePayload,arventSavedRouteMatches,
 ARVENT_PATHS,
} from "../../supabase/functions/_shared/arvent-kolaycar-contract.mjs";

const ok=data=>({success:true,resultCode:0,data});
const example={
 vehicleId:100,vehicleName:"Example Vehicle",sippCode:"CDAR",currencyCode:"EUR",
 isAvailable:true,depositPrice:0,depositCreditCardRequired:false,totalKMLimit:0,
 totalPrice:150,pricePerDay:75,reservationToken:"00000000-0000-4000-8000-000000000001",
 vendorMinimumDriverAge:21,vendorMinimumDrivingLicenseAge:1,
};
const search={pickup_location_id:"1",dropoff_location_id:"1",pickup_date:"2030-12-16",
 return_date:"2030-12-18",pickup_time:"10:00",return_time:"10:00",currency:"EUR"};

test("actual Postman REST routes are used, not generic or 2018 SOAP routes",()=>{
 assert.equal(ARVENT_PATHS.auth,"/users/authenticate");
 assert.equal(ARVENT_PATHS.search,"/vehicles");
 assert.equal(ARVENT_PATHS.booking_create,"/reservations/save");
 assert.equal(ARVENT_PATHS.booking_cancel,"/reservations/cancel");
 assert.equal(ARVENT_PATHS.booking_status,"/reservations");
});
test("rejects HTTP 200 business errors, including nonzero resultCode",()=>{
 assert.throws(()=>supplierData({success:false,resultCode:0,data:[]}),/BUSINESS_FAILURE/);
 assert.throws(()=>supplierData({success:true,resultCode:401,data:[]}),/BUSINESS_FAILURE/);
 assert.deepEqual(supplierData(ok([])),[]);
});
test("date conversion is strict dd.MM.yyyy",()=>{
 assert.equal(arventDate("2030-12-16"),"16.12.2030");
 assert.throws(()=>arventDate("2030-02-31"),/DATE_INVALID/);
 assert.throws(()=>arventDate("16.12.2030"),/DATE_INVALID/);
});
test("locations map numeric IDs and preserve return-only flags",()=>{
 const rows=arventLocationRows(ok([{locationId:6,locationName:"Example Airport",
  countryCode:"TR",cityId:2,isPickup:false,isAirport:true,iataCode:"AYT"}]),
  [{CityId:2,CityName:"Antalya"}]);
 assert.equal(rows[0].external_id,"6");
 assert.equal(rows[0].region,"Antalya");
 assert.equal(rows[0].return_only,true);
 assert.equal(rows[0].type,"airport");
});
test("catalog has no fabricated prices",()=>{
 const rows=arventGroupRows(ok([{vehicleId:100,vehicleName:"Example Vehicle",sippCode:"CDAR"}]));
 assert.equal(rows[0].external_id,"100");
 assert.equal(rows[0].class_code,"C");
 assert.equal(rows[0].public_price,0);
});
test("rejects supplier deposit, credit card, capped mileage or TRY quotes",()=>{
 for(const mutation of [
  {depositPrice:2000},{depositCreditCardRequired:true},{totalKMLimit:300},
  {currencyCode:"TRY"},{reservationToken:""},{totalPrice:0}
 ]) assert.equal(arventOfferMatchesTerms({...example,...mutation},"EUR"),false,JSON.stringify(mutation));
 assert.equal(arventOfferMatchesTerms(example,"EUR"),true);
 const output=arventOfferRows(ok([{...example,depositPrice:2000}]),search);
 assert.equal(output.length,0);
});
test("accepted EUR quote is per-day priced with total and no token leakage",()=>{
 const [x]=arventOfferRows(ok([example]),search);
 assert.equal(x.public_price_total,150);
 assert.equal(x.public_price,75);
 assert.equal(x.price_is_total,true);
 assert.equal(x.deposit_amount,0);
 assert.equal(x.features.noCardHold,true);
 assert.equal(x.provider_quote_data.total_amount,150);
 assert.ok(!JSON.stringify(x).includes(example.reservationToken));
});
test("2026-11-18 authoritative enum: only approved 1 is confirmed, 3 is cancelled",()=>{
 const expectations=[
  [0,"pending",true,"received"],[1,"confirmed",false,"approved"],
  [2,"pending",true,"payment_completed"],[3,"cancelled",false,"cancelled"],
  [4,"pending",true,"awaiting_payment"],[5,"pending",true,"vehicle_handed_over"],
  [6,"pending",true,"unapproved"],[-4,"pending",true,"unknown"],
  [999,"pending",true,"unknown"]
 ];
 for(const [code,status,review,label] of expectations) {
  const actual=arventReservationStatus(ok({reservationNumber:"A-1",reservationStatusType:code}));
  assert.equal(actual.status,status,String(code));
  assert.equal(actual.needs_manual_review,review,String(code));
  assert.equal(actual.supplier_status_label,label,String(code));
  assert.equal(actual.definitive_rejection,false);
 }
});
test("real date of birth uses dd.MM.yyyy, never synthesizes a date from age",()=>{
 assert.equal(arventDateOfBirth("1999-10-29"),"29.10.1999");
 assert.equal(arventDateOfBirth("29.10.1999"),"29.10.1999");
 assert.equal(arventDateOfBirth(""),"");
 assert.throws(()=>arventDateOfBirth("31.02.1990"),/BIRTHDAY_INVALID/);
 assert.throws(()=>arventDateOfBirth("35"),/BIRTHDAY_INVALID/);
});
test("save payload uses only code/piece extras and no prepayment",()=>{
 const p=arventSavePayload({reservationToken:example.reservationToken,reference:"R24-XYZ",
  customer:{name:"Example",surname:"Customer",phoneNumber:"+48 000000000",
   email:"example@example.com",birthDay:"1999-10-29"},extras:[{code:"REAL_CODE",piece:1}]});
 assert.equal(p.payment.paymentType,3);
 assert.equal(p.customer.birthDay,"29.10.1999");
 assert.equal(p.pricing.paidAmount,0);
 assert.equal(p.sendReservationMail,false);
 assert.deepEqual(p.extras,[{code:"REAL_CODE",piece:1}]);
 assert.equal(p.agencyReservationReference,"R24-XYZ");
 assert.throws(()=>arventSavePayload({reservationToken:"EXAMPLE",reference:"R24",customer:{}}),/TOKEN_REQUIRED/);
});
test("query parameters are URL encoded",()=>{
 const query=arventQuery({reservationNumber:"A/1",customerEmail:"x+y@example.com",languageCode:"EN"});
 assert.ok(query.includes("reservationNumber=A%2F1"));
 assert.ok(query.includes("customerEmail=x%2By%40example.com"));
});

test("supplier approved booking must preserve exact locations, dates and times",()=>{
 const saved={pickupLocationId:9,returnLocationId:10,
  pickupDate:"2030-12-16T10:00:00",returnDate:"2030-12-18T11:30:00"};
 const expected={pickup_location_id:"9",dropoff_location_id:"10",
  pickup_date:"2030-12-16",return_date:"2030-12-18",pickup_time:"10:00",return_time:"11:30"};
 assert.equal(arventSavedRouteMatches(saved,expected),true);
 for (const changed of [
  {pickupLocationId:11},{returnLocationId:11},
  {pickupDate:"2030-12-17T10:00:00"},{returnDate:"2030-12-19T11:30:00"},
  {pickupDate:"2030-12-16T10:30:00"},{returnDate:"2030-12-18T12:00:00"},
  {pickupLocationId:null},{returnDate:null}
 ])assert.equal(arventSavedRouteMatches({...saved,...changed},expected),false,JSON.stringify(changed));
 assert.equal(arventSavedRouteMatches(saved,{...expected,return_time:"12:00"}),false);
});
