import test from "node:test";
import assert from "node:assert/strict";
import {processVerifiedCaravelPaidBooking,processPersistedCaravelPaidBooking}
 from "../supabase/functions/_shared/caravel-paid-orchestration.ts";
import {canReleaseCaravelVoucher}
 from "../supabase/functions/_shared/caravel-payment-sequence.ts";

const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const QUOTE="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const REF="04a1f3e1-1fb4-4d28-af02-979604d5c622";
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const API_QUOTE="5dc264ef-743d-4aa9-8579-aa0a8dcb04b7";
const CAR_CLASS="d20bbca4-678c-4abf-bf4d-cf5356220170";
const CLIENT_ID="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const HASH="a".repeat(64);
const NOW=Date.now();
const stamp=(ms)=>new Date(ms).toISOString();
const meta=()=>({document_id:"caravel-en-v4",language:"en",version:4,
 title:"Caravel Rental Terms",format:"clauses/v1",content_hash:HASH,
 published_at:"2026-11-17T10:00:00Z",withdrawn_at:null});
const quote=()=>({provider:"caravel",quote_id:QUOTE,supplier_id:"acct_eur",
 vehicle_id:"opaque-veh",protection_id:"prot-premium",plan:"premium",
 currency:"EUR",payment_model:"pay_on_arrival",amounts:{total:150},
 amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},
 drivers:[{age:30,role:"main"}],
 expires_at:stamp(NOW+600000),
 terms_document_id:"caravel-en-v4",terms_content_hash:HASH,
 terms_language:"en"});
const zero=()=>({amount:0,currency:"EUR"});
const productionGate=()=>({certificationPassed:true,
 termsVerifiedAndShownBeforePayment:true,
 currentTermsDocumentId:"caravel-en-v4",termsDocumentIdShown:"caravel-en-v4",
 currentTermsContentHash:HASH,termsContentHashShown:HASH,
 currentTermsLanguage:"en",termsLanguageShown:"en",
 termsCanonicalHashVerified:true,
 protection:{tier:"premium",product_type:"waiver",
  deposit:zero(),excess:zero(),theft_excess:zero(),
  covers:["bodywork","theft","fire","glass","tyres_and_wheels","undercarriage"],
  excludes:[]},
 quoteDeposit:{amount:zero()},
 licencePolicy:{licence_rules:{min_years_held:1,
  international_permit_required_for:["non_eu_eea"]}},
 licenceEvidence:{firstIssuedOn:"2025-02-01",pickupOn:"2027-01-10",
  issuedInEuEea:true,hasInternationalDrivingPermit:false}});
