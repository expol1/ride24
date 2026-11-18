import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {isCaravelBooking,CARAVEL_PRE_CERTIFICATION_ERROR}
 from "../supabase/functions/_shared/caravel-production-hold.mjs";
const CID="78721481-7619-44df-a9b7-5faa344b69bb";
test("Caravel partner is held under custom and future caravel API provider",()=>{
 assert.equal(isCaravelBooking({partner_id:CID,partners:{api_provider:"custom"}}),true);
 assert.equal(isCaravelBooking({partner_id:CID}),true);
 assert.equal(isCaravelBooking({partner_id:"other",partners:{api_provider:"caravel"}}),true);
 assert.equal(isCaravelBooking({partners:[{api_provider:"caravel"}]}),true);
 assert.equal(CARAVEL_PRE_CERTIFICATION_ERROR,"CARAVEL_CERTIFICATION_PENDING");
});
test("other API providers and local rentals are not held",()=>{
 for(const data of [null,{},{partner_id:"other",partners:{api_provider:"renteon_aggregator"}},{partners:[{api_provider:"renteon"}]},{partner_id:"other",partners:{api_provider:"custom"}}])
  assert.equal(isCaravelBooking(data),false);
});
test("Caravel checkout blocked after owner check but before Stripe session",()=>{
 const src=readFileSync(new URL("../supabase/functions/create_checkout_session/index.ts",import.meta.url),"utf8");
 const a=src.indexOf('booking.client_id !== user.id');
 const b=src.indexOf('if (isCaravelBooking(booking))');
 const c=src.indexOf('stripe.checkout.sessions.create');
 assert.ok(a>=0&&b>a&&c>b);
 assert.ok(src.includes("partners!bookings_partner_id_fkey(api_provider)"));
});
test("Caravel signed payment is routed to review before normal paid/voucher",()=>{
 const src=readFileSync(new URL("../supabase/functions/stripe-webhook/index.ts",import.meta.url),"utf8");
 const a=src.indexOf('event.type === "checkout.session.completed"');
 const b=src.indexOf('if (isCaravelBooking(existing))');
 const c=src.indexOf('if (existing?.status === "paid")');
 const d=src.indexOf('Triggering generate-voucher');
 assert.ok(a>=0&&b>a&&c>b&&d>c);
 assert.ok(src.includes('return await holdUncertifiedCaravelPayment(bookingId, session, event.id)'));
 assert.ok(src.includes('manual_review:true,api_status:"caravel_payment_not_certified"'));
});
