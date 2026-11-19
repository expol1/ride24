import test from "node:test";
import assert from "node:assert/strict";
import {verifyCaravelClaimedPaidBooking}
 from "../supabase/functions/_shared/caravel-dispatch-proof.ts";
const NOW=1900000000000;
const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const Q="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const H="a".repeat(64);
const quote=()=>({provider:"caravel",quote_id:Q,supplier_id:"acct_eur",
 terms_document_id:"caravel-en-v4",terms_content_hash:H,terms_language:"en"});
const row=()=>({
 id:ID,partner_id:"78721481-7619-44df-a9b7-5faa344b69bb",
 provider_type:"api",api_provider:"caravel",status:"pending",
 api_status:"caravel_supplier_dispatch_claimed",
 api_booking_reference:null,cancelled_at:null,manual_review:false,
 stripe_session_id:"cs_live_test",stripe_currency:"pln",stripe_amount_cents:3999,
 caravel_stripe_payment_confirmed_at:new Date(NOW-30000).toISOString(),
 caravel_supplier_dispatch_claimed_at:new Date(NOW-8000).toISOString(),
 caravel_supplier_quote_id:Q,caravel_supplier_id:"acct_eur",
 caravel_terms_document_id:"caravel-en-v4",caravel_terms_content_hash:H,
 caravel_terms_language:"en",
});
const verify=(r=row(),q=quote(),nowEpochMs=NOW)=>
 verifyCaravelClaimedPaidBooking({persistedBooking:r,ride24BookingId:ID,
  providerQuote:q,nowEpochMs});
test("atomic durable paid claim authorizes only exact booking, quote and supplier",()=>{
 const res=verify();assert.equal(res.ok,true,JSON.stringify(res));
 assert.deepEqual(res,{ok:true,bookingId:ID,idempotencyKey:ID,
  supplierId:"acct_eur",quoteId:Q});
});
test("a boolean paymentConfirmed is not an alternative to persisted Stripe evidence",()=>{
 for(const patch of [
  {status:"awaiting_payment"},{api_status:"caravel_paid_awaiting_supplier"},
  {api_status:"confirmed"},{api_booking_reference:"ext"},
  {manual_review:true},{cancelled_at:"2026-11-18T10:00:00Z"},
  {stripe_session_id:null},{stripe_currency:"eur"},{stripe_amount_cents:0},
  {stripe_amount_cents:0.15},{caravel_stripe_payment_confirmed_at:null},
  {caravel_supplier_dispatch_claimed_at:null},{caravel_supplier_quote_id:"different"},
  {caravel_supplier_id:"acct_gbp"},{provider_type:"local"},{api_provider:"renteon"},
  {partner_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},{id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
  {caravel_terms_content_hash:"b".repeat(64)},
 ]){
 const res=verify({...row(),paymentConfirmed:true,...patch});
 assert.equal(res.ok,false,JSON.stringify(patch));
 assert.equal(res.action,"hold_for_manual_review");
 }
});
test("expired, future or pre-payment dispatch claims are not replayed",()=>{
 for(const patch of [
  {caravel_supplier_dispatch_claimed_at:new Date(NOW-121000).toISOString(),
   caravel_stripe_payment_confirmed_at:new Date(NOW-122000).toISOString()},
  {caravel_supplier_dispatch_claimed_at:new Date(NOW+7000).toISOString()},
  {caravel_supplier_dispatch_claimed_at:new Date(NOW-30000).toISOString(),
   caravel_stripe_payment_confirmed_at:new Date(NOW-20000).toISOString()},
 ]){
  assert.equal(verify({...row(),...patch}).ok,false,JSON.stringify(patch));
 }
});
test("quote replay or mutable terms are rejected",()=>{
 for(const q of [
  {...quote(),quote_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
  {...quote(),supplier_id:"acct_gbp"},
  {...quote(),terms_document_id:"caravel-en-v5"},
  {...quote(),terms_content_hash:"b".repeat(64)},
 ]){
  assert.equal(verify(row(),q).ok,false,JSON.stringify(q));
 }
});
