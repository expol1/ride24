import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const read = async p => readFile(new URL("../../" + p, import.meta.url), "utf8");
const html = await read("admin/index.html");
const googleDrafts = await read("assets/js/admin-google-ads-drafts.js");
const migration = await read("supabase/migrations/20261023132000_separate_google_ads_social_approval.sql");
const googleCreator = await read("supabase/functions/google-ads-create-campaign/index.ts");

test("Google Ads and Social Media are separate sections with distinct controls", () => {
  const dom = new JSDOM(html);
  const marketing = dom.window.document.getElementById("view-marketing");
  const google = marketing.querySelector("#marketing-simple");
  const social = marketing.querySelector("#marketing-proposals");
  assert(google && social);
  assert(google.querySelector("#google-creative-generate"));
  assert(google.querySelector("#google-creative-location"));
  assert(google.querySelector("#google-ads-drafts"));
  assert(!google.querySelector("#generate-posts-btn"));
  assert(social.querySelector("#generate-posts-btn"));
  assert(social.querySelector("#marketing-queue-tbody"));
  assert(!social.querySelector("#connect-google-btn"));
  assert(!social.textContent.includes("Promuj w Google Ads"));
  assert(google.querySelector("#marketing-simple-campaigns"));
  assert(dom.window.document.querySelector("#google-promotion-budget"));
  dom.window.close();
});

test("Social queue excludes Google-only drafts while old social generator remains available", () => {
  assert.match(html, /\.from\(["']marketing_queue["']\)\s*\.select\(["']\*["']\)\s*\.neq\(["']platform["'], ["']google_ads["']\)/);
  assert.match(html, /async function runMarketingEngine\(\)/);
  assert.match(html, /async function publishMarketingPost\(/);
  assert.match(googleDrafts, /platform: "google_ads", status: "draft"/);
  assert.match(googleDrafts, /\.eq\("platform", "google_ads"\)/);
  assert.match(googleDrafts, /\.eq\("status", "draft"\)/);
  assert.doesNotMatch(googleDrafts, /publishMarketingPost\(/);
  assert.doesNotMatch(googleDrafts, /marketing-engine/);
});

test("Google Ads creation checks independent approval, not publication to Facebook", () => {
  assert.match(migration, /coalesce\(v_post\.platform,' '\)|coalesce\(v_post\.platform,''\)/);
  assert.match(migration, /<> 'google_ads'/);
  assert.match(migration, /<> 'approved'/);
  assert.doesNotMatch(migration, /v_post\.status, ''\) <> 'published'/);
  assert.match(googleCreator, /"Kaucja do 200 EUR"/);
  assert.doesNotMatch(googleCreator, /"Wynajem bez depozytu"/);
  assert.doesNotMatch(googleCreator, /"Zarezerwuj auto bez depozytu/);
});

test("Browser scripts parse and paid promotion requires explicit approval & budget preview", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc=|application\/ld\+json|\btype=['"]module/.test(match[1]));
  for (const match of scripts) assert.doesNotThrow(() => new Function(match[2]));
  assert.doesNotThrow(() => new Function(googleDrafts));
  assert.match(googleDrafts, /confirm\("Zatwierdzasz treść/);
  assert.match(googleDrafts, /openPromotionModal\(id\)/);
  assert.match(html, /async function previewGoogleAdsBudget\(/);
  assert.match(html, /validate_google_ads_promotion/);
  assert.match(html, /google-ads-create-campaign/);
  assert.match(html, /google-ads-start-campaign/);
});
