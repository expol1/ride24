import test from "node:test";
import assert from "node:assert/strict";
import {persistCertifiedCaravelPendingBooking}
 from "../supabase/functions/_shared/caravel-booking-commit.ts";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../docs/integrations/caravel-atomic-pending-booking.sql",import.meta.url),"utf8");
test("live schema function called from worker is service-only, transactional and release-gated",()=>{
 assert.match(sql,/CREATE OR REPLACE FUNCTION public\.caravel_commit_pending_booking/);
 assert.match(sql,/SECURITY INVOKER/);
 assert.match(sql,/allow_customer_checkout boolean NOT NULL DEFAULT false/);
 assert.match(sql,/FOR UPDATE/);
 assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.caravel_commit_pending_booking\(uuid,uuid,jsonb\)\s+TO service_role/);
});
test("without authenticated and verified booking evidence RPC is never invoked",async()=>{
 let calls=0;
 const admin={async rpc(){calls++;throw Error("Must not write");}};
 const r=await persistCertifiedCaravelPendingBooking({
   admin,trustedInput:{
     authenticatedClientId:"bad",preflight:{nowEpochMs:1900000000000},
     storedQuote:{},
   },
 });
 assert.equal(r.ok,false);
 assert.equal(r.stripeAllowed,false);
 assert.equal(r.retrySupplierBooking,false);
 assert.equal(calls,0);
});
test("bad or missing RPC server rejects without exposing secret or starting Stripe",async()=>{
 const a=await persistCertifiedCaravelPendingBooking({
   admin:null,trustedInput:null,
 });
 assert.equal(a.ok,false);
 assert.equal(a.stripeAllowed,false);
});
