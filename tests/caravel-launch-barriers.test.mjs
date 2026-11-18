import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const load=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("generic booking rejects Caravel before claiming quote or saving a booking",()=>{
 const src=load("supabase/functions/create-booking-request/index.ts");
 const loadCar=src.indexOf("const car = normalizeCar(rawCar)");
 const guard=src.indexOf("if (isCaravelBooking({");
 const quote=src.indexOf("quoteClaim = await claimApiQuote(");
 const insert=src.indexOf('.from("bookings")\n      .insert(insertPayload)');
 const provider=src.indexOf("await dispatchApiBooking(bookingId)");
 // main moved API bookings to Stripe-first: the handler no longer dispatches
 // to the supplier at all (provider === -1). If it ever does again, it must be after the guard.
 assert.ok(loadCar>=0&&guard>loadCar&&quote>guard&&insert>guard&&(provider===-1||provider>guard));
 assert.match(src,/api_provider,\s*rental_terms_url,/);
 assert.match(src,/code: CARAVEL_PRE_CERTIFICATION_ERROR/);
});
test("Caravel is removed from results BEFORE any supplier quote call",()=>{
 const src=load("supabase/functions/search-api/index.ts");
 const map=src.indexOf("const uniquePartners = new Map");
 const guard=src.indexOf("if (isCaravelBooking({partner_id: partnerId");
 const provider=src.indexOf("return await searchPartner(");
 assert.ok(map>=0&&guard>map&&provider>guard);
 assert.match(src,/uniquePartners.delete\(partnerId\)/);
});
test("generic dispatcher blocks Caravel before calling common provider adapter",()=>{
 const src=load("supabase/functions/api-booking-dispatch/index.ts");
 const normalize=src.indexOf("const booking = normalizeBooking(rawBooking)");
 const guard=src.indexOf("if (isCaravelBooking({");
 const supplier=src.indexOf("responsePayload = await createProviderBooking(");
 assert.ok(normalize>=0&&guard>normalize&&supplier>guard);
 assert.match(src,/code: CARAVEL_PRE_CERTIFICATION_ERROR/);
});
test("all four independent launch holds use the SAME Caravel partner identity",()=>{
 const helper=load("supabase/functions/_shared/caravel-production-hold.mjs");
 assert.match(helper,/78721481-7619-44df-a9b7-5faa344b69bb/);
 for(const p of [
  "supabase/functions/create-booking-request/index.ts",
  "supabase/functions/search-api/index.ts",
  "supabase/functions/api-booking-dispatch/index.ts",
  "supabase/functions/create_checkout_session/index.ts",
  "supabase/functions/stripe-webhook/index.ts",
 ]) assert.match(load(p),/isCaravelBooking/);
});
