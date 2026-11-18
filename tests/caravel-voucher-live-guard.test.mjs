import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canReleaseCaravelVoucher}
 from "../supabase/functions/_shared/caravel-payment-sequence.ts";
import {isCaravelBooking}
 from "../supabase/functions/_shared/caravel-production-hold.mjs";
const source=readFileSync(new URL("../supabase/functions/generate-voucher/index.ts",import.meta.url),"utf8");
const partnerId="78721481-7619-44df-a9b7-5faa344b69bb";
const id="d9bb87e8-71cc-43a2-bd09-a487639acd14";
const confirmed=()=>({
 id,partner_id:partnerId,provider_type:"api",api_provider:"caravel",
 status:"paid",api_status:"confirmed",
 api_booking_reference:"partner-verified-ref",
 cancelled_at:null,manual_review:false,
 caravel_stripe_payment_confirmed_at:"2026-11-18T12:00:00.000Z",
});
test("real voucher Edge function reads persisted Caravel supplier and payment evidence",()=>{
 for(const field of [
 "partner_id","provider_type","api_status","api_booking_reference",
 "cancelled_at","manual_review","caravel_stripe_payment_confirmed_at",
 "api_provider",
 ]) assert.match(source,new RegExp("\\b"+field+"\\b"));
 assert.match(source,/import \{canReleaseCaravelVoucher\}/);
 assert.match(source,/import \{isCaravelBooking\}/);
 assert.match(source,/CARAVEL_SUPPLIER_CONFIRMATION_REQUIRED/);
 const gate=source.indexOf("if(isCaravelBooking(booking)&&!canReleaseCaravelVoucher(booking))");
 const payment=source.indexOf("if (!(await hasPaidPayment(admin, booking.id)))");
 const claim=source.indexOf("const claim = await claimVoucherGeneration(admin, booking.id)");
 const email=source.indexOf("await queueConfirmationEmail(admin, booking.id)");
 assert.ok(gate>0&&payment>gate&&claim>payment&&email>claim,
  "supplier guard MUST precede payment, voucher claim, and customer email");
});
test("Caravel-only voucher guard rejects unconfirmed, held, unpaid, canceled supplier bookings",()=>{
 const invalid=[
 {api_status:"caravel_supplier_dispatch_claimed"},
 {api_status:"caravel_manual_review_required"},
 {api_status:"caravel_paid_awaiting_supplier"},
 {api_booking_reference:null},{manual_review:true},
 {status:"pending"},{cancelled_at:"2026-11-18T12:00:01Z"},
 {caravel_stripe_payment_confirmed_at:null},{provider_type:"local"},
 ];
 for(const patch of invalid){
  const b={...confirmed(),...patch};
  assert.equal(isCaravelBooking(b),true);
  assert.equal(canReleaseCaravelVoucher(b),false,JSON.stringify(patch));
 }
 assert.equal(canReleaseCaravelVoucher(confirmed()),true);
});
test("fixed Caravel partner id remains guarded even while API provider is custom or unconfigured",()=>{
 const row={...confirmed(),api_provider:"custom"};
 assert.equal(isCaravelBooking(row),true);
 assert.equal(canReleaseCaravelVoucher(row),false);
 assert.equal(isCaravelBooking({
  partner_id:"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",partners:{api_provider:"avia"}
 }),false);
});