const booking=()=>({
 id:ID,partner_id:PARTNER,client_id:CLIENT_ID,car_class_id:CAR_CLASS,
 api_quote_id:API_QUOTE,provider_type:"api",status:"pending",
 api_status:"caravel_paid_awaiting_supplier",
 manual_review:false,cancelled_at:null,api_booking_reference:null,
 stripe_session_id:"cs_test_verified",
 stripe_currency:"pln",stripe_amount_cents:3999,
 caravel_stripe_payment_confirmed_at:stamp(NOW-30000),
 caravel_supplier_dispatch_claimed_at:null,
 caravel_supplier_quote_id:QUOTE,caravel_supplier_id:"acct_eur",
 caravel_terms_document_id:"caravel-en-v4",
 caravel_terms_content_hash:HASH,caravel_terms_language:"en",
 terms_accepted:true,terms_accepted_at:stamp(NOW-40000),
 main_driver_name:"Jan Testowy",main_driver_age:30,
 add_driver_name:null,add_driver_age:null,
 client_email:"sandbox@example.test",client_phone:"+48 000 000 000",
 partner_net_price_snapshot:150,partner_currency:"EUR",
 partner_discount_snapshot:0,reservation_code:"R24-TEST",
 partners:{api_provider:"caravel",api_enabled:true,
 active:true,account_status:"active"},
});
const receipt=(amount=15000)=>({
 booking_id:REF,quote_id:QUOTE,revision:1,status:"confirmed",
 price:{totals:{grand_total:{amount,currency:"EUR"}}},
 protection:{deposit:zero(),excess:zero()},
 payment:{model:"pay_on_arrival",amount_prepaid:zero(),
  amount_on_arrival:{amount,currency:"EUR"}},
});
function database(){
 const storedQuote={
   id:API_QUOTE,booking_id:ID,partner_id:PARTNER,car_class_id:CAR_CLASS,
   external_group_id:"opaque-veh",external_quote_reference:QUOTE,
   partner_net_total:150,partner_discount_percent:0,currency:"EUR",
   expires_at:quote().expires_at,used_at:stamp(NOW-40000),
   raw_response:{caravel_quote:quote(),ride24_context:{}},
 };
 const state={booking:booking(),quote:storedQuote,reviews:[],bookingWrites:0,reviewWrites:0,
   cancelledDuringSupplier:false,failedReviewWrites:false};
 return {state,from(name){
  let payload=null,filters=[];
  const query={
   select:()=>query,
   update:p=>{payload=p;return query;},
   eq:(k,v)=>{filters.push([k,"eq",v]);return query;},
   is:(k,v)=>{filters.push([k,"is",v]);return query;},
   not:(k,op,v)=>{filters.push([k,"not_is",v]);return query;},
   limit:()=>query,
   maybeSingle:async()=>{
    const rows=name==="bookings"?[state.booking]:
     name==="api_quotes"?[state.quote]:state.reviews;
    const found=rows.find(row=>row&&filters.every(([k,op,v])=>{
     if(op==="eq")return row[k]===v;
     if(op==="is")return row[k]===null;
     return row[k]!==null;
    }));
    if(!found)return {data:null,error:null};
    if(payload){
     assert.equal(name,"bookings");
     state.booking={...found,...payload};
     state.bookingWrites++;
     return {data:{...state.booking},error:null};
    }
    return {data:{...found},error:null};
   },
   insert:async value=>{
    assert.equal(name,"booking_review_queue");
    if(state.failedReviewWrites)return {error:{code:"500"}};
    state.reviews.push({...value,id:"review"+state.reviews.length});
    state.reviewWrites++;
    return {error:null};
   },
  };
  return query;
 }};
}
function args(db,client,extra={}){
 const bookingInput={
  idempotency_key:`ride24:${ID}`,ride24_booking_id:ID,
  vehicle_group_id:"opaque-veh",
  main_driver:{name:"Jan Testowy",age:30},
  additional_driver:null,client_email:"sandbox@example.test",
  client_phone:"+48 000 000 000",
  currency:"EUR",partner_discount_percent:0,partner_amount:150,
  quote_reference:QUOTE,provider_quote_data:quote(),
 };
 return {admin:db,client,enableSupplierWrite:true,
  partnerApiEnabled:true,currentExternalReference:null,
  bookingInput,nowEpochMs:NOW,productionGate:productionGate(),
  reviewedTerms:{supplierId:"acct_eur",language:"en",
   documentId:"caravel-en-v4",version:4,contentHash:HASH,
   publishedAt:"2026-11-17T10:00:00Z"},
  currentTermsMetadataList:[meta()],
  persistedBookingTerms:{
   caravel_terms_document_id:"caravel-en-v4",
   caravel_terms_language:"en",caravel_terms_content_hash:HASH,
  },...extra,
 };
}
test("certified mock receipt persists ONE Caravel booking and permits voucher afterwards",async()=>{
 const db=database();let calls=0;
 const client={environment:"production",async book(){calls++;return {data:receipt()};}};
 const a=args(db,client);
 const [r1,r2]=await Promise.all([
  processVerifiedCaravelPaidBooking(a),processVerifiedCaravelPaidBooking(a),
 ]);
 assert.equal(r1.ok,true,JSON.stringify(r1));
 assert.equal(r1.status,"confirmed");
 assert.equal(r1.mayGenerateVoucher,true);
 assert.equal(r2.status,"skipped");
 assert.equal(calls,1);
 assert.equal(db.state.booking.status,"paid");
 assert.equal(db.state.booking.api_booking_reference,REF);
 assert.equal(db.state.reviewWrites,0);
 assert.equal(canReleaseCaravelVoucher({...db.state.booking,api_provider:"caravel"}),true);
});
test("ambiguous supplier POST automatically holds the paid booking in Ride24 review queue",async()=>{
 const db=database();let calls=0;
 const client={environment:"production",async book(){calls++;throw Error("timeout");}};
 const result=await processVerifiedCaravelPaidBooking(args(db,client));
 assert.equal(result.ok,false,JSON.stringify(result));
 assert.equal(result.status,"manual_review");
 assert.equal(result.mayGenerateVoucher,false);
 assert.equal(result.mayAutomaticallyRetry,false);
 assert.equal(calls,1);
 assert.equal(db.state.booking.status,"pending");
 assert.equal(db.state.booking.api_status,"caravel_manual_review_required");
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(db.state.reviews.length,1);
 assert.equal(JSON.parse(db.state.reviews[0].api_response).phase,
  "supplier_outcome_uncertain");
});
test("wrong supplier price holds the remote reference ONLY in admin review, never voucher",async()=>{
 const db=database();let calls=0;
 const client={environment:"production",async book(){calls++;return {data:receipt(15100)};}};
 const result=await processVerifiedCaravelPaidBooking(args(db,client));
 assert.equal(result.status,"manual_review",JSON.stringify(result));
 assert.equal(result.providerReference,REF);
 assert.equal(db.state.booking.api_booking_reference,null);
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(JSON.parse(db.state.reviews[0].api_response).external_reference,REF);
 assert.equal(calls,1);
});
test("cancellation while Caravel responds leaves cancellation and queues supplier reference for review",async()=>{
 const db=database();
 const client={environment:"production",async book(){
  db.state.booking.status="cancelled";
  db.state.booking.cancelled_at=stamp(NOW);
  return {data:receipt()};
 }};
 const result=await processVerifiedCaravelPaidBooking(args(db,client));
 assert.equal(result.status,"manual_review",JSON.stringify(result));
 assert.equal(result.providerReference,REF);
 assert.equal(db.state.booking.status,"cancelled");
 assert.equal(db.state.booking.api_booking_reference,null);
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(db.state.reviews.length,1);
 assert.equal(JSON.parse(db.state.reviews[0].api_response).phase,"confirmation");
});
test("new Caravel terms discovered before supplier POST queue review with zero remote calls",async()=>{
 const db=database();let calls=0;
 const client={environment:"production",async book(){calls++;throw Error("must not book");}};
 const newTerms={...meta(),version:5,document_id:"caravel-en-v5",
  content_hash:"b".repeat(64),published_at:"2026-11-18T10:00:00Z"};
 const result=await processVerifiedCaravelPaidBooking(args(db,client,{
  currentTermsMetadataList:[newTerms],
 }));
 assert.equal(result.status,"manual_review",JSON.stringify(result));
 assert.equal(calls,0);
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(db.state.booking.api_status,"caravel_manual_review_required");
});
test("review queue failure leaves paid Caravel booking locked, never auto retries or refunds",async()=>{
 const db=database();db.state.failedReviewWrites=true;
 const client={environment:"production",async book(){throw Error("timeout");}};
 const result=await processVerifiedCaravelPaidBooking(args(db,client));
 assert.equal(result.status,"hold_unqueued");
 assert.equal(db.state.booking.manual_review,true);
 assert.equal(result.mayGenerateVoucher,false);
 assert.equal(result.mayAutomaticallyRetry,false);
 assert.equal(result.mayAutomaticallyRefund,false);
});

