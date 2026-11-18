import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../docs/integrations/caravel-paid-dispatch-claim.sql",import.meta.url),"utf8");
const withoutComments=sql.replace(/--[^\n]*/g,"");
test("Caravel paid claim schema is a single recorded additive transaction",()=>{
 assert.match(sql,/APPLIED \(SCHEMA ONLY\)/);
 assert.equal((withoutComments.match(/\bBEGIN\s*;/g)||[]).length,1);
 assert.equal((withoutComments.match(/\bCOMMIT\s*;/g)||[]).length,1);
 assert.equal((withoutComments.match(/ADD COLUMN IF NOT EXISTS/g)||[]).length,4);
 assert.equal((withoutComments.match(/ADD CONSTRAINT bookings_caravel_claim_consistency_chk/g)||[]).length,1);
 assert.doesNotMatch(withoutComments,/\bDROP\s+TABLE\b|\bGRANT\b|\bSECURITY DEFINER\b/i);
});
test("claimed Caravel dispatch requires complete payment, supplier and terms proof",()=>{
 for(const x of [
  "caravel_supplier_quote_id","caravel_supplier_id",
  "caravel_stripe_payment_confirmed_at","caravel_supplier_dispatch_claimed_at",
  "stripe_session_id IS NOT NULL","caravel_terms_document_id IS NOT NULL",
  "caravel_terms_content_hash IS NOT NULL",
  "caravel_terms_language IS NOT NULL",
  "caravel_supplier_dispatch_claimed_at >= caravel_stripe_payment_confirmed_at",
 ])assert.ok(withoutComments.includes(x),x);
 assert.match(withoutComments,/api_status IS DISTINCT FROM 'caravel_supplier_dispatch_claimed'/);
 assert.match(withoutComments,/OR COALESCE\(\(/);
 assert.match(withoutComments,/\), FALSE\)/);
 assert.match(withoutComments,/partner_id\s*=\s*'78721481-7619-44df-a9b7-5faa344b69bb'::uuid/);
});
test("migration does not change existing providers and requires service-role compare-and-swap",()=>{
 assert.match(sql,/Existing non-Caravel rows keep all four fields NULL/);
 assert.match(sql,/api_status='caravel_paid_awaiting_supplier'/);
 assert.match(sql,/Exactly one row = winner/);
 assert.match(sql,/NEVER automatically issue another booking/);
});

test("Caravel claim CHECK permits cancellation or manual review after supplier POST",()=>{
 const after=withoutComments.split("ADD CONSTRAINT bookings_caravel_claim_consistency_chk")[1];
 assert.ok(after,"expected claim integrity constraint");
 const check=after.split("$caravel_claim$")[0];
 for(const mutable of [
  "AND status = 'pending'","AND manual_review IS FALSE",
  "AND cancelled_at IS NULL","AND api_booking_reference IS NULL",
 ]) assert.ok(!check.includes(mutable),mutable);
 assert.match(sql,/cancellation\/reconciliation may happen while a/);
});
test("only Caravel supplier review tickets get a unique database fence",()=>{
 assert.match(withoutComments,/CREATE UNIQUE INDEX IF NOT EXISTS booking_review_queue_caravel_supplier_review_uq/);
 assert.match(withoutComments,/ON public\.booking_review_queue \(booking_id\)/);
 assert.match(withoutComments,/WHERE provider_key='caravel' AND provider_status='supplier_manual_review'/);
});
