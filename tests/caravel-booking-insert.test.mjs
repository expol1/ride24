import test from "node:test";
import assert from "node:assert/strict";
import {buildCertifiedCaravelBookingInsert}
 from "../supabase/functions/_shared/caravel-booking-insert.ts";
const NOW=1900000000000,DOC="caravel-en-v4",HASH="a".repeat(64);
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const Q="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const API="5dc264ef-743d-4aa9-8579-aa0a8dcb04b7";
const CLS="d20bbca4-678c-4abf-bf4d-cf5356220170";
const USER="0138fbc3-5ebf-4e37-b27c-87df3de44c12";
const PICKUP="0aa18fda-4e7c-4b31-98b9-480d53e086e8";
const DROPOFF="be45cfec-3fa6-49a5-9b37-a83ff9ed81e2";
const zeros=()=>({amount:0,currency:"EUR"});
const md=()=>({document_id:DOC,language:"en",version:4,title:"Caravel Terms",
 format:"clauses/v1",content_hash:HASH,published_at:"2026-11-17T10:00:00Z",withdrawn_at:null});
function setup(){
 const protection={tier:"premium",product_type:"waiver",deposit:zeros(),
 excess:zeros(),theft_excess:zeros(),
 covers:["bodywork","theft","fire","glass","tyres_and_wheels","undercarriage"],
 excludes:[]};
 const quote={provider:"caravel",quote_id:Q,supplier_id:"acct_eur",
 plan:"premium",expires_at:new Date(NOW+90*60*1000).toISOString(),
 terms_document_id:DOC,terms_content_hash:HASH,terms_language:"en",
 payment_model:"pay_on_arrival",currency:"EUR",vehicle_id:"opaque-group",
 amounts:{total:150},amounts_minor:{total:15000,pay_now:0,pay_at_pickup:15000},
 protection};
 const preflight={
  serverPartnerApiEnabled:true,serverQuoteUnused:true,
  serverCurrentTermsBodyRendered:true,serverCanonicalHashVerified:true,
  serverExpectedPartnerAmountMinor:15000,serverQuote:quote,
  serverReviewedTerms:{supplierId:"acct_eur",language:"en",documentId:DOC,
   version:4,contentHash:HASH,publishedAt:md().published_at},
  serverCurrentTermsMetadataList:[md()],serverProtection:protection,
  serverQuoteDeposit:{amount:zeros()},
  serverLicencePolicy:{licence_rules:{min_years_held:1,
   international_permit_required_for:["non_eu_eea"]}},
  serverLicenceEvidence:{firstIssuedOn:"2025-02-01",pickupOn:"2027-01-10",
   issuedInEuEea:true,hasInternationalDrivingPermit:false},
  nowEpochMs:NOW,customerAcceptedTerms:true,displayedTermsDocumentId:DOC,
 };
 const storedQuote={
  id:API,partner_id:PARTNER,car_class_id:CLS,used_at:null,booking_id:null,
  start_date:"2027-01-10",end_date:"2027-01-13",
  partner_net_total:150,commission_total:15,final_total:165,
  partner_discount_percent:0,platform_margin_percent:10,
  currency:"EUR",expires_at:quote.expires_at,
  external_group_id:"opaque-group",external_quote_reference:Q,
  raw_response:{provider_quote_data:quote,ride24_context:{
   version:1,pickup_time:"10:00:00",return_time:"10:00:00",
   pickup_location:"Athens Airport",return_location:"Athens Airport",
  }},
 };
 return {storedQuote,preflight,authenticatedClientId:USER,selectedClassId:CLS,
 pickupLocationId:PICKUP,dropoffLocationId:DROPOFF,
 startDate:"2027-01-10",endDate:"2027-01-13",
 pickupTime:"10:00",returnTime:"10:00",
 pickupName:"Athens Airport",returnName:"Athens Airport",
 exchangeRatePln:4.2,reservationFeePln:63,
 mainDriverName:"Jan Testowy",mainDriverAge:30,
 clientEmail:"sandbox@example.test",clientPhone:"+48000000000"};
}
test("Caravel insertion snapshot is Stripe-first, includes full supplier evidence and excludes premature dispatch",()=>{
 const a=setup(),r=buildCertifiedCaravelBookingInsert(a);
 assert.equal(r.ok,true,JSON.stringify(r));
 const b=r.payload;
 assert.equal(b.status,"awaiting_payment");
 assert.equal(b.api_status,"caravel_awaiting_stripe");
 assert.equal(b.api_quote_id,API);
 assert.equal(b.caravel_supplier_quote_id,Q);
 assert.equal(b.caravel_supplier_id,"acct_eur");
 assert.equal(b.caravel_terms_document_id,DOC);
 assert.equal(b.caravel_terms_content_hash,HASH);
 assert.equal(b.online_payment_pln,63);
 assert.equal(b.pickup_payment_partner_currency,150);
 assert.equal(b.client_id,USER);
 assert.equal(b.api_booking_reference,undefined);
 assert.equal(b.caravel_stripe_payment_confirmed_at,undefined);
 assert.equal(b.terms_accepted,true);
});
test("tampered provider scope, quote binding, used/expired offer and wrong context block before any booking",()=>{
 for(const p of [
  {partner_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
  {car_class_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
  {used_at:new Date(NOW).toISOString()},
  {booking_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
  {expires_at:new Date(NOW-1000).toISOString()},
  {external_quote_reference:"bad"},
  {external_group_id:"other-class"},
 ]){
  const a=setup();
  a.storedQuote={...a.storedQuote,...p};
  assert.equal(buildCertifiedCaravelBookingInsert(a).ok,false,JSON.stringify(p));
 }
 const a=setup();a.pickupName="Wrong airport";
 assert.equal(buildCertifiedCaravelBookingInsert(a).ok,false);
});
test("no user consent, stale terms, prepaid supplier quote or invalid licence can create booking",()=>{
 for(const p of [
  {customerAcceptedTerms:false},
  {serverCanonicalHashVerified:false},
  {serverCurrentTermsMetadataList:[{...md(),document_id:"caravel-en-v5",version:5}]},
  {serverLicenceEvidence:{firstIssuedOn:"2026-12-01",pickupOn:"2027-01-10",
   issuedInEuEea:true,hasInternationalDrivingPermit:false}},
 ]){
  const a=setup();a.preflight={...a.preflight,...p};
  assert.equal(buildCertifiedCaravelBookingInsert(a).ok,false,JSON.stringify(p));
 }
});
test("Ride24 separate Stripe fee must match supplier on-arrival amount and global margin",()=>{
 for(const p of [
  {partner_net_total:149},{commission_total:0},{final_total:150},
  {platform_margin_percent:20},{currency:"GBP"},
 ]){
  const a=setup();a.storedQuote={...a.storedQuote,...p};
  assert.equal(buildCertifiedCaravelBookingInsert(a).ok,false,JSON.stringify(p));
 }
 const a=setup();a.reservationFeePln=0;
 assert.equal(buildCertifiedCaravelBookingInsert(a).ok,false);
});