test("REAL DATA PATH: supplier POST only after paid evidence is read from persisted booking+quote",async()=>{
 const db=database();let calls=0;
 const client={environment:"production",async book(payload,idempotency,supplier){
   calls++;assert.equal(supplier,"acct_eur");
   assert.equal(idempotency,ID);
   assert.equal(payload.quote_id,QUOTE);
   return {data:receipt()};
 }};
 const base=args(db,client);
 const result=await processPersistedCaravelPaidBooking({
  ...base,bookingId:ID,
  // untrusted runtime fields must be ignored by the hydrated wrapper:
  bookingInput:{...base.bookingInput,
    provider_quote_data:{...quote(),quote_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"}},
  persistedBookingTerms:null,
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(calls,1);
 assert.equal(db.state.booking.status,"paid");
 assert.equal(db.state.booking.api_booking_reference,REF);
 assert.equal(db.state.reviewWrites,0);
});
test("missing or tampered Caravel quote provenance stops BEFORE atomic claim and supplier POST",async()=>{
 for(const patch of [
   {raw_response:{ride24_context:{}}},
   {raw_response:{caravel_quote:{...quote(),supplier_id:"other"}}},
   {partner_net_total:200},
   {booking_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
 ]){
   const db=database(),client={environment:"production",
     async book(){throw Error("supplier must not be contacted");}};
   db.state.quote={...db.state.quote,...patch};
   const result=await processPersistedCaravelPaidBooking({
     ...args(db,client),bookingId:ID,
   });
   assert.equal(result.ok,false,JSON.stringify(patch));
   assert.equal(result.status,"hold_unqueued");
   assert.equal(db.state.booking.api_status,"caravel_paid_awaiting_supplier");
   assert.equal(db.state.bookingWrites,0);
 }
});
