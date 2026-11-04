import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const migration = read("supabase/migrations/20261104121000_custom_partner_agreements.sql");
const backend = read("supabase/functions/admin-partner-custom-agreement/index.ts");
const helper = read("assets/js/partner-custom-agreements.js");
const partnerHtml = read("partner-dashboard.html");
const adminHtml = read("admin/index.html");

test("private store, no overwrite of signed files, standard RPC blocked for custom", () => {
  assert.match(migration, /'partner-agreements', 'partner-agreements', false/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /CUSTOM_AGREEMENT_ASSIGNED/);
  assert.match(migration, /SIGNED_AGREEMENT_PDF_CANNOT_BE_DELETED/);
  assert.match(migration, /partner_accept_custom_agreement/);
  assert.match(migration, /sha256.*\^\[a-f0-9\]\{64\}/);
  assert.match(backend, /requireAdmin\(req\)/);
  assert.match(backend, /upsert: false/);
  assert.doesNotMatch(backend, /getPublicUrl/);
});

test("dashboard routes to custom agreement and preserves existing standard generator", () => {
  assert.match(partnerHtml, /\.from\("partner_agreement_documents"\)/);
  assert.match(partnerHtml, /if \(p\.custom_agreement_document\)/);
  assert.match(partnerHtml, /window\.Ride24CustomAgreement\.render/);
  assert.match(partnerHtml, /partner_accept_agreement/);
  assert.match(partnerHtml, /window\.Ride24CustomAgreement\.showSigned/);
  assert.match(adminHtml, /openPartnerCustomAgreement/);
  assert.match(adminHtml, /previewIfAssigned\(partnerId\)/);
});

function fixture(tampered = false) {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const sha = createHash("sha256").update(pdf).digest("hex");
  const doc = {
    storage_path: "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf",
    original_filename: "Signed_Agreement.pdf",
    sha256: tampered ? "0".repeat(64) : sha,
  };
  let signed = 0, reloads = 0;
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, checked: false, disabled: false, textContent: "",
      replaceChildren() { this.children = []; },
      append(...items) { this.children = [...(this.children || []), ...items]; },
    });
    return elements.get(id);
  };
  const ctx = {
    document: {
      getElementById: get,
      createElement(tag) {
        return {
          tagName: tag, style: {}, textContent: "",
          setAttribute() {},
        };
      },
    },
    window: {
      addEventListener() {},
      location: { reload() { reloads++; } },
      open() {},
    },
    alert() {},
    console: { error() {} },
    crypto: webcrypto,
    TextDecoder,
    Blob,
    URL: {createObjectURL:()=> "blob:mockpdf", revokeObjectURL() {}},
    fetch: async () => { throw new Error("IP unavailable"); },
    toggleSignButton() {},
  };
  const db = {
    storage: {from(bucket) {
      assert.equal(bucket, "partner-agreements");
      return {download: async () => ({ data: new Blob([pdf]), error: null })};
    }},
    rpc: async (name, args) => {
      assert.equal(name, "partner_accept_custom_agreement");
      assert.equal(args.p_sha256, sha);
      signed++;
      return { data: true, error: null };
    },
  };
  vm.runInNewContext(helper, ctx);
  return { doc, db, api: ctx.window.Ride24CustomAgreement, get,
    counts: () => ({signed, reloads}) };
}

test("correct PDF bytes are verified before enabling custom signing", async () => {
  const f = fixture();
  assert.equal(f.api.isReady(), false);
  await f.api.render(f.doc, f.db, "en");
  assert.equal(f.api.isReady(), true);
  f.get("accept-cb").checked = true;
  await f.api.sign(f.doc, f.db, "en");
  assert.deepEqual(f.counts(), { signed: 1, reloads: 1 });
});

test("changed PDF is not accepted and cannot be signed", async () => {
  const f = fixture(true);
  await f.api.render(f.doc, f.db, "en");
  assert.equal(f.api.isReady(), false);
  f.get("accept-cb").checked = true;
  await f.api.sign(f.doc, f.db, "en");
  assert.deepEqual(f.counts(), { signed: 0, reloads: 0 });
});
