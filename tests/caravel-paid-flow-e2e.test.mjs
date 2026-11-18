import test from "node:test";
import assert from "node:assert/strict";
import {recordVerifiedCaravelStripePayment}
 from "../supabase/functions/_shared/caravel-payment-commit.ts";
import {claimAndSubmitVerifiedCaravelBooking}
 from "../supabase/functions/_shared/caravel-provider-bridge.ts";
import {commitVerifiedCaravelSupplierConfirmation}
 from "../supabase/functions/_shared/caravel-confirmation-commit.ts";
import {canReleaseCaravelVoucher}
 from "../supabase/functions/_shared/caravel-payment-sequence.ts";

const B="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const C="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const RQ="fbe91368-e1f0-4a3a-a939-e2949b2ca212";
const Q="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const R="04a1f3e1-1fb4-4d28-af02-979604d5c622";
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const H="a".repeat(64);
const NOW=Date.now();
const NOW_ISO=new Date(NOW).toISOString();
const terms=()=>({
 document_id:"caravel-en-v4",language:"en",version:4,title:"Caravel Rental Terms",
 format:"clauses/v1",content_hash:H,published_at:"2026-11-17T10:00:00Z",
 withdrawn_at:null,
});
const quote=()=>({
 provider:"caravel",quote_id:Q,supplier_id:"acct_eur",
 vehicle_id:"opaque-veh",protection_id:"prot-premium",plan:"premium",
 payment_model:"pay_on_arrival",currency:"EUR",
 amounts:{total:150},amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},
 drivers:[{age:30,role:"main"}],expires_at:new Date(NOW+600000).toISOString(),
 terms_document_id:terms().document_id,terms_content_hash:H,terms_language:"en",
});
const zero=()=>({amount:0,currency:"EUR"});
const gate=()=>({
 certificationPassed:true,termsVerifiedAndShownBeforePayment:true,
 currentTermsDocumentId:terms().document_id,
 termsDocumentIdShown:terms().document_id,
 currentTermsContentHash:H,termsContentHashShown:H,
 currentTermsLanguage:"en",termsLanguageShown:"en",
 termsCanonicalHashVerified:true,
 protection:{tier:"premium",product_type:"waiver",deposit:zero(),excess:zero(),
   theft_excess:zero(),
   covers:["bodywork","theft","fire","glass","tyres_and_wheels","undercarriage"],
   excludes:[]},
 quoteDeposit:{amount:zero()},
 licencePolicy:{licence_rules:{min_years_held:1,
   international_permit_required_for:["non_eu_eea"]}},
 licenceEvidence:{firstIssuedOn:"2025-02-01",pickupOn:"2027-01-10",
   issuedInEuEea:true,hasInternationalDrivingPermit:false},
});
const input=()=>({
 idempotency_key:`ride24:${B}`,ride24_booking_id:B,
 vehicle_group_id:"opaque-veh",
 main_driver:{name:"Jan Testowy",age:30},
 additional_driver:null,client_email:"sandbox@example.test",
 client_phone:"+48 000 000 000",currency:"EUR",
 partner_discount_percent:0,partner_amount:150,quote_reference:Q,
 provider_quote_data:quote(),
});
const reviewed=()=>({
 supplierId:"acct_eur",language:"en",documentId:terms().document_id,
 version:4,contentHash:H,publishedAt:terms().published_at,
});
const bookingSnapshot=()=>({
 caravel_terms_document_id:terms().document_id,
 caravel_terms_language:"en",caravel_terms_content_hash:H,
});
const booking=()=>({
 id:B,client_id:C,partner_id:PARTNER,provider_type:"api",
 status:"awaiting_payment",api_status:null,api_booking_reference:null,
 cancelled_at:null,manual_review:false,
 online_payment_pln:39.99,stripe_session_id:"cs_test_full",
 stripe_currency:null,stripe_amount_cents:null,api_quote_id:RQ,
 caravel_supplier_quote_id:Q,caravel_supplier_id:"acct_eur",
 ...bookingSnapshot(),
 caravel_stripe_payment_confirmed_at:null,
 caravel_supplier_dispatch_claimed_at:null,
 partners:{api_provider:"caravel",api_enabled:true},
});
const event=()=>({type:"checkout.session.completed",data:{object:{
 id:"cs_test_full",client_reference_id:B,
 metadata:{booking_id:B,client_id:C},
 status:"complete",payment_status:"paid",currency:"pln",amount_total:3999,
}}});
const receipt=()=>({
 booking_id:R,revision:1,quote_id:Q,status:"confirmed",
 price:{totals:{grand_total:{amount:15000,currency:"EUR"}}},
 protection:{deposit:zero(),excess:zero()},
 payment:{model:"pay_on_arrival",amount_prepaid:zero(),
   amount_on_arrival:{amount:15000,currency:"EUR"}},
});
function database(start=booking()){
 const state={row:start,writes:0};
 return {state,from(table){
  assert.equal(table,"bookings");
  const predicates=[],q={
   select:()=>q,update:p=>{q.payload=p;return q;},
   eq:(k,v)=>{predicates.push([k,"eq",v]);return q;},
   is:(k,v)=>{predicates.push([k,"is",v]);return q;},
   not:(k,op,v)=>{predicates.push([k,"not_is",v]);return q;},
   maybeSingle:async()=>{
    const r=state.row;
    if(!r||predicates.some(([k,op,v])=>
      op==="eq"?r[k]!==v:op==="is"?r[k]!==null:r[k]===null))
      return {data:null,error:null};
    if(q.payload){state.row={...r,...q.payload};state.writes++;}
    return {data:q.payload?{...state.row}:{...r},error:null};
   },
  };
  return q;
 }};
}
test("E2E SIMULATION: verified Stripe -> queue -> atomic supplier create -> confirmed paid -> voucher",async()=>{
 const db=database();
 let providerCalls=0;
 const client={environment:"production",async book(payload,key,supplier){
   providerCalls++;
   assert.equal(key,B);assert.equal(supplier,"acct_eur");
   assert.equal(payload.quote_id,Q);
   assert.equal(payload.payment_model,"pay_on_arrival");
   return {data:receipt()};
 }};
 const paymentArgs={admin:db,rawBody:"signed fixture",
   stripeSignature:"t=123,v1=valid",
   constructVerifiedEvent:async()=>event(),
   providerQuote:quote(),nowIso:NOW_ISO};
 const p1=await recordVerifiedCaravelStripePayment(paymentArgs);
 assert.equal(p1.ok,true,JSON.stringify(p1));
 assert.equal(db.state.row.api_status,"caravel_paid_awaiting_supplier");
 assert.equal(canReleaseCaravelVoucher({...db.state.row,api_provider:"caravel"}),false);
 const duplicate=await recordVerifiedCaravelStripePayment(paymentArgs);
 assert.equal(duplicate.action,"already_queued");
 const dispatchArgs={
   client,admin:db,enableSupplierWrite:true,partnerApiEnabled:true,
   currentExternalReference:null,bookingInput:input(),nowEpochMs:NOW,
   productionGate:gate(),reviewedTerms:reviewed(),
   currentTermsMetadataList:[terms()],
   persistedBookingTerms:bookingSnapshot(),
 };
 const [a,b]=await Promise.all([
   claimAndSubmitVerifiedCaravelBooking(dispatchArgs),
   claimAndSubmitVerifiedCaravelBooking(dispatchArgs),
 ]);
 assert.equal(a.ok,true,JSON.stringify(a));
 assert.equal(b.ok,false,JSON.stringify(b));
 assert.equal(providerCalls,1);
 assert.equal(db.state.row.api_status,"caravel_supplier_dispatch_claimed");
 assert.equal(canReleaseCaravelVoucher({...db.state.row,api_provider:"caravel"}),false);
 const confirmed=await commitVerifiedCaravelSupplierConfirmation({
   admin:db,bookingId:B,paidClaim:{...db.state.row,api_provider:"caravel"},
   verifiedProviderResult:a.result,nowIso:NOW_ISO,
 });
 assert.equal(confirmed.ok,true,JSON.stringify(confirmed));
 assert.equal(confirmed.releaseVoucher,true);
 assert.equal(db.state.row.status,"paid");
 assert.equal(db.state.row.api_booking_reference,R);
 assert.equal(canReleaseCaravelVoucher({...db.state.row,api_provider:"caravel"}),true);
 const lateDuplicate=await recordVerifiedCaravelStripePayment(paymentArgs);
 assert.equal(lateDuplicate.action,"already_completed");
 assert.equal(providerCalls,1);
});
