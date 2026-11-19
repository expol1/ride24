import test from "node:test";
import assert from "node:assert/strict";
import {
 supplierData,arventDate,arventQuery,arventLocationRows,arventGroupRows,
 arventOfferMatchesTerms,arventOfferRows,arventReservationStatus,arventDateOfBirth,arventSavePayload,arventSavedRouteMatches,
 ARVENT_PATHS, ARVENT_INITIAL_AIRPORT_IATAS,
} from "../../supabase/functions/_shared/arvent-kolaycar-contract.mjs";

const ok=data=>({success:true,resultCode:0,data});
const example={
 vehicleId:100,vehicleName:"Example Vehicle",sippCode:"CDAR",currencyCode:"EUR",
 isAvailable:true,depositPrice:0,depositCreditCardRequired:false,totalKMLimit:0,
 excess:0,rentalConditions:[{conditionCode:"7",conditionName:"Full Insurance"}],
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
 assert.equal(rows[0].display_name,"Antalya Airport (AYT)");
});
test("catalog has no fabricated prices",()=>{
 const rows=arventGroupRows(ok([{vehicleId:100,vehicleName:"Example Vehicle",sippCode:"CDAR"}]));
 assert.equal(rows[0].external_id,"CDAR");
 assert.equal(rows[0].class_code,"B");
 assert.equal(rows[0].public_price,0);
 assert.equal(rows[0].model,null);
 assert.equal(rows[0].example_model,"Example Vehicle");
 assert.equal(rows[0].features.image_is_representative,true);
});
test("rejects supplier deposit, credit card, capped mileage or TRY quotes",()=>{
 for(const mutation of [
  {depositPrice:2000},{depositCreditCardRequired:true},{totalKMLimit:300},
  {currencyCode:"TRY"},{reservationToken:""},{totalPrice:0},
  {excess:500},{excess:null},{rentalConditions:[]},
  {rentalConditions:[{conditionCode:"10",conditionName:"Third Party Liability"}]}
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
  [0,"pending",false,"received"],[1,"confirmed",false,"approved"],
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

test("initial Arvent sync cannot expose non-agreed airports or non-airport offices",()=>{
 assert.deepEqual([...ARVENT_INITIAL_AIRPORT_IATAS].sort(),
 ["SAW","IST","SZF","ASR","DLM","AYT","ADB","EDO","AOE","TZX"].sort());
 const input=[
  {locationId:1,locationName:"Allowed Airport",countryCode:"TR",isAirport:true,iataCode:"SAW",isPickup:true},
  {locationId:2,locationName:"Non-contract Airport",countryCode:"TR",isAirport:true,iataCode:"BJV",isPickup:true},
  {locationId:3,locationName:"Ambiguous Airport",countryCode:"TR",isAirport:true,iataCode:null,isPickup:true},
  {locationId:4,locationName:"Non-airport Office",countryCode:"TR",isAirport:false,iataCode:"SAW",isPickup:true},
  {locationId:5,locationName:"Approved coded airport",countryCode:"TR",isAirport:true,locationCode:"TZX",isPickup:true},
 ];
 const rows=arventLocationRows(ok(input));
 assert.deepEqual(rows.map(x=>x.iata_code),["SAW","TZX"]);
 assert.deepEqual(rows.map(x=>x.external_id),["1","5"]);
});

test("live Arvent mapping explicitly recovers '(ADB)' IATA and Trabzon name '(TZX)'",()=>{
 const data=[
  {locationId:10,locationName:"İzmir Adnan Menderes Airport (ADB)",iataCode:"(ADB)",isAirport:true,isPickup:true,countryCode:"TR"},
  {locationId:9,locationName:"Trabzon Airport (TZX)",iataCode:"",isAirport:true,isPickup:true,countryCode:"TR"},
  {locationId:14,locationName:"Muğla Milas-Bodrum (BJV)",iataCode:"BJV",isAirport:true,isPickup:true,countryCode:"TR"},
  {locationId:17,locationName:"Alanya/Antalya Gazi Paşa Airport",iataCode:"",isAirport:false,isPickup:true,countryCode:"TR"}
 ];
 assert.deepEqual(arventLocationRows(ok(data)).map(x=>x.iata_code),["ADB","TZX"]);
});
test("Arvent catalogue and search do not invent category A for blank SIPP",()=>{
 assert.equal(arventGroupRows(ok([{vehicleId:260,vehicleName:"Dacia Sandero",sippCode:""}])).length,0);
 assert.equal(arventOfferRows(ok([{...example,sippCode:""}]),search).length,0);
});
test("billed supplier rentalDuration controls per-day display, while total remains authoritative",()=>{
 const [x]=arventOfferRows(ok([{...example,rentalDuration:3}]),search);
 assert.equal(x.public_price,50);
 assert.equal(x.public_price_total,150);
});

test("AVIA normalization: 6 Ride24 classes and one unique offer per SIPP group",()=>{
 const groups=[
  {vehicleId:101,vehicleName:"Renault Clio",sippCode:"MDMR"},
  {vehicleId:102,vehicleName:"Peugeot 208",sippCode:"MDMR"},
  {vehicleId:103,vehicleName:"Fiat Egea",sippCode:"CDAR"},
  {vehicleId:104,vehicleName:"Skoda Octavia",sippCode:"IDAR"},
  {vehicleId:105,vehicleName:"Hyundai Tucson",sippCode:"SFAR"},
  {vehicleId:106,vehicleName:"Premium",sippCode:"PDAR"},
  {vehicleId:107,vehicleName:"Family Van",sippCode:"FVAR"}
 ];
 const catalog=arventGroupRows(ok(groups));
 assert.deepEqual(catalog.map(x=>x.class_code),["A","B","C","D","E","F"]);
 assert.equal(catalog.length,6);
 assert.ok(catalog.every(x=>x.model===null&&x.example_model));
 const offers=arventOfferRows(ok([
  {...example,vehicleId:101,sippCode:"MDMR",totalPrice:180},
  {...example,vehicleId:102,sippCode:"MDMR",totalPrice:140},
  {...example,vehicleId:103,sippCode:"CDAR",totalPrice:150},
  {...example,vehicleId:104,sippCode:"IDAR",totalPrice:220},
  {...example,vehicleId:105,sippCode:"SFAR",totalPrice:300},
  {...example,vehicleId:106,sippCode:"PDAR",totalPrice:400},
  {...example,vehicleId:107,sippCode:"FVAR",totalPrice:500},
 ]),search);
 assert.equal(offers.length,6);
 assert.deepEqual(offers.map(x=>x.class_code),["A","B","C","D","E","F"]);
 const cheap=offers.find(x=>x.external_id==="MDMR");
 assert.equal(cheap.public_price_total,140);
 assert.equal(cheap.provider_quote_data.vehicle_id,"102");
 assert.equal(cheap.provider_quote_data.sipp,"MDMR");
 assert.equal(cheap.example_model,"Example Vehicle");
 assert.equal(cheap.model,null);
 assert.ok(!JSON.stringify(offers).includes(example.reservationToken));
});
test("supplier models with same group and price choose deterministic lowest supplier ID",()=>{
 const offers=arventOfferRows(ok([
  {...example,vehicleId:44,sippCode:"CDAR"},
  {...example,vehicleId:3,sippCode:"CDAR"},
  {...example,vehicleId:9,sippCode:"CDAR"},
 ]),search);
 assert.equal(offers.length,1);
 assert.equal(offers[0].provider_quote_data.vehicle_id,"3");
});

test("one SIPP maps to one stable A-F class despite conflicting representative seat counts",()=>{
 const rows=arventGroupRows(ok([
  {vehicleId:1,vehicleName:"Wagon",sippCode:"IWMD",passangerQuantityName:"5 Person"},
  {vehicleId:2,vehicleName:"Wagon XL",sippCode:"IWMD",passangerQuantityName:"7 Person"},
  {vehicleId:3,vehicleName:"SUV",sippCode:"XFAD",passangerQuantityName:"5 Person"},
  {vehicleId:4,vehicleName:"SUV XL",sippCode:"XFAD",passangerQuantityName:"7 Person"},
 ]));
 assert.equal(rows.length,2);
 assert.equal(rows.find(x=>x.external_id==="IWMD").class_code,"C");
 assert.equal(rows.find(x=>x.external_id==="XFAD").class_code,"D");
 const offers=arventOfferRows(ok([
  {...example,vehicleId:1,sippCode:"IWMD",passangerQuantityName:"5 Person"},
  {...example,vehicleId:2,sippCode:"IWMD",passangerQuantityName:"7 Person",totalPrice:200},
  {...example,vehicleId:3,sippCode:"XFAD",passangerQuantityName:"5 Person"},
  {...example,vehicleId:4,sippCode:"XFAD",passangerQuantityName:"7 Person",totalPrice:250},
 ]),search);
 assert.equal(offers.length,2);
 assert.equal(offers.find(x=>x.external_id==="IWMD").class_code,"C");
 assert.equal(offers.find(x=>x.external_id==="XFAD").class_code,"D");
});

test("Istanbul supplier typo and Turkish city variants normalize to Ride24 names",()=>{
 const rows=arventLocationRows(ok([
  {locationId:4,locationName:"İstanbul New Airpot (IST)",iataCode:"IST",
   cityName:"İstanbul",countryCode:"TR",isAirport:true,isPickup:true},
  {locationId:1,locationName:"Istanbul Sabiha Gokcen Airport (SAW)",iataCode:"SAW",
   cityName:"İstanbul",countryCode:"TR",isAirport:true,isPickup:true}
 ]));
 assert.deepEqual(rows.map(x=>x.display_name),[
  "Istanbul Airport (IST)","Istanbul Sabiha Gökçen Airport (SAW)"
 ]);
 assert.ok(rows.every(x=>x.city==="Istanbul"&&x.country==="Turkey"));
});

test("Arvent insurance is verified ONLY by returned Full Insurance condition and exact zero excess",()=>{
 for(const conditions of [
  [{conditionCode:"7",conditionName:"Full Insurance"}],
  JSON.stringify([{conditionCode:"7",conditionName:"Full Insurance"}])
 ]) {
  assert.equal(arventOfferMatchesTerms({...example,rentalConditions:conditions,excess:"0.00"},"EUR"),true);
 }
 for(const conditions of [
  null,[],[],[{}],[{conditionName:"Basic Cover"}],
  [{conditionName:"Not Full Insurance"}],"invalid-json"
 ]) {
  assert.equal(arventOfferMatchesTerms({...example,rentalConditions:conditions},"EUR"),false,String(conditions));
 }
 const [selected]=arventOfferRows(ok([example]),search);
 assert.equal(selected.features.full_insurance_included,true);
 assert.equal(selected.features.insurance_unverified,false);
 assert.equal(selected.features.insurance_excess_eur,0);
});
