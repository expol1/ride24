import test from "node:test";
import assert from "node:assert/strict";
import {
 CARAVEL_PAID_AWAITING_SUPPLIER,
 verifyCaravelPaidCheckoutForSupplierQueue,
 verifyCaravelProviderDispatchMayStart,
 canReleaseCaravelVoucher,
} from "../supabase/functions/_shared/caravel-payment-sequence.ts";

const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const CLIENT="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const ACCEPTED_AT="2026-11-18T09:45:00.000Z";
const b=()=>({id:ID,client_id:CLIENT,provider_type:"api",api_provider:"caravel",
 status:"awaiting_payment",api_status:"caravel_awaiting_stripe",
 api_booking_reference:null,
 cancelled_at:null,manual_review:false,stripe_session_id:"cs_test_abc",
 online_payment_pln:39.99,stripe_amount_cents:3999,stripe_currency:"pln"});
const s=()=>({id:"cs_test_abc",client_reference_id:ID,
 metadata:{booking_id:ID,client_id:CLIENT},payment_status:"paid",status:"complete",
 currency:"pln",amount_total:3999});
test("Caravel verified paid Stripe session queues supplier before voucher",()=>{
 const r=verifyCaravelPaidCheckoutForSupplierQueue(b(),s(),ACCEPTED_AT);
 assert.equal(r.ready,true,JSON.stringify(r));
 assert.deepEqual(r.transition,{
  fromStatus:"awaiting_payment",status:"pending",
  api_status:CARAVEL_PAID_AWAITING_SUPPLIER,manual_review:false,
  caravel_stripe_payment_confirmed_at:ACCEPTED_AT,
  stripe_currency:"pln",stripe_amount_cents:3999});
 assert.equal(r.generateVoucher,false);
 assert.equal(r.notifyCustomerConfirmed,false);
});
test("missing, unpaid, reused, altered or mismatched session never releases voucher",()=>{
 const base=b(),pay=s();
 for(const [booking,session] of [
  [{...base,stripe_session_id:"cs_test_other"},pay],
  [base,{...pay,id:"cs_test_other"}],
  [base,{...pay,payment_status:"unpaid"}],
  [base,{...pay,currency:"eur"}],
  [base,{...pay,amount_total:1}],
  [base,{...pay,metadata:{booking_id:"other"}}],
  [base,{...pay,client_reference_id:"other"}],
  [{...base,client_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},pay],
  [base,{...pay,metadata:{booking_id:ID,client_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"}}],
  [{...base,stripe_currency:"eur"},pay],
  [{...base,api_provider:"avia"},pay],
  [{...base,api_status:null},pay],
  [{...base,api_status:"caravel_quote_unclaimed"},pay],
  [{...base,api_status:"caravel_supplier_dispatch_claimed"},pay],
  [{...base,provider_type:"local"},pay],
  [{...base,status:"cancelled",cancelled_at:"2026-11-18"},pay],
  [{...base,status:"rejected"},pay],
  [{...base,manual_review:true},pay],
  [{...base,api_booking_reference:"external-id"},pay],
 ]){
  const r=verifyCaravelPaidCheckoutForSupplierQueue(booking,session,ACCEPTED_AT);
  assert.equal(r.ready,false,JSON.stringify([booking,session]));
  assert.equal(r.generateVoucher,false);
 }
});
test("duplicate Stripe webhook is idempotently queued, not a second booking",()=>{
 const booking={...b(),status:"pending",api_status:CARAVEL_PAID_AWAITING_SUPPLIER};
 const r=verifyCaravelPaidCheckoutForSupplierQueue(booking,s(),ACCEPTED_AT);
 assert.equal(r.ready,false);
 assert.equal(r.action,"already_waiting_for_supplier");
});
test("supplier dispatch can only start on persisted Stripe confirmation",()=>{
 const booking={...b(),status:"pending",api_status:CARAVEL_PAID_AWAITING_SUPPLIER,
  caravel_stripe_payment_confirmed_at:ACCEPTED_AT};
 assert.equal(verifyCaravelProviderDispatchMayStart(booking).ok,true);
 for(const changes of [
  {caravel_stripe_payment_confirmed_at:null},{status:"awaiting_payment"},
  {api_status:"pending"},{api_booking_reference:"external-id"},
  {manual_review:true},{cancelled_at:"2026-11-18"},
 ]){
  const r=verifyCaravelProviderDispatchMayStart({...booking,...changes});
  assert.equal(r.ok,false,JSON.stringify(changes));
 }
});
test("Caravel voucher requires persisted supplier confirmation and a paid booking",()=>{
 const confirmed={...b(),status:"paid",api_status:"confirmed",
  api_booking_reference:"caravel-external-uuid",caravel_stripe_payment_confirmed_at:ACCEPTED_AT};
 assert.equal(canReleaseCaravelVoucher(confirmed),true);
 for(const changes of [
  {api_booking_reference:null},{api_status:CARAVEL_PAID_AWAITING_SUPPLIER},
  {status:"pending"},{manual_review:true},
  {caravel_stripe_payment_confirmed_at:null},{cancelled_at:"2026-11-18"},
 ]){
  assert.equal(canReleaseCaravelVoucher({...confirmed,...changes}),false);
 }
});

test("missing or malformed server payment timestamp blocks NEW Caravel payment",()=>{
 for(const v of [undefined,null,false,"2026-01-01","bad"]){
  const r=verifyCaravelPaidCheckoutForSupplierQueue(b(),s(),v);
  assert.equal(r.ready,false);
  assert.equal(r.reason,"CARAVEL_STRIPE_SERVER_TIMESTAMP_REQUIRED");
 }
});
