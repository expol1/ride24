import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync("supabase/functions/admin-replace-partner-documents/index.ts", "utf8");
const admin = readFileSync("admin/index.html", "utf8");
const legacy = readFileSync("supabase/functions/admin-upload-partner-documents/index.ts", "utf8");

test("replacement route requires admin and rejects signed agreements", () => {
  assert.match(backend, /requireAdmin\(req\)/);
  assert.match(backend, /partner\.agreement_accepted !== false/);
  assert.match(backend, /\.eq\("agreement_accepted", false\)/);
  assert.match(admin, /if \(p\.agreement_accepted !== true\)/);
});

test("replacements are versioned uploads and never overwrite original PDFs", () => {
  assert.match(backend, /"\/versions\/" \+ crypto\.randomUUID\(\)/);
  assert.match(backend, /upsert: false/);
  assert.doesNotMatch(backend, /\.update\(/); // no Storage update
  assert.match(backend, /No delete\/upsert of any prior document/);
  assert.match(backend, /oldUrl === null \? update\.is\(column, null\) : update\.eq\(column, oldUrl\)/);
});

test("replacement changes only selected Terms/Rules database fields", () => {
  assert.match(backend, /const column = doc\.type === "terms" \? "rental_terms_url" : "rental_rules_url"/);
  assert.match(backend, /\.update\(updates\)/);
  assert.doesNotMatch(backend, /discount_percent|api_enabled|api_provider|custom_agreement_pending|agreement_snapshot/);
  assert.match(backend, /form\.getAll\("terms"\)\.length > 1/);
  assert.match(backend, /form\.getAll\("rules"\)\.length > 1/);
});

test("admin form exposes replacement for unsigned existing partners", () => {
  assert.match(admin, /Wgraj lub podmień dokumenty PDF partnera/);
  assert.match(admin, /admin-replace-partner-documents/);
  assert.match(admin, /await replaceAdminPartnerPdfs\(partnerId, terms, rules\)/);
  assert.match(admin, /t\.disabled = signed/);
  assert.match(admin, /r\.disabled = signed/);
});

test("original account creation upload flow remains isolated", () => {
  assert.match(admin, /async function uploadAdminPartnerPdfs\(/);
  assert.match(admin, /await uploadAdminPartnerPdfs\(result\.partner_id, selectedTermsPdf, selectedRulesPdf\)/);
  assert.match(legacy, /if \(partner\.rental_terms_url\) return jsonResponse/);
  assert.match(legacy, /upsert: false/);
});
