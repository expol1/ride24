import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as contract from "../../supabase/functions/_shared/arvent-kolaycar-contract.mjs";
import * as license from "../../supabase/functions/_shared/arvent-driver-eligibility.mjs";
import * as arventExtrasPricing from "../../supabase/functions/_shared/arvent-extras-pricing.mjs";

const source=await readFile(new URL("../../supabase/functions/_shared/arvent-kolaycar.ts",import.meta.url),"utf8");
const transformed=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal(transformed.diagnostics?.length||0,0,"Arvent adapter must parse as TypeScript");
const durationSource=await readFile(new URL("../../supabase/functions/_shared/rental-duration.ts",import.meta.url),"utf8");
const durationCompiled=ts.transpileModule(durationSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const durationSandbox={exports:{}};vm.runInNewContext(durationCompiled,durationSandbox);

function setup({licenseYears=0,allowWrites=false,savedStatus=0,savedSipp="CDAR",savedRef="A-1",requiredExtras=null,supplierDays=null,extrasDays=null,savedPrice=100,savedDeposit=0,savedPickupLocation=9,save401=false,cancelResponse=null}={}){
 const calls=[];
 let cancellationClaimed=false;
 const transport={
  sanitizePartnerPayload:x=>x,
  partnerApiRequest:async (credentials,path,request={})=>{
   calls.push({auth_type:credentials.auth_type,username:credentials.username,password:credentials.password,
    bearer_token:credentials.bearer_token,path,request});
   if(path==="/users/authenticate")return {success:true,resultCode:0,data:{token:"SYNTHETIC_BEARER_TOKEN"}};
   if(path.startsWith("/locations/cities"))return {success:true,resultCode:0,data:[{CityId:7,CityName:"Example City"}]};
   if(path.startsWith("/locations"))return {success:true,resultCode:0,data:[{locationId:9,
    countryCode:"TR",cityId:7,locationName:"Example Airport",isPickup:true,isAirport:true,iataCode:"AYT"}]};
   if(path.startsWith("/vehicles/list"))return {success:true,resultCode:0,data:[{
    vehicleId:100,vehicleName:"Example Category",sippCode:"CDAR"}]};
   if(path.startsWith("/vehicles?"))return {success:true,resultCode:0,data:[{
    vehicleId:100,vehicleName:"Example Category",sippCode:"CDAR",
    currencyCode:"EUR",isAvailable:true,depositPrice:0,depositCreditCardRequired:false,
    excess:0,rentalConditions:[{conditionCode:"7",conditionName:"Full Insurance"}],
    vendorMinimumDriverAge:21,vendorMinimumDrivingLicenseAge:licenseYears,totalKMLimit:0,totalPrice:100,rentalDuration:supplierDays,reservationToken:"00000000-0000-4000-8000-000000000001"}]};
   if(path.startsWith("/extras?"))return {success:true,resultCode:0,
    data:{vehicle:{vehicleId:100,sippCode:"CDAR",currencyCode:"EUR",isAvailable:true,
     excess:0,rentalConditions:[{conditionCode:"7",conditionName:"Full Insurance"}],
     depositPrice:0,depositCreditCardRequired:false,vendorMinimumDriverAge:21,vendorMinimumDrivingLicenseAge:licenseYears,totalKMLimit:0,
     totalPrice:100,rentalDuration:extrasDays,reservationToken:"00000000-0000-4000-8000-000000000001",
     pickupLocationId:9,returnLocationId:9,
     pickupDateTime:"2030-12-16T10:00:00",returnDateTime:"2030-12-17T10:00:00"},
     extras:requiredExtras}};
   if(path==="/reservations/save"&&save401)throw Error("PARTNER_API_ERROR:HTTP:401");
   if(path==="/reservations/save")return {success:true,resultCode:0,
    data:{reservationNumber:savedRef,sippCode:savedSipp,agencyReservationReference:"R24-XYZ",reservationStatusType:savedStatus,
     totalPrice:savedPrice,currencyCode:"EUR",depositPrice:savedDeposit,
     pickupLocationId:savedPickupLocation,returnLocationId:9,pickupDate:"2030-12-16T10:00:00",returnDate:"2030-12-17T10:00:00",
     depositCreditCardRequired:false,totalKMLimit:0}};
   if(path.startsWith("/reservations?")&&path.includes("agencyReservationReference="))
    return {success:true,resultCode:0,data:{reservationNumber:savedRef,sippCode:savedSipp,
     agencyReservationReference:"R24-XYZ",reservationStatusType:0}};
   if(path.startsWith("/reservations?"))return {success:true,resultCode:0,
    data:{reservationNumber:savedRef,sippCode:savedSipp,reservationStatusType:savedStatus,
     totalPrice:savedPrice,currencyCode:"EUR",depositPrice:savedDeposit,
     pickupLocationId:savedPickupLocation,returnLocationId:9,pickupDate:"2030-12-16T10:00:00",returnDate:"2030-12-17T10:00:00",
     depositCreditCardRequired:false,totalKMLimit:0}};
   if(path.startsWith("/reservations/cancel?"))return cancelResponse||{success:true,data:{reservationNumber:"A-1",reservationStatusType:3}};
   throw Error("Unexpected supplier endpoint "+path.split("?")[0]);
  },
 };
 const supabase={serviceClient:()=>({from:(table)=>({insert:async()=>{
   assert.equal(table,"arvent_cancel_attempts");
   if(cancellationClaimed)return {error:{code:"23505"}};
   cancellationClaimed=true;return {error:null};
  },select:()=>({
   eq(){return this;},limit(){return this;},
   async maybeSingle(){return {data:table==="api_quotes"?
    {external_group_id:"CDAR",pickup_location_external_id:"9",dropoff_location_external_id:"9"}:
    {client_email:"synthetic@example.invalid",partner_currency:"EUR",
     partner_net_price_snapshot:100,api_quote_id:"10000000-0000-4000-8000-000000000001",
     start_date:"2030-12-16",end_date:"2030-12-17",pickup_time:"10:00:00",return_time:"10:00:00"},
    error:null};}
  })})})};
 const require=name=>name==="./partner-api.ts"?transport:
  name==="./ride24-security.ts"?supabase:
  name==="./arvent-kolaycar-contract.mjs"?contract:
  name==="./arvent-driver-eligibility.mjs"?license:
  name==="./arvent-extras-pricing.mjs"?arventExtrasPricing:
  name==="./rental-duration.ts"?durationSandbox.exports:
  (()=>{throw Error("Unexpected import "+name)})();
 const sandbox={exports:{},require,Deno:{env:{get:key=>allowWrites&&["ARVENT_KOLAYCAR_WRITE_ALLOWED","ARVENT_STRIPE_FIRST_APPROVED"].includes(key)?"true":undefined}},URLSearchParams,URL,console};
 vm.runInNewContext(transformed.outputText,sandbox);
 return {...sandbox.exports,calls};
}
const creds={partner_id:"00000000-0000-4000-8000-000000000099",
 api_url:"https://racapi.arventcarrental.com",auth_type:"custom_headers",
 username:"dummy_user",password:"dummy_password"};
const input={pickup_location_id:"9",dropoff_location_id:"9",pickup_date:"2030-12-16",
 return_date:"2030-12-17",pickup_time:"10:00",return_time:"10:00",currency:"EUR"};

test("auth is JSON-only without Authorization headers, then Bearer for GET",async()=>{
 const a=setup();
 await a.arventTestConnection(creds);
 assert.equal(a.calls[0].path,"/users/authenticate");
 assert.equal(a.calls[0].request.method,"POST");
 assert.equal(a.calls[0].request.body.username,"dummy_user");
 assert.equal(a.calls[0].auth_type,"custom_headers");
 assert.equal(a.calls[0].username,null);
 assert.equal(a.calls[1].auth_type,"bearer");
 assert.equal(a.calls[1].bearer_token,"SYNTHETIC_BEARER_TOKEN");
 assert.equal(a.calls[1].password,null);
});
test("locations and catalog work read-only and do not trigger mutations",async()=>{
 const a=setup();
 const locations=await a.arventFetchLocations(creds);
 assert.equal(locations[0].city,"Antalya");
 assert.equal(locations[0].display_name,"Antalya Airport (AYT)");
 const groups=await a.arventFetchGroups(creds);
 assert.equal(groups[0].public_price,0);
 assert.ok(a.calls.every(call=>call.path!=="/reservations/save"));
});
test("live search sends EUR and dd.MM.yyyy then strips token",async()=>{
 const a=setup();
 const offers=await a.arventSearch(creds,input);
 assert.equal(offers.length,1);
 assert.equal(offers[0].public_price_total,100);
 assert.ok(a.calls.find(c=>c.path.includes("pickupDate=16.12.2030")));
 assert.ok(a.calls.find(c=>c.path.includes("currencyCode=EUR")));
 assert.ok(!JSON.stringify(offers).includes("00000000-0000-4000-8000-000000000001"));
});
test("offer extras read returns supplier codes, prices and one additional driver without posting a reservation",async()=>{
 const a=setup({requiredExtras:[
  {code:2,name:"Ek Sürücü",price:4.99,extraRentalType:3,extraQuantityIncreasable:false,isRequired:false},
  {code:6,name:"Bebek Koltuğu",price:8,extraRentalType:1,extraQuantityIncreasable:true,isRequired:false},
 ]});
 const result=await a.arventReadOfferExtras(creds,input,{vehicle_id:"100",sipp:"CDAR",total_amount:100});
 assert.equal(result.status,"present");
 assert.equal(result.items.length,2);
 assert.equal(result.items[0].code,"2");
 assert.equal(result.items[0].kind,"additional_driver");
 assert.equal(result.items[0].price_eur,4.99);
 assert.equal(result.items[0].booking_confirmed,false);
 assert.equal(result.items[1].code,"6");
 assert.ok(a.calls.some(x=>x.path.startsWith("/extras?")));
 assert.ok(a.calls.every(x=>x.path!=="/reservations/save"));
 assert.ok(!JSON.stringify(result).includes("00000000-0000-4000-8000-000000000001"));
});

test("supplier extras null remains an empty, read-only offer, not a failed booking",async()=>{
 const a=setup({requiredExtras:null});
 const result=await a.arventReadOfferExtras(creds,input,{vehicle_id:"100",sipp:"CDAR",total_amount:100});
 assert.equal(result.status,"none");
 assert.deepEqual(result.items,[]);
 assert.ok(a.calls.every(x=>x.path!=="/reservations/save"));
});

test("mismatched group or price cannot access offer extras nor create a booking",async()=>{
 for(const quote of [{vehicle_id:"100",sipp:"EDMR",total_amount:100},{vehicle_id:"100",sipp:"CDAR",total_amount:101}]){
  const a=setup();
  await assert.rejects(()=>a.arventReadOfferExtras(creds,input,quote),/ARVENT_OFFER_CHANGED/);
  assert.ok(!a.calls.some(x=>x.path.startsWith("/extras?")));
 }
});

test("supplier-confirmed rental duration determines day-based billing; disagreement blocks the quote",async()=>{
 const a=setup({supplierDays:3,extrasDays:3,requiredExtras:[{code:2,name:"Extra driver",
   price:7,extraRentalType:1,extraQuantityIncreasable:false,isRequired:false}]});
 const preview=await a.arventReadOfferExtras(creds,input,{vehicle_id:"100",sipp:"CDAR",total_amount:100});
 assert.equal(preview.billed_days,3);
 const changed=setup({supplierDays:3,extrasDays:4,requiredExtras:[]});
 await assert.rejects(()=>changed.arventReadOfferExtras(creds,input,{vehicle_id:"100",sipp:"CDAR",total_amount:100}),
   /ARVENT_EXTRAS_QUOTE_CHANGED/);
});
test("server guard prevents any supplier creation or cancellation in unapproved environment",async()=>{
 const a=setup();
 await assert.rejects(()=>a.arventCreateBooking(creds,{...input,partner_discount_percent:0,
  partner_amount:100}),/WRITES_NOT_CERTIFIED/);
 await assert.rejects(()=>a.arventCancelBooking(creds,"A-1"),/WRITES_NOT_CERTIFIED/);
 assert.equal(a.calls.length,0);
});
test("origin allowlist blocks sending auth credentials to other hosts",async()=>{
 const a=setup();
 await assert.rejects(()=>a.arventTestConnection({...creds,api_url:"https://attacker.invalid"}),/ARVENT_ORIGIN/);
 assert.equal(a.calls.length,0);
});
test("reservation status lookup uses server-side stored email and stays pending",async()=>{
 const a=setup();
 const result=await a.arventBookingStatus(creds,"A-1");
 assert.equal(result.status,"pending");
 const lookup=a.calls.find(c=>c.path.startsWith("/reservations?"));
 assert.ok(lookup.path.includes("customerEmail=synthetic%40example.invalid"));
});

test("unsupported agency-reference lookup never sends an invented supplier request",async()=>{
 const a=setup();
 await assert.rejects(()=>a.arventLookupByAgencyReference(creds,"R24-XYZ","example@example.com"),
  /ARVENT_AGENCY_LOOKUP_UNSUPPORTED/);
 assert.equal(a.calls.length,0);
});
const syntheticBooking={...input,partner_discount_percent:0,partner_amount:100,
 idempotency_key:"ride24:synthetic",ride24_booking_id:"R24-XYZ",reservation_code:"R24-XYZ",
 vehicle_group_id:"CDAR",main_driver:{name:"Example Customer",age:30,license_first_issued:"2024-01-01"},client_email:"example@example.com",
 client_phone:"000000000",provider_quote_data:{provider:"arvent_kolaycar",vehicle_id:"100",sipp:"CDAR",total_amount:100}};
test("approved status 1 only clears review after price and contract verification",async()=>{
 const a=setup({allowWrites:true,savedStatus:1});
 const result=await a.arventCreateBooking(creds,syntheticBooking);
 assert.equal(result.status,"confirmed");
 assert.equal(result.needs_manual_review,false);
 assert.equal(a.calls.filter(c=>c.path==="/reservations/save").length,1);
});
test("received 0 stays in provider_pending for safe polling, never triggers voucher",async()=>{
 const a=setup({allowWrites:true,savedStatus:0});
 const result=await a.arventCreateBooking(creds,syntheticBooking);
 assert.equal(result.status,"pending");
 assert.equal(result.needs_manual_review,false);
 assert.ok(result.booking_reference);
});
test("changed amount or deposit in saved reservation requires manual review",async()=>{
 for(const options of [{savedPrice:101},{savedDeposit:2000}]){
  const a=setup({allowWrites:true,savedStatus:1,...options});
  const result=await a.arventCreateBooking(creds,syntheticBooking);
  assert.equal(result.needs_manual_review,true,JSON.stringify(options));
 }
});

test("status 1 returns confirmed only if actual supplier EUR price and terms match booking",async()=>{
 const a=setup({savedStatus:1});
 const confirmed=await a.arventBookingStatus(creds,"A-1");
 assert.equal(confirmed.status,"confirmed");
 assert.equal(confirmed.needs_manual_review,false);
 for(const options of [{savedStatus:1,savedPrice:115},{savedStatus:1,savedDeposit:50}]){
  const changed=setup(options);
  const row=await changed.arventBookingStatus(creds,"A-1");
  assert.equal(row.status,"pending",JSON.stringify(options));
  assert.equal(row.needs_manual_review,true,JSON.stringify(options));
 }
});

test("approved supplier confirmation with changed pickup must never reach voucher",async()=>{
 const a=setup({savedStatus:1,savedPickupLocation:10});
 const status=await a.arventBookingStatus(creds,"A-1");
 assert.equal(status.status,"pending");
 assert.equal(status.needs_manual_review,true);
 const b=setup({allowWrites:true,savedStatus:1,savedPickupLocation:10});
 const created=await b.arventCreateBooking(creds,syntheticBooking);
 assert.equal(created.status,"pending");
 assert.equal(created.route_mismatch,true);
});

test("HTTP 401 cannot replay SaveReservation POST and risk double-booking",async()=>{
 const a=setup({allowWrites:true,save401:true});
 await assert.rejects(()=>a.arventCreateBooking(creds,syntheticBooking),/HTTP:401/);
 assert.equal(a.calls.filter(c=>c.path==="/reservations/save").length,1);
});

test("live extras:null with verified token-bound vehicle does not prevent booking",async()=>{
 const a=setup({allowWrites:true,savedStatus:1});
 const created=await a.arventCreateBooking(creds,syntheticBooking);
 assert.equal(created.status,"confirmed");
 const save=a.calls.find(x=>x.path==="/reservations/save");
 assert.ok(save);
 assert.equal(JSON.stringify(save.request.body.extras),"[]");
});

test("customer SIPP group cannot be swapped for a different supplier vehicle category",async()=>{
 const a=setup({allowWrites:true,savedStatus:1});
 const wrong={...syntheticBooking,vehicle_group_id:"MDMR"};
 await assert.rejects(()=>a.arventCreateBooking(creds,wrong),/ARVENT_FAILED_BEFORE_SAVE/);
 assert.equal(a.calls.filter(c=>c.path==="/reservations/save").length,0);
});

test("changed saved SIPP cannot confirm in either adapter path",async()=>{
 // Absent sippCode is the real live Arvent shape and is covered separately.
 for(const savedSipp of ["EDMR"]){
  const a=setup({allowWrites:true,savedStatus:1,savedSipp});
  for(const result of [await a.arventCreateBooking(creds,syntheticBooking),await a.arventBookingStatus(creds,"A-1")]){
   assert.equal(result.status,"pending");
   assert.equal(result.needs_manual_review,true);
  }
 }
});
test("different reservation number cannot confirm or trigger refund through polling",async()=>{
 for(const savedStatus of [1,3])
  await assert.rejects(setup({savedStatus,savedRef:"OTHER"}).arventBookingStatus(creds,"A-1"),/REFERENCE_MISMATCH/);
});
test("mandatory supplement without explicit zero price blocks supplier POST",async()=>{
 for(const price of [undefined,null,"",1]){
  const a=setup({allowWrites:true,requiredExtras:[{isRequired:true,code:"EX",price}]});
  await assert.rejects(a.arventCreateBooking(creds,syntheticBooking),/ARVENT_FAILED_BEFORE_SAVE/);
  assert.equal(a.calls.some(x=>x.path==="/reservations/save"),false);
 }
});
test("live reservation responses without sippCode confirm only on matching money, route and terms",async()=>{
 const a=setup({allowWrites:true,licenseYears:2,savedStatus:1,savedSipp:null});
 assert.equal((await a.arventCreateBooking(creds,syntheticBooking)).status,"confirmed");
 assert.equal((await a.arventBookingStatus(creds,"A-1")).status,"confirmed");
 const other=setup({allowWrites:true,licenseYears:2,savedStatus:1,savedSipp:"PDAR"});
 assert.equal((await other.arventCreateBooking(creds,syntheticBooking)).status,"pending");
 assert.equal((await other.arventBookingStatus(creds,"A-1")).status,"pending");
});
test("a one-cent increase cannot confirm a supplier booking",async()=>{
 const a=setup({allowWrites:true,savedStatus:1,savedPrice:100.01});
 assert.equal((await a.arventCreateBooking(creds,syntheticBooking)).status,"pending");
 assert.equal((await a.arventBookingStatus(creds,"A-1")).status,"pending");
});

test("overlapping cancellations issue one supplier POST and then reconcile by GET",async()=>{
 const a=setup({allowWrites:true,savedStatus:3});
 const results=await Promise.all([a.arventCancelBooking(creds,"A-1"),a.arventCancelBooking(creds,"A-1")]);
 assert.ok(results.every(result=>result.status==="cancelled"));
 assert.equal(a.calls.filter(call=>call.path.startsWith("/reservations/cancel?")).length,1);
 // Both the claimant (read-back after POST) and the overlapping caller confirm by GET.
 assert.equal(a.calls.filter(call=>call.path.startsWith("/reservations?")).length,2);
});
test("cancellation is confirmed only by supplier status 3 read back after the POST",async()=>{
 // Undocumented success body without reservation data is still verified by GET.
 const ok=setup({allowWrites:true,savedStatus:3,cancelResponse:{success:true,resultCode:0,data:true}});
 const done=await ok.arventCancelBooking(creds,"A-1");
 assert.equal(done.status,"cancelled");
 assert.equal(done.booking_reference,"A-1");
 // A cancel POST claiming success while the supplier still shows "approved" is not a cancellation.
 const stale=setup({allowWrites:true,savedStatus:1,cancelResponse:{success:true,data:{reservationNumber:"A-1",reservationStatusType:3}}});
 const pending=await stale.arventCancelBooking(creds,"A-1");
 assert.equal(pending.status,"pending");
 assert.equal(pending.needs_manual_review,true);
 // A business failure is never read back as success and never retried.
 const refused=setup({allowWrites:true,savedStatus:3,cancelResponse:{success:false,resultCode:5,data:null}});
 await assert.rejects(refused.arventCancelBooking(creds,"A-1"),/ARVENT_BUSINESS_FAILURE/);
 assert.equal(refused.calls.filter(call=>call.path.startsWith("/reservations/cancel?")).length,1);
});
test("checkout validates token-bound extras without saving a supplier booking",async()=>{
 const a=setup({requiredExtras:[{code:"INS",isRequired:true,price:5}]});
 await assert.rejects(a.arventVerifyCheckout(creds,syntheticBooking),/REQUIRED_EXTRAS/);
 assert.equal(a.calls.some(call=>call.path==="/reservations/save"),false);
});

test("positive supplier driving-licence tenure is checked before SaveReservation",async()=>{
 const approved=setup({allowWrites:true,licenseYears:10});
 await assert.rejects(()=>approved.arventCreateBooking(creds,syntheticBooking),/ARVENT_FAILED_BEFORE_SAVE/);
 assert.equal(approved.calls.filter(c=>c.path==="/reservations/save").length,0);
 const eligible=setup({allowWrites:true,licenseYears:2,savedStatus:1});
 const confirmed=await eligible.arventCreateBooking(creds,syntheticBooking);
 assert.equal(confirmed.status,"confirmed");
 assert.equal(eligible.calls.filter(c=>c.path==="/reservations/save").length,1);
});
