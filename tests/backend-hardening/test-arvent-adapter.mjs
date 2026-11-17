import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as contract from "../../supabase/functions/_shared/arvent-kolaycar-contract.mjs";

const source=await readFile(new URL("../../supabase/functions/_shared/arvent-kolaycar.ts",import.meta.url),"utf8");
const transformed=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal(transformed.diagnostics?.length||0,0,"Arvent adapter must parse as TypeScript");

function setup(){
 const calls=[];
 const transport={
  sanitizePartnerPayload:x=>x,
  partnerApiRequest:async (credentials,path,request={})=>{
   calls.push({auth_type:credentials.auth_type,username:credentials.username,password:credentials.password,
    bearer_token:credentials.bearer_token,path,request});
   if(path==="/users/authenticate")return {success:true,resultCode:0,data:{token:"SYNTHETIC_BEARER_TOKEN"}};
   if(path.startsWith("/locations/cities"))return {success:true,resultCode:0,data:[{CityId:7,CityName:"Example City"}]};
   if(path.startsWith("/locations"))return {success:true,resultCode:0,data:[{locationId:9,
    countryCode:"TR",cityId:7,locationName:"Example Airport",isPickup:true,isAirport:true}]};
   if(path.startsWith("/vehicles/list"))return {success:true,resultCode:0,data:[{
    vehicleId:100,vehicleName:"Example Category",sippCode:"CDAR"}]};
   if(path.startsWith("/vehicles?"))return {success:true,resultCode:0,data:[{
    vehicleId:100,vehicleName:"Example Category",sippCode:"CDAR",
    currencyCode:"EUR",isAvailable:true,depositPrice:0,depositCreditCardRequired:false,
    totalKMLimit:0,totalPrice:100,reservationToken:"00000000-0000-4000-8000-000000000001"}]};
   if(path.startsWith("/reservations?"))return {success:true,resultCode:0,
    data:{reservationNumber:"A-1",reservationStatusType:0}};
   throw Error("Unexpected supplier endpoint "+path.split("?")[0]);
  },
 };
 const supabase={serviceClient:()=>({from:()=>({select:()=>({
   eq(){return this;},limit(){return this;},async maybeSingle(){return {data:{client_email:"synthetic@example.invalid"},error:null};}
  })})})};
 const require=name=>name==="./partner-api.ts"?transport:
  name==="./ride24-security.ts"?supabase:
  name==="./arvent-kolaycar-contract.mjs"?contract:
  (()=>{throw Error("Unexpected import "+name)})();
 const sandbox={exports:{},require,Deno:{env:{get:()=>undefined}},URLSearchParams,URL,console};
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
