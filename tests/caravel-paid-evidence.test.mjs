import test from "node:test";
import assert from "node:assert/strict";
import {loadCaravelPaidEvidence}
 from "../supabase/functions/_shared/caravel-paid-evidence.ts";
const NOW=Date.now(),ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const P="78721481-7619-44df-a9b7-5faa344b69bb";
const CLIENT="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const CAR="d20bbca4-678c-4abf-bf4d-cf5356220170";
const AID="5dc264ef-743d-4aa9-8579-aa0a8dcb04b7";
const Q="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11",H="a".repeat(64);
const later=new Date(NOW+600000).toISOString();
const paid=new Date(NOW-20000).toISOString();
const quote=()=>({
 provider:"caravel",quote_id:Q,supplier_id:"acct_eur",
 vehicle_id:"opaque-veh",currency:"EUR",payment_model:"pay_on_arrival",
 plan:"premium",expires_at:later,terms_document_id:"caravel-en-v4",
 terms_language:"en",terms_content_hash:H,
 amounts:{total:150},amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},
});
const booking=()=>({
 id:ID,partner_id:P,client_id:CLIENT,car_class_id:CAR,api_quote_id:AID,
 provider_type:"api",status:"pending",api_status:"caravel_paid_awaiting_supplier",
 manual_review:false,cancelled_at:null,api_booking_reference:null,
 stripe_session_id:"cs_live_123",stripe_currency:"pln",stripe_amount_cents:3999,
 caravel_stripe_payment_confirmed_at:paid,
 caravel_supplier_quote_id:Q,caravel_supplier_id:"acct_eur",
 caravel_terms_document_id:"caravel-en-v4",caravel_terms_language:"en",
 caravel_terms_content_hash:H,terms_accepted:true,terms_accepted_at:paid,
 main_driver_name:"Jan Testowy",main_driver_age:30,
 add_driver_name:null,add_driver_age:null,
 client_email:"test@example.invalid",client_phone:"+48000000000",
 partner_net_price_snapshot:150,partner_currency:"EUR",
 partner_discount_snapshot:0,reservation_code:"R24-TEST-1",
 partners:{api_provider:"caravel",api_enabled:true,
 active:true,account_status:"active"},
});
const stored=()=>({
 id:AID,booking_id:ID,partner_id:P,car_class_id:CAR,
 external_group_id:"opaque-veh",external_quote_reference:Q,
 partner_net_total:150,partner_discount_percent:0,currency:"EUR",
 expires_at:later,used_at:paid,
 raw_response:{ride24_context:{},caravel_quote:quote()},
});
function db(b=booking(),q=stored()){
 const stats={queries:[],errors:[]};
 return {stats,from(name){
  const rows=name==="bookings"?[b]:[q],filters=[];
  const item={
   eq:(k,v)=>{filters.push([k,v]);return item;},
   maybeSingle:async()=>{
    stats.queries.push(name);
    const row=rows.find(row=>row&&filters.every(([k,v])=>row[k]===v));
    return {data:row?structuredClone(row):null,error:null};
   },
  };
  return {select:()=>item};
 }};
}
const load=(admin,nowEpochMs=NOW)=>loadCaravelPaidEvidence({
 admin,bookingId:ID,nowEpochMs,
});
test("only persisted paid booking and bound server quote produce a Caravel provider request",async()=>{
 const admin=db(),r=await load(admin);
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.deepEqual(admin.stats.queries,["bookings","api_quotes"]);
 assert.equal(r.evidence.bookingInput.ride24_booking_id,ID);
 assert.equal(r.evidence.bookingInput.idempotency_key,`ride24:${ID}`);
 assert.equal(r.evidence.bookingInput.provider_quote_data.quote_id,Q);
 assert.equal(r.evidence.bookingInput.vehicle_group_id,"opaque-veh");
 assert.equal(r.evidence.bookingInput.partner_amount,150);
 assert.equal(r.evidence.bookingInput.main_driver.name,"Jan Testowy");
 assert.equal(r.evidence.bookingTerms.caravel_terms_document_id,"caravel-en-v4");
 assert.equal(r.evidence.coverageConsent,null);
});
test("disabled partner, non-Caravel booking, unpaid or held Stripe blocks BEFORE reading quote",async()=>{
 const cases=[
  {partner_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {partners:{...booking().partners,api_provider:"custom"}},
  {partners:{...booking().partners,api_enabled:false}},
  {partners:{...booking().partners,account_status:"draft"}},
  {provider_type:"local"},{status:"awaiting_payment"},
  {api_status:"caravel_supplier_dispatch_claimed"},
  {manual_review:true},{cancelled_at:paid},{stripe_currency:"eur"},
  {stripe_session_id:null},{stripe_amount_cents:0},
  {caravel_stripe_payment_confirmed_at:null},
  {terms_accepted:false},{terms_accepted_at:null},
  {caravel_terms_content_hash:"bad"},
 ];
 for(const patch of cases){
  const admin=db({...booking(),...patch});
  const r=await load(admin);
  assert.equal(r.ok,false,JSON.stringify(patch));
  assert.deepEqual(admin.stats.queries,["bookings"]);
 }
});
test("forged, missing, cross-partner, consumed-without-booking or changed quotes are rejected",async()=>{
 const cases=[
  {booking_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {partner_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {car_class_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {external_quote_reference:"wrong"},
  {external_group_id:"replaced-group"},
  {raw_response:{caravel_quote:{...quote(),supplier_id:"other"}}},
  {raw_response:{caravel_quote:{...quote(),quote_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"}}},
  {raw_response:{fake_quote:quote()}},
  {used_at:null},{partner_net_total:151},{currency:"GBP"},
  {partner_discount_percent:10},
  {expires_at:new Date(NOW-1000).toISOString()},
 ];
 for(const patch of cases){
  const admin=db(booking(),{...stored(),...patch});
  const r=await load(admin);
  assert.equal(r.ok,false,JSON.stringify(patch));
 }
});
test("accepted terms and supplier amounts cannot be changed after checkout",async()=>{
 for(const patch of [
  {caravel_terms_document_id:"caravel-en-v5"},
  {caravel_terms_content_hash:"b".repeat(64)},
  {partner_net_price_snapshot:149.99},
  {partner_currency:"GBP"},
  {caravel_supplier_id:"other"},
  {caravel_supplier_quote_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
 ]){
  const r=await load(db({...booking(),...patch}));
  assert.equal(r.ok,false,JSON.stringify(patch));
 }
});
test("partial or mismatched Premium coverage consent never reaches supplier dispatch",async()=>{
 for(const patch of [
  {caravel_coverage_supplier_id:"acct_eur"},
  {caravel_coverage_supplier_id:"another",caravel_coverage_quote_id:Q,
   caravel_coverage_terms_document_id:"caravel-en-v4",
   caravel_coverage_terms_content_hash:H,
   caravel_coverage_excluded_codes:["glass"],
   caravel_coverage_damage_admin_fee_minor:10000,
   caravel_coverage_accepted_at:paid},
 ]){
  const r=await load(db({...booking(),...patch}));
  assert.equal(r.ok,false,JSON.stringify(patch));
 }
});
test("missing production migration columns and database errors fail closed",async()=>{
 const admin={from(){throw new Error("missing column")}};
 const r=await load(admin);
 assert.equal(r.ok,false);
 assert.equal(r.reason,"CARAVEL_EVIDENCE_BOOKING_READ_FAILED");
});
