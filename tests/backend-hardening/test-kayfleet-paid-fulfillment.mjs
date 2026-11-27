import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as prices from "../../supabase/functions/_shared/kayfleet-pricing.mjs";
import * as contract from "../../supabase/functions/_shared/kayfleet-contract.mjs";
import { DefiniteApiFailure } from "../../supabase/functions/_shared/api-payment-flow.mjs";

const source = await readFile(
  new URL("../../supabase/functions/_shared/kayfleet-paid-fulfillment.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(transpiled.diagnostics?.length||0,0,"KayFleet adapter must be valid TypeScript");

const winter = (date, time) => date+"T"+String(time).padEnd(8,":00").slice(0,8)+"+02:00";
const extras={car_seat_qty:1,booster_seat_qty:0,additional_drivers:1};
const rawQuote = () => ({
  requested_full_insurance:true,
  quote_reference:"q-test-001",quote_expires_at:new Date(Date.now()+20*60_000).toISOString(),
  group_id:"economy",group_name:"Economy",
  pickup_location:"Larnaca Airport",dropoff_location:"Larnaca Airport",
  currency:"EUR",days:5,rental_total:166.25,insurance_fee:75,
  delivery_fee:0,equipment_fee:15,additional_driver_fee:3,grand_total:259.25,
  insurance_excess:0,deposit_amount:0,extras:structuredClone(extras),
});
function fixture({status="pending",errorPost=null,flags={KAYFLEET_LIVE_WRITE_ALLOWED:true,KAYFLEET_STRIPE_FIRST_APPROVED:true}}={}) {
  const calls=[];
  const fresh=rawQuote();
  const snapshot=prices.kayfleetSnapshot(fresh,{marginPercent:25,loyaltyPercent:0,exchangeRate:4.3});
  const datetimeOut=winter("2027-02-16","10:00:00");
  const datetimeIn=winter("2027-02-21","10:00:00");
  const expected={
    quote_reference:fresh.quote_reference,partner_ref:"R24-PAY-1",
    pickup_datetime:datetimeOut,return_datetime:datetimeIn,
    pickup_location:"Larnaca Airport",dropoff_location:"Larnaca Airport",
    group_name:"Economy",grand_total:259.25,extras,
  };
  let reply=()=>({
    reference:"supplier-ref-1",booking_number:"FR-1",
    status,partner_ref:"R24-PAY-1",quote_reference:fresh.quote_reference,
    group_name:"Economy",pickup_datetime:datetimeOut,return_datetime:datetimeIn,
    pickup_location:"Larnaca Airport",dropoff_location:"Larnaca Airport",
    currency:"EUR",rental_price:166.25,insurance_fee:75,
    equipment_fee:15,additional_driver_fee:3,delivery_fee:0,grand_total:259.25,
    full_insurance:true,insurance_excess:0,deposit_amount:0,extras:structuredClone(extras),
  });
  const response = async(_creds,path,request)=>{
    calls.push({path,method:request?.method||"GET"});
    if(path.startsWith("/api/partner/availability?"))
      return {vehicle_groups:[{group_id:"economy",available:true,available_count:3}]};
    if(path==="/api/partner/bookings"&&request.method==="POST"){
      if(errorPost)throw errorPost;
      return reply();
    }
    if(path.includes("/cancel")){status="cancelled";return {...reply(),status:"cancelled"};}
    if(path.startsWith("/api/partner/bookings/"))return reply();
    throw Error("Unexpected supplier path "+path);
  };
  const sandbox={
    exports:{},
    require:n=>n.includes("partner-api")?{
      partnerApiRequest:response,sanitizePartnerPayload:x=>x
    }:n.includes("kayfleet-adapter.ts")?{
      kayfleetQuoteWithExtras:async()=>fresh,cyprusIso:winter
    }:n.includes("kayfleet-pricing.mjs")?prices
      :n.includes("kayfleet-contract.mjs")?contract
      :n.includes("provider-services.mjs")?{}
      :n.includes("api-payment-flow.mjs")?{DefiniteApiFailure}
      :(()=>{throw Error("Unexpected import "+n)})(),
    Deno:{env:{get:key=>flags[key]===true?"true":undefined}},
    URLSearchParams,Date,Number,Math,Object,JSON,Array,String,Error,Promise,console,
  };
  vm.runInNewContext(transpiled.outputText,sandbox);
  const api=sandbox.exports;
  const booking={
    id:"ride24-booking-1",client_id:"user-1",partner_id:"fast-1",car_class_id:"car-1",
    api_quote_id:"quote-1",reservation_code:"R24-PAY-1",status:"awaiting_payment",
    partner_currency:"EUR",partner_net_price_snapshot:259.25,
    final_price_snapshot:snapshot.gross_cents/100,
    pickup_payment_partner_currency:259.25,online_payment_pln:snapshot.online_pln_cents/100,
    loyalty_discount_percent:0,partner_terms_snapshot:"terms",partner_rules_snapshot:"rules",
    partners:{rental_terms_url:"terms",rental_rules_url:"rules"},
    start_date:"2027-02-16",end_date:"2027-02-21",
    pickup_time:"10:00:00",return_time:"10:00:00",
    driver_id:"main-driver",additional_driver_id:"extra-driver",
    main_driver_name:"Test Driver",main_driver_age:32,add_driver_name:"Additional Driver",add_driver_age:31,
    client_email:"test@example.invalid",client_phone:"+35700000000",
  };
  const q={
    id:"quote-1",booking_id:booking.id,partner_id:booking.partner_id,
    car_class_id:booking.car_class_id,start_date:booking.start_date,end_date:booking.end_date,
    external_group_id:"economy",pickup_location_external_id:"Larnaca Airport",
    dropoff_location_external_id:"Larnaca Airport",currency:"EUR",partner_discount_percent:0,
    platform_margin_percent:25,partner_net_total:259.25,final_total:snapshot.gross_cents/100,
    raw_response:{
      provider_quote_data:{
        kayfleet:true,quote:fresh,pickup_datetime:datetimeOut,return_datetime:datetimeIn,
        pickup_location:"Larnaca Airport",dropoff_location:"Larnaca Airport"
      },
      ride24_options:{
        snapshot,
        binding:{user_id:"user-1",driver_id:"main-driver",additional_driver_id:"extra-driver",
          ages:[32,31],selections:[{id:"kayfleet:car_seat_qty",quantity:1},{id:"kayfleet:additional_drivers",quantity:1}]}
      }
    }
  };
  return {api,booking,q,snapshot,expected,calls,credentials:{api_key:"kf_live_dummy_not_real"},setStatus:s=>{status=s;},setReply:fn=>{reply=fn;}};
}
test("KayFleet paid adapter refuses TEST key before any network call",async()=>{
  const f=fixture();
  await assert.rejects(f.api.revalidatePaidKayfleet({api_key:"kf_test_123"},f.booking,f.q),DefiniteApiFailure);
  assert.equal(f.calls.length,0);
});
test("KayFleet paid adapter refuses disabled server authorization flags",async()=>{
  const f=fixture({flags:{}});
  assert.equal(f.api.kayfleetPaymentApproved(),false);
  await assert.rejects(f.api.revalidatePaidKayfleet(f.credentials,f.booking,f.q),DefiniteApiFailure);
  assert.equal(f.calls.length,0);
});
test("KayFleet paid quote revalidates supplier availability and exact accepted Stripe snapshot",async()=>{
  const f=fixture();
  const plan=await f.api.revalidatePaidKayfleet(f.credentials,f.booking,f.q);
  assert.equal(plan.path,"/api/partner/bookings");
  assert.equal(plan.body.partner_ref,"R24-PAY-1");
  assert.equal(plan.body.quote_reference,"q-test-001");
  assert.equal(plan.body.car_seat_qty,1);
  assert.equal(plan.body.additional_drivers,1);
  assert.deepEqual(f.calls.map(x=>x.method),["GET"]);
  const created=await f.api.createPaidKayfleet(f.credentials,plan);
  assert.equal(created.status,"pending");
  assert.equal(created.booking_reference,"supplier-ref-1");
  assert.ok(!created.needs_manual_review);
  f.setStatus("confirmed");
  const confirmed=await f.api.readPaidKayfleetStatus(f.credentials,"supplier-ref-1",plan);
  assert.equal(confirmed.status,"confirmed");
  assert.ok(!confirmed.needs_manual_review);
});
test("KayFleet changed supplier deposit or price blocks voucher on status read",async()=>{
  const f=fixture();
  const plan=await f.api.revalidatePaidKayfleet(f.credentials,f.booking,f.q);
  f.setReply(()=>({
    reference:"supplier-ref-1",booking_number:"FR-1",status:"confirmed",
    partner_ref:"R24-PAY-1",quote_reference:"q-test-001",
    group_name:"Economy",pickup_datetime:"2027-02-16T10:00:00+02:00",
    return_datetime:"2027-02-21T10:00:00+02:00",
    pickup_location:"Larnaca Airport",dropoff_location:"Larnaca Airport",
    currency:"EUR",rental_price:166.25,insurance_fee:75,
    equipment_fee:15,additional_driver_fee:3,delivery_fee:0,
    grand_total:259.25,full_insurance:true,insurance_excess:0,
    deposit_amount:300,extras:structuredClone(extras),
  }));
  const result=await f.api.readPaidKayfleetStatus(f.credentials,"supplier-ref-1",plan);
  assert.equal(result.needs_manual_review,true);
  assert.equal(result.status,"pending");
});
test("KayFleet POST 409 is a definite no-booking outcome, not a silent retry",async()=>{
  const f=fixture({errorPost:new Error("PARTNER_API_ERROR:HTTP:409")});
  const plan=await f.api.revalidatePaidKayfleet(f.credentials,f.booking,f.q);
  await assert.rejects(f.api.createPaidKayfleet(f.credentials,plan),
    e=>e instanceof DefiniteApiFailure&&e.message==="KAYFLEET_QUOTE_CONFLICT_NO_BOOKING");
  assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
});
test("KayFleet cancellation verifies an exact supplier reference and confirmed status",async()=>{
  const f=fixture();
  const plan=await f.api.revalidatePaidKayfleet(f.credentials,f.booking,f.q);
  const cancelled=await f.api.cancelPaidKayfleetAfterTimeout(f.credentials,"supplier-ref-1",plan);
  assert.equal(cancelled.status,"cancelled");
  assert.equal(cancelled.reference,"supplier-ref-1");
  assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
});
