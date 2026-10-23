import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = async (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");
const [admin, engine, facebook, twitter, xConnect, xCallback] = await Promise.all([
  read("admin/index.html"),
  read("supabase/functions/marketing-engine/index.ts"),
  read("supabase/functions/publish-facebook/index.ts"),
  read("supabase/functions/publish-x/index.ts"),
  read("admin/x-connect.html"),
  read("admin/x-callback.html"),
]);

test("Facebook is the only social publishing channel in the admin", () => {
  assert.match(admin, /Social Media AI — tylko Facebook/);
  assert.match(admin, /id="connect-facebook-btn"/);
  assert.match(admin, /"publish-facebook"/);
  assert.doesNotMatch(admin, /id="connect-x-btn"|connectX\s*\(|"publish-x"/);
  assert.match(admin, /platform:\s*"facebook",\s*status:\s*"draft"/);
  assert.match(admin, /all:\s*"Facebook"/); // pre-existing drafts remain usable
  assert.match(admin, /Publikuj na Facebooku/);
  assert.match(admin, /id="google-ads-drafts"/); // unaffected
});

test("New generated posts are Facebook-only and publishing safeguards block other channels", () => {
  assert.match(engine, /platform:\s*"facebook"/);
  assert.doesNotMatch(engine, /platform:\s*"all"/);
  assert.match(facebook, /\["facebook", "all"\]\.includes\(String\(post\.platform/);
  assert.match(facebook, /profile\.role !== "admin"/);
  assert.match(facebook, /graph\.facebook\.com/);
  assert.doesNotMatch(facebook, /api\.twitter\.com/);
});

test("Retired Twitter publisher performs no outbound requests", () => {
  assert.match(twitter, /code:\s*"X_PUBLISHING_DISABLED"/);
  assert.match(twitter, /status:\s*410/);
  assert.doesNotMatch(twitter, /api\.twitter\.com|\.from\(["']marketing_queue["']\)|x_access_token/);
  assert.doesNotMatch(xConnect, /twitter\.com\/i\/oauth2\/authorize/);
  assert.doesNotMatch(xCallback, /URLSearchParams/);
});

test("Admin inline JavaScript still parses", () => {
  const scripts = [...admin.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=|type=["']module/.test(attributes));
  for (const [, , source] of scripts) assert.doesNotThrow(() => new Function(source));
});
