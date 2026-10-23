import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { apiProviderCapabilities, inspectApiReadiness } from "../../supabase/functions/_shared/api-readiness.mjs";
const code = ts.transpileModule(await readFile(new URL("../../supabase/functions/_shared/provider-adapters.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const adapter = { exports: {}, require: name => name.includes("partner-api") ? {} : name.includes("ride24-security") ? {} : null,
  URL, TextEncoder, TextDecoder, URLSearchParams, crypto, console };
vm.runInNewContext(code, adapter);

test("Every current provider reports advanced pricing as unfinished, even after connection testing", async () => {
  for (const provider of ["renteon", "easy_web_rent", "ride24_standard_v1", "custom"]) {
    const admin = { from: () => ({ select() { return this; }, eq() { return this; }, limit() { return Promise.resolve({ data: [], error: null }); } }) };
    const result = await inspectApiReadiness(admin, { id: "partner", api_provider: provider },
      { last_test_ok: true, last_sync_at: new Date().toISOString(), password: "never-return-this" });
    assert.equal(result.connection_tested, true); assert.equal(result.metadata_synced, true);
    assert.equal(result.full_ride24_ready, false); assert.equal(result.certification_status, "not_certified");
    assert.equal(result.features.find(f => f.key === "optional_extras").status, "requires_adapter");
    assert.equal(result.local_pricing_status, "compatible_basic");
    assert(!JSON.stringify(result).includes("never-return-this"));
  }
});
test("Unknown providers do not inherit a custom provider certification", () => {
  const result = apiProviderCapabilities("not-a-provider");
  assert.equal(result.supported_provider, false);
  assert.equal(result.full_ride24_ready, false);
  assert.equal(result.features.find(f => f.key === "availability").status, "unsupported");
});
test("Configured fees and extras are reported as blocked, while failed reads remain unverified", async () => {
  function admin(mode) { return { from: table => ({
    select() { return this; }, eq() { return this; },
    limit() { return Promise.resolve(mode === "failed" ? { data: null, error: new Error("unavailable") }
      : { data: table === "partner_extras" ? [{ id: "seat" }] : [], error: null }); }
  }) }; }
  assert.equal((await inspectApiReadiness(admin("fee"), { id: "partner", api_provider: "renteon" })).local_pricing_status, "unmapped_supplements");
  assert.equal((await inspectApiReadiness(admin("failed"), { id: "partner", api_provider: "renteon" })).local_pricing_status, "verification_failed");
});
test("Easy Web Rent retains separate zero, paid and missing return fees without inferring them from pickup fees", () => {
  for (const amount of [0, 25, null]) {
    const [location] = adapter.exports.normalizeEasyWebRentLocations({ locations: [
      { id: "airport", name: "Airport", country: "Portugal", extra_fee: true, extra_fee_amount: 50, return_fee_amount: amount }
    ] });
    assert.equal(location.extra_fee_amount, 50);
    assert.equal(location.return_fee_amount, amount);
  }
  const [missing] = adapter.exports.normalizeEasyWebRentLocations([{ id: "office", name: "Office", country: "Portugal" }]);
  assert.equal(missing.return_fee_amount, null);
  for (const amount of [-1, "not-a-price", Infinity, true, "", "  ", [], [50], {}]) {
    assert.throws(() => adapter.exports.normalizeEasyWebRentLocations([
      { id: "office", name: "Office", country: "Portugal", return_fee_amount: amount }
    ]), /INVALID_LOCATION_FEE/);
  }
});
test("Admin readiness UI displays implemented limits as text and never creates executable provider HTML", async () => {
  const dom = new JSDOM('<div id="api-readiness"></div>', { runScripts: "outside-only" });
  dom.window.eval(await readFile(new URL("../../assets/js/admin-api-readiness.js", import.meta.url), "utf8"));
  const result = apiProviderCapabilities("renteon");
  result.features[0].label_pl = '<img src=x onerror="alert(1)">';
  result.local_pricing_status = "unmapped_supplements";
  dom.window.renderApiReadiness(result);
  const box = dom.window.document.getElementById("api-readiness");
  assert.equal(box.querySelector("img"), null);
  assert.match(box.textContent, /Wymaga uzupełnienia adaptera/);
  assert.match(box.textContent, /Aktywacja takich ofert jest blokowana/);
  assert.match(box.textContent, /Create\/Calculate/);
  dom.window.close();
});
test("Search response carries independent return fee metadata for both route legs", async () => {
  const source = await readFile(new URL("../../supabase/functions/search-api/index.ts", import.meta.url), "utf8");
  assert.match(source, /return_fee_amount: number \| string \| null/);
  assert.match(source, /return_fee_amount: location.return_fee_amount/);
  assert.equal((source.match(/extra_fee_amount, return_fee_amount, contact_required/g) || []).length, 1);
  assert.match(source, /extra_fee_amount,\s+return_fee_amount,\s+contact_required/);
});
test("Admin page still loads Smart Search and all its inline JavaScript parses", async () => {
  const html = await readFile(new URL("../../admin/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  for (const file of ['admin-smart-search.js', 'admin-api-readiness.js']) {
    const reference = Array.from(dom.window.document.querySelectorAll('script[src]'))
      .map(node => new URL(node.getAttribute('src'), 'https://ride24.pl/admin/'))
      .find(url => url.pathname === '/assets/js/' + file);
    assert.ok(reference, file + ' must remain loaded');
    assert.ok(reference.searchParams.get('v'), file + ' must have a cache version');
    await readFile(new URL('../../assets/js/' + file, import.meta.url), 'utf8');
  }
  dom.window.close();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|application\/ld\+json|\btype\s*=\s*["']module/.test(match[1])) continue;
    new vm.Script(match[2]);
  }
});
