import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as contract from "../../supabase/functions/_shared/arvent-kolaycar-contract.mjs";

const source=await readFile(new URL("../../supabase/functions/_shared/arvent-kolaycar.ts",import.meta.url),"utf8");
const transformed=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal(transformed.diagnostics?.length||0,0,"Arvent adapter must parse as TypeScript");

function setup({allowWrites=false,savedStatus=0,savedPrice=100,savedDeposit=0,savedPickupLocation=9,save401=false}={}){
 const calls=[];
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
    totalKMLimit:0,totalPrice:100,reservationToken:"00000000-0000-4000-8000-000000000001"}]};
   if(path.startsWith("/extras?"))return {success:true,resultCode:0,
    data:{vehicle:{vehicleId:100,currencyCode:"EUR",isAvailable:true,
     depositPrice:0,depositCreditCardRequired:false,totalKMLimit:0,
     totalPrice:100,reservationToken:"00000000-0000-4000-8000-000000000001",
     pickupLocationId:9,returnLocationId:9,
     pickupDateTime:"2030-12-16T10:00:00",returnDateTime:"2030-12-17T10:00:00"},
     extras:null}};
   if(path==="/reservations/save"&&save401)throw Error("PARTNER_API_ERROR:HTTP:401");
   if(path==="/reservations/save")return {success:true,resultCode:0,
    data:{reservationNumber:"A-1",agencyReservationReference:"R24-XYZ",reservationStatusType:savedStatus,
     totalPrice:savedPrice,currencyCode:"EUR",depositPrice:savedDeposit,
     pickupLocationId:savedPickupLocation,returnLocationId:9,pickupDate:"2030-12-16T10:00:00",returnDate:"2030-12-17T10:00:00",
     depositCreditCardRequired:false,totalKMLimit:0}};
   if(path.startsWith("/reservations?")&&path.includes("agencyReservationReference="))
    return {success:true,resultCode:0,data:{reservationNumber:"A-1",
     agencyReservationReference:"R24-XYZ",reservationStatusType:0}};
   if(path.startsWith("/reservations?"))return {success:true,resultCode:0,
    data:{reservationNumber:"A-1",reservationStatusType:savedStatus,
     totalPrice:savedPrice,currencyCode:"EUR",depositPrice:savedDeposit,
     pickupLocationId:savedPickupLocation,returnLocationId:9,pickupDate:"2030-12-16T10:00:00",returnDate:"2030-12-17T10:00:00",
     depositCreditCardRequired:false,totalKMLimit:0}};
   throw Error("Unexpected supplier endpoint "+path.split("?")[0]);
  },
 };
 const supabase={serviceClient:()=>({from:(table)=>({select:()=>({
   eq(){return this;},limit(){return this;},
   async maybeSingle(){return {data:table==="api_quotes"?
    {pickup_location_external_id:"9",dropoff_location_external_id:"9"}:
    {client_email:"synthetic@example.invalid",partner_currency:"EUR",
     partner_net_price_snapshot:100,api_quote_id:"10000000-0000-4000-8000-000000000001",
     start_date:"2030-12-16",end_date:"2030-12-17",pickup_time:"10:00:00",return_time:"10:00:00"},
    error:null};}
  })})})};
 const require=name=>name==="./partner-api.ts"?transport:
  name==="./ride24-security.ts"?supabase:
  name==="./arvent-kolaycar-contract.mjs"?contract:
  (()=>{throw Error("Unexpected import "+name)})();
 const sandbox={exports:{},require,Deno:{env:{get:key=>allowWrites&&key==="ARVENT_KOLAYCAR_WRITE_ALLOWED"?"true":undefined}},URLSearchParams,URL,console};
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
 assert.equal(locations[0].city,"Example City");
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

test("read-only lookup after uncertain booking can find exact original reference",async()=>{
 const a=setup();
 const found=await a.arventLookupByAgencyReference(creds,"R24-XYZ","example@example.com");
 assert.equal(found.booking_reference,"A-1");
 assert.equal(found.status,"pending");
 assert.ok(a.calls.some(c=>c.path.includes("agencyReservationReference=R24-XYZ")));
 assert.ok(a.calls.every(c=>c.path!=="/reservations/save"));
});
const syntheticBooking={...input,partner_discount_percent:0,partner_amount:100,
 idempotency_key:"ride24:synthetic",ride24_booking_id:"R24-XYZ",reservation_code:"R24-XYZ",
 vehicle_group_id:"100",main_driver:{name:"Example Customer"},client_email:"example@example.com",
 client_phone:"000000000",provider_quote_data:{provider:"arvent_kolaycar",vehicle_id:"100"}};
test("approved status 1 only clears review after price and contract verification",async()=>{
 const a=setup({allowWrites:true,savedStatus:1});
 const result=await a.arventCreateBooking(creds,syntheticBooking);
 assert.equal(result.status,"confirmed");
 assert.equal(result.needs_manual_review,false);
 assert.equal(a.calls.filter(c=>c.path==="/reservations/save").length,1);
});
test("received 0 never triggers voucher even after successful HTTP response",async()=>{
 const a=setup({allowWrites:true,savedStatus:0});
 const result=await a.arventCreateBooking(creds,syntheticBooking);
 assert.equal(result.status,"pending");
 assert.equal(result.needs_manual_review,true);
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
