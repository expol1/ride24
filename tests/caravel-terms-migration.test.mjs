import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../docs/integrations/caravel-terms-booking-snapshot.sql",import.meta.url),"utf8");

// This is a DRAFT migration structural regression check, NOT a PostgreSQL
// syntax execution or permission to apply a migration to production.
// Prior draft corruption split CHECK regex strings and duplicated COMMITs.
function strippedStatements(source) {
  let s=source.replace(/--[^\n]*/g,"");
  s=s.replace(/'(?:''|[^'])*'/g,"''");
  return s;
}

test("Caravel terms SQL proposal is a single complete transaction, never repeated or truncated",()=>{
  const clean=strippedStatements(sql);
  assert.match(sql,/DRAFT ONLY|PROPOSAL ONLY/);
  assert.equal((clean.match(/\bBEGIN\s*;/g)||[]).length,1);
  assert.equal((clean.match(/\bCOMMIT\s*;/g)||[]).length,1);
  assert.equal((clean.match(/\bDO\s+\$caravel_terms\$/g)||[]).length,1);
  assert.equal((clean.match(/\$caravel_terms\s*;/g)||[]).length,1);
  assert.equal((clean.match(/ADD\s+CONSTRAINT\s+bookings_caravel_terms_snapshot_consistency_chk/g)||[]).length,1);
  assert.equal((clean.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/g)||[]).length,3);
  const statements=clean.split(/\bCOMMIT\s*;/);
  assert.equal(statements.length,2);
  assert.equal(statements[1].trim(),"");
});

test("Caravel terms SQL proposal enforces complete id/hash/language triplets",()=>{
  assert.match(sql,/caravel_terms_document_id\s+IS\s+NULL\s+AND\s+caravel_terms_language\s+IS\s+NULL\s+AND\s+caravel_terms_content_hash\s+IS\s+NULL/);
  assert.match(sql,/caravel_terms_document_id\s+IS\s+NOT\s+NULL/);
  assert.match(sql,/caravel_terms_language\s+IS\s+NOT\s+NULL/);
  assert.match(sql,/caravel_terms_content_hash\s+IS\s+NOT\s+NULL/);
  assert.match(sql,/caravel_terms_document_id\s+~\s+'\^\[A-Za-z0-9\._~\-\]\{1,200\}\$'/);
  assert.match(sql,/caravel_terms_content_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql,/caravel_terms_language\s+~\s+'\^\[a-z\]\{2\}\(-\[A-Z\]\{2\}\)\?\$'/);
  assert.match(sql,/SELECT\s+1\s+FROM\s+pg_constraint/);
  assert.match(sql,/WHERE\s+conrelid\s*=\s*'public\.bookings'::regclass/);
  assert.doesNotMatch(sql,/\bGRANT\s+\b(?:INSERT|UPDATE|ALL)\b\s+ON/);
});
