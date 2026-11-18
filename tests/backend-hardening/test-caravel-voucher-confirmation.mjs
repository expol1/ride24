import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {isCaravelVoucherBooking,isCaravelVoucherAllowed}
 from "../../supabase/functions/_shared/caravel-voucher-confirmation-guard.mjs";
const PID="78721481-7619-44df-a9b7-5faa344b69bb";
const ID="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const QUOTE="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const REF="04a1f3e1-1fb4-4d28-af02-979604d5c622";
function booking(){
 return {
  id:ID,partner_id:PID,provider_type:"api",api_provider:"caravel",
  status:"paid",api_status:"confirmed",manual_review:false,cancelled_at:null,
  api_booking_reference:REF,stripe_session_id:"cs_live_verified",
  stripe_currency:"pln",stripe_amount_cents:3999,
  caravel_stripe_payment_confirmed_at:"2026-11-18T12:00:00.000Z",
  caravel_supplier_dispatch_claimed_at:"2026-11-18T12:00:01.000Z",
  caravel_supplier_quote_id:QUOTE,caravel_supplier_id:"acct_eur",
  caravel_terms_document_id:"caravel-en-v4",
  caravel_terms_content_hash:"a".repeat(64),caravel_terms_language:"en",
  terms_accepted:true,terms_accepted_at:"2026-11-18T11:50:00.000Z",
 };
}
test("verified Stripe paid and exact supplier confirmation permits Caravel voucher",()=>{
 assert.equal(isCaravelVoucherBooking(booking()),true);
 assert.equal(isCaravelVoucherAllowed(booking()),true);
});
test("each missing, untrusted, canceled or review-held Caravel proof blocks voucher and email",()=>{
 const cases=[
  {provider_type:"local"},{api_provider:"custom"},{status:"pending"},
  {api_status:"caravel_paid_awaiting_supplier"},
  {api_status:"caravel_supplier_dispatch_claimed"},
  {api_status:"caravel_manual_review_required"},{manual_review:true},
  {cancelled_at:"2026-11-18T12:00:02.000Z"},
  {api_booking_reference:null},{api_booking_reference:"fake"},
  {stripe_session_id:null},{stripe_currency:"eur"},
  {stripe_amount_cents:0},{caravel_stripe_payment_confirmed_at:null},
  {caravel_supplier_dispatch_claimed_at:null},
  {caravel_supplier_quote_id:null},{caravel_supplier_id:"bad supplier"},
  {caravel_terms_document_id:null},{caravel_terms_content_hash:"bad"},
  {caravel_terms_language:null},{terms_accepted:false},
  {terms_accepted_at:null},
 ];
 for(const patch of cases){
  const b={...booking(),...patch};
  assert.equal(isCaravelVoucherBooking(b),true,JSON.stringify(patch));
  assert.equal(isCaravelVoucherAllowed(b),false,JSON.stringify(patch));
 }
});
test("fixed Caravel partner is blocked even while provider remains custom",()=>{
 const b={...booking(),api_provider:"custom"};
 assert.equal(isCaravelVoucherBooking(b),true);
 assert.equal(isCaravelVoucherAllowed(b),false);
});
test("other Ride24 partner vouchers remain on their existing payment guards",()=>{
 const b={...booking(),partner_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  api_provider:"avia",status:"paid",api_booking_reference:null};
 assert.equal(isCaravelVoucherBooking(b),false);
 assert.equal(isCaravelVoucherAllowed(b),true);
});
test("live voucher generator has early provider gate before ANY claim or email",()=>{
 const code=readFileSync(new URL("../../supabase/functions/generate-voucher/index.ts",import.meta.url),"utf8");
 const gate=code.indexOf("if(isCaravelVoucherBooking(booking)&&!isCaravelVoucherAllowed(booking))");
 const paid=code.indexOf('if (booking.status !== "paid")');
 const claim=code.indexOf("const claim = await claimVoucherGeneration(admin, booking.id)");
 const email=code.indexOf("await queueConfirmationEmail(admin, booking.id)");
 assert.ok(gate>0&&gate<paid&&paid<claim&&claim<email);
 for(const key of ["caravel_stripe_payment_confirmed_at","caravel_supplier_dispatch_claimed_at",
  "caravel_terms_document_id","api_booking_reference","api_provider"])
  assert.ok(code.includes(key));
});
