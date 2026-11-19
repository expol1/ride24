import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {
  canonicalCaravelJson, computeCaravelTermsContentHash, verifyCaravelTermsDocumentHash,
  renderCaravelTermsHtml, renderCaravelTermsText, assertCaravelClausesV1Body,
} from "../supabase/functions/_shared/caravel-terms-canonical.ts";
import {buildCaravelHmacSelfTestSubmission, verifyCaravelSignature} from "../supabase/functions/_shared/caravel-webhooks.ts";

const body = () => ({
  title: "Rental Terms", language: "en",
  clauses: [
    {number: "1", heading: "Scope", paragraphs: [[{text: "Café \"quoted\" <b>x</b> "}, {text: "EUR 100", mark: "strong"}]],
      clauses: [{number: "1.1", paragraphs: [[{text: "Glass, tyres and undercarriage", mark: "em"}]]}]},
    {number: "2", paragraphs: []},
  ],
});

test("canonical serialisation sorts keys at every level, keeps array order, no whitespace", () => {
  const s = canonicalCaravelJson(body());
  assert.ok(s.startsWith('{"clauses":[{"clauses":[{"number":"1.1","paragraphs":[[{"mark":"em","text":'));
  assert.ok(!/\s{2}|\n|": /.test(s.replace(/"(?:[^"\\]|\\.)*"/g, "")));
  // Same object with keys inserted in a different order -> identical bytes.
  const b = body(); const r = {language: b.language, clauses: b.clauses, title: b.title};
  assert.equal(canonicalCaravelJson(r), s);
  // Array order is significant.
  const swapped = body(); swapped.clauses.reverse();
  assert.notEqual(canonicalCaravelJson(swapped), s);
});

test("string escaping is exactly JSON.stringify (incl. U+2028, quotes, non-ASCII as UTF-8)", () => {
  const s = canonicalCaravelJson({a: "Café \"q\"   \\ \u0001"});
  assert.equal(s, '{"a":' + JSON.stringify("Café \"q\"   \\ \u0001") + "}");
});

test("content hash = SHA-256 over UTF-8 canonical bytes (independent Node crypto cross-check)", async () => {
  const expected = createHash("sha256").update(Buffer.from(canonicalCaravelJson(body()), "utf8")).digest("hex");
  assert.equal(await computeCaravelTermsContentHash(body()), expected);
});

test("verification passes only when recomputed hash equals declared content_hash", async () => {
  const b = body();
  const doc = {document_id: "doc-1", language: "en", version: 4, title: "Rental Terms", format: "clauses/v1",
    content_hash: await computeCaravelTermsContentHash(b), published_at: "2026-11-17T00:00:00Z", withdrawn_at: null, body: b};
  const ok = await verifyCaravelTermsDocumentHash(doc);
  assert.equal(ok.verified, true);
  assert.equal(ok.version, 4);
  await assert.rejects(() => verifyCaravelTermsDocumentHash({...doc, content_hash: "0".repeat(64)}), /CONTENT_HASH_MISMATCH/);
  const tampered = body(); tampered.clauses[0].paragraphs[0][1].text = "EUR 0";
  await assert.rejects(() => verifyCaravelTermsDocumentHash({...doc, body: tampered}), /CONTENT_HASH_MISMATCH/);
  await assert.rejects(() => verifyCaravelTermsDocumentHash({...doc, title: "Other"}), /BODY_RECORD_MISMATCH/);
  await assert.rejects(() => verifyCaravelTermsDocumentHash({...doc, format: "clauses/v2"}), /FORMAT_UNSUPPORTED/);
  await assert.rejects(() => verifyCaravelTermsDocumentHash({...doc, content_hash: "A".repeat(64)}), /DECLARED_HASH_INVALID/);
});

test("non-string leaves, unknown members and unknown marks fail closed (nothing promised beyond strings)", async () => {
  const withNumber = body(); withNumber.clauses[0].number = 1;
  assert.throws(() => assertCaravelClausesV1Body(withNumber), /CLAUSE_INVALID/);
  const extra = body(); extra.clauses[0].html = "<b>";
  assert.throws(() => assertCaravelClausesV1Body(extra), /UNKNOWN_MEMBER/);
  const mark = body(); mark.clauses[0].paragraphs[0][0].mark = "html";
  assert.throws(() => assertCaravelClausesV1Body(mark), /MARK_INVALID/);
  assert.throws(() => canonicalCaravelJson({a: 1}), /NON_STRING_LEAF/);
  assert.throws(() => assertCaravelClausesV1Body({title: "t", language: "en", clauses: []}), /BODY_INVALID/);
});

test("rendering escapes literal text, preserves frozen clause numbers and only strong/em", () => {
  const html = renderCaravelTermsHtml(body());
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!html.includes("<b>x"));
  assert.ok(html.includes("<strong>EUR 100</strong>"));
  assert.ok(html.includes(">1.1</span>"));
  const text = renderCaravelTermsText(body());
  assert.ok(text.includes("1 Scope"));
  assert.ok(text.includes("  1.1"));
});

test("official Caravel HMAC fixture (public self-test value) reproduces expected signature and rejects tamper", async () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/caravel/webhook-hmac-self-test.json", import.meta.url), "utf8"));
  const r = await buildCaravelHmacSelfTestSubmission(f);
  assert.equal(r.signature_hex, f.expected_signature_hex);
  assert.equal(r.tampered_rejected, true);
  // The published full header value verifies with fixture t as now; a stale now rejects (replay window).
  const req = {method: f.method, path: f.path, body: f.body};
  assert.equal(await verifyCaravelSignature(f.header, [f.secret], req, {nowSecs: f.t}), true);
  assert.equal(await verifyCaravelSignature(f.header, [f.secret], req, {nowSecs: f.t + 301}), false);
  assert.equal(await verifyCaravelSignature(f.header, [f.secret], {...req, path: req.path + "x"}, {nowSecs: f.t}), false);
  assert.equal(await verifyCaravelSignature(f.header, ["wrong", f.secret], req, {nowSecs: f.t}), true, "rotation overlap");
  assert.equal(f.signed_payload, `${f.t}.${f.method}.${f.path}.${f.body}`);
});
