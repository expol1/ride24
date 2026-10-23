import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
const { JSDOM } = await import(process.env.JSDOM_MODULE || "jsdom");

const html = await readFile(new URL("../../admin/index.html", import.meta.url), "utf8");
const marketingBackend = await readFile(new URL("../../supabase/functions/marketing-engine/index.ts", import.meta.url), "utf8");
function extract(start, end) {
  const i = html.indexOf(start), j = html.indexOf(end, i);
  assert(i >= 0 && j > i, "Missing script section: " + start);
  return html.slice(i, j);
}
const renderCode = extract("function renderSimpleGoogleAdsCampaigns(campaigns) {", "function setGoogleAdsDashboardText(");
const stopCode = extract("async function stopPromotion(id) {", "function closeMarketingModal() {");

test("Google Ads beginner panel lives inside Marketing and keeps advanced controls", () => {
  const dom = new JSDOM(html, { url: "https://ride24.pl/admin/", runScripts: "outside-only" });
  const { document } = dom.window;
  const marketing = document.getElementById("view-marketing");
  const radar = document.getElementById("view-radar");
  const simple = document.getElementById("marketing-simple");
  const advanced = document.getElementById("marketing-advanced");
  assert(marketing?.contains(simple));
  assert(!radar?.contains(simple));
  assert(marketing?.contains(advanced));
  assert(advanced.contains(document.getElementById("google-ads-campaigns-tbody")));
  assert(advanced.contains(document.getElementById("monthly-budget")));
  assert(marketing.contains(document.getElementById("marketing-proposals")));
  assert.equal(advanced.open, false);
  assert(marketing.querySelector('[onclick="synchronizeGoogleAdsDashboard(this)"]'));
  for (const [, attrs, script] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|application\/ld\+json|\btype\s*=\s*["']module/.test(attrs)) continue;
    new vm.Script(script);
  }
  dom.window.close();
});

test("Active ads can be stopped individually; paused ads cannot and names are text-safe", () => {
  const dom = new JSDOM('<div id="marketing-simple-campaigns"></div>', { runScripts: "outside-only" });
  const { document } = dom.window;
  const called = [], pending = new Set();
  const render = new Function("document", "formatGoogleAdsMoney", "googleAdsStopPending", "stopPromotion",
    renderCode + "\nreturn renderSimpleGoogleAdsCampaigns;")(
      document, n => String(n) + " zł", pending, id => called.push(id));
  render([
    { marketing_queue_id: 5, campaign_name: "<img src=x onerror=alert(1)>", google_status: "ENABLED", status: "enabled", daily_budget: 15 },
    { marketing_queue_id: 6, campaign_name: "Wstrzymana", google_status: "PAUSED", status: "paused", daily_budget: 25 },
    { marketing_queue_id: 7, campaign_name: "Różne statusy", google_status: "PAUSED", status: "enabled", daily_budget: 15 },
    { marketing_queue_id: null, campaign_name: "Bez ID", google_status: "ENABLED", status: "enabled", daily_budget: 15 }
  ]);
  const list = document.getElementById("marketing-simple-campaigns");
  assert.equal(list.querySelectorAll("button").length, 2);
  assert.equal(list.querySelectorAll("img").length, 0);
  assert(list.textContent.includes("<img src=x onerror=alert(1)>"));
  const buttons = list.querySelectorAll("button");
  assert.equal(buttons[0].dataset.googleStopPost, "5");
  assert.equal(buttons[1].dataset.googleStopPost, "7");
  buttons[0].click();
  assert.deepEqual(called, [5]);
  render([]);
  assert.equal(list.querySelectorAll("button").length, 0);
  dom.window.close();
});

test("Pause requires confirmation, blocks repeated clicks and changes status only on Google success", async () => {
  let confirmCalls = 0, apiCalls = 0, refreshes = 0, resolveCall, apiResponse = null;
  const alerts = [], disabledButtons = [{ disabled: false, textContent: "" }];
  const pending = new Set();
  const db = { functions: { invoke(name, payload) {
    apiCalls++;
    assert.equal(name, "google-ads-stop-campaign");
    assert.deepEqual(payload, { body: { postId: 5 } });
    return apiResponse || new Promise(resolve => { resolveCall = resolve; });
  } } };
  const stop = new Function("db", "document", "confirm", "alert", "googleAdsStopPending",
    "loadMarketingQueue", "loadMarketingSettings", "loadGoogleAdsDashboard", "console",
    stopCode + "\nreturn stopPromotion;")(
      db, { querySelectorAll: () => disabledButtons },
      () => { confirmCalls++; return true; },
      message => alerts.push(message), pending,
      async () => { refreshes++; }, async () => { refreshes++; }, async () => { refreshes++; },
      { error: () => {} }
    );
  const first = stop(5), second = stop(5);
  await second;
  assert.equal(apiCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.equal(disabledButtons[0].disabled, true);
  resolveCall({ data: { success: true, campaignPaused: true, campaign: {} }, error: null });
  await first;
  assert.equal(refreshes, 3);
  assert.equal(disabledButtons[0].disabled, false);
  assert.equal(pending.size, 0);
  apiResponse = Promise.resolve({ error: { message: "API offline" } });
  await stop(5);
  assert.equal(apiCalls, 2);
  assert.equal(refreshes, 3);
  assert.match(alerts.at(-1), /Nie udało się zatrzymać kampanii/);
  assert.equal(pending.size, 0);
});


test("Marketing generator never deletes campaign history on AI failures", () => {
  assert.doesNotMatch(marketingBackend, /\.from\(["']marketing_queue["']\)\s*\.delete\s*\(/);
  assert.doesNotMatch(marketingBackend, /\.from\(["']google_ads_campaigns["']\)\s*\.delete\s*\(/);
  assert.match(marketingBackend, /AI_CREDITS_EXHAUSTED/);
  assert.match(html, /onClick|onclick="runMarketingEngine\(\)"/);
  assert.match(html, /credit_balance_exhausted|AI_CREDITS_EXHAUSTED/);
});
