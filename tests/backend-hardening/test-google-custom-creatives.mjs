import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const read=async file=>readFile(new URL("../../"+file,import.meta.url),"utf8");
const [html,form,queue,backend,migration]=await Promise.all([
  read("admin/index.html"),read("assets/js/admin-google-ads-custom.js"),
  read("assets/js/admin-google-ads-drafts.js"),
  read("supabase/functions/google-ads-create-campaign/index.ts"),
  read("supabase/migrations/20261023143000_google_ads_custom_creatives.sql")
]);

test("Manual ads editor supports rental, website app promotion and install-only draft without social publishing",()=>{
  const dom=new JSDOM(html);
  const marketing=dom.window.document.getElementById("view-marketing");
  assert(marketing);
  const form=marketing.querySelector("#google-custom-form");
  assert(form);
  assert(form.querySelector("#google-custom-objective option[value='rental']"));
  assert(form.querySelector("#google-custom-objective option[value='app_website']"));
  assert(form.querySelector("#google-custom-objective option[value='app_install']"));
  assert(form.querySelector("#google-custom-image"));
  for(const k of ["headline1","headline2","headline3","long-headline","description1","description2","final-url"]) assert(form.querySelector("#google-custom-"+k));
  assert(form.textContent.includes("Performance Max"));
  dom.window.close();
});

test("Manual image upload yields two real JPEG assets and prevents automatic PMax for install drafts",()=>{
  assert.match(form,/crop\(image,1200,628\)/);
  assert.match(form,/crop\(image,1200,1200\)/);
  assert.match(form,/contentType:"image\/jpeg"/);
  assert.match(form,/\.from\("marketing-images"\)\.upload/);
  assert.match(queue,/if\(install\)/);
  assert.match(queue,/creative\?\.objective==="app_install"/);
  assert.match(backend,/creative\?\.objective==="app_install"/);
  assert.match(backend,/stage:"app_campaign_required"/);
  assert.match(backend,/addUploadedImage\(operations,customerId,assetGroupResource/);
  assert.match(backend,/imageAsset:\{data\}/);
  assert.match(backend,/finalUrls: \[finalUrl\]/);
  assert.match(backend,/\[REDACTED\]/);
  assert.doesNotMatch(form,/publishMarketingPost\(|publish-facebook|marketing-engine/);
});

test("Text length and destination policy are enforced at client and server",()=>{
  assert.match(form,/headline1:30,headline2:30,headline3:30/);
  assert.match(form,/"long-headline":90,description1:90,description2:90/);
  assert.match(form,/url\.protocol!=="https:"/);
  assert.match(backend,/customTextAssets/);
  assert.match(backend,/customLandingPage/);
  assert.match(backend,/\["ride24\.pl","www\.ride24\.pl"\]/);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/public\.is_admin\(\)/);
  assert.match(migration,/google_ads_creative_draft_only/);
});

test("Scripts compile and original Google Ads approval controls remain",()=>{
  assert.doesNotThrow(()=>new Function(form));
  assert.doesNotThrow(()=>new Function(queue));
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([,attrs])=>!/\bsrc\s*=|application\/ld\+json|type=["']module/.test(attrs));
  for(const [,attrs,code] of scripts)assert.doesNotThrow(()=>new Function(code));
  assert.match(queue,/openPromotionModal\(id\)/);
  assert.match(html,/confirmPromotion\(\)/);
  assert.match(html,/stopPromotion\(/);
  assert.match(html,/admin-google-ads-custom\.js/);
});
