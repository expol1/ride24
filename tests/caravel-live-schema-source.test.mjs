import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const file=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const terms=file("docs/integrations/caravel-terms-booking-snapshot.sql");
const claim=file("docs/integrations/caravel-paid-dispatch-claim.sql");
const migration=file("supabase/migrations/20261118124748_caravel_booking_evidence_additive_20261118.sql");
const ddl=txt=>{
 const m=txt.match(/\nBEGIN;\n([\s\S]*?)\nCOMMIT;/);
 assert.ok(m,"SQL source has complete original transactional body");
 return m[1];
};
test("applied additive Caravel production migration is committed verbatim from reviewed source",()=>{
 assert.ok(migration.includes(ddl(terms)));
 assert.ok(migration.includes(ddl(claim)));
 assert.equal((migration.match(/ADD COLUMN IF NOT EXISTS/g)||[]).length,14);
 assert.equal((migration.match(/ADD CONSTRAINT bookings_caravel_/g)||[]).length,3);
 assert.equal((migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS booking_review_queue_caravel_supplier_review_uq/g)||[]).length,1);
 assert.doesNotMatch(migration,/\bDROP\s+(COLUMN|TABLE|CONSTRAINT)|\bGRANT\s+|\bSECURITY DEFINER\b/i);
});
test("applied Caravel schema never enables partner or customer checkout",()=>{
 assert.doesNotMatch(migration,/\bUPDATE\s+public\.partners\b/i);
 assert.doesNotMatch(migration,/\bINSERT\s+INTO\s+public\.bookings\b/i);
 assert.doesNotMatch(migration,/\bCREATE\s+FUNCTION\b/i);
 assert.match(terms,/APPLIED \(SCHEMA ONLY\)/);
 assert.match(claim,/APPLIED \(SCHEMA ONLY\)/);
});
