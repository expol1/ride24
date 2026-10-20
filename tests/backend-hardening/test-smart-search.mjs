import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { makeSearchMissHandler, normalizeSearchMiss } from "../../supabase/functions/_shared/search-miss-handler.mjs";
const { JSDOM } = await import(process.env.JSDOM_MODULE || "jsdom");
const root = new URL("../../", import.meta.url);
const adminHtml = await readFile(new URL("admin/index.html", root), "utf8");
const adminCode = await readFile(new URL("assets/js/admin-smart-search.js", root), "utf8");
const missCode = await readFile(new URL("assets/js/search-miss.js", root), "utf8");
const home = await readFile(new URL("index.html", root), "utf8");
const snapshot = JSON.parse(await readFile(new URL("maintenance/backups/smart-search-20261020/database-before.json", root)));

function adminFixture({ locations = [], dictionary = [], logs = [] } = {}) {
  const dom = new JSDOM(adminHtml, { url: "https://ride24.pl/admin/", runScripts: "outside-only" });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const data = { partner_locations: locations, locations_dictionary: dictionary };
  const writes = [];
  w.supabaseClient = {
    from(table) {
      let first = 0, last = Infinity;
      const chain = {
        select() { return chain; }, order() { return chain; },
        range(a, b) { first = a; last = b; return chain; },
        upsert(rows, options) {
          writes.push({ table, rows, options });
          for (const row of rows) {
            const index = data[table].findIndex(old => old.id === row.id);
            if (index < 0) data[table].push(row); else data[table][index] = row;
          }
          return Promise.resolve({ error: null });
        },
        then(resolve, reject) { return Promise.resolve({ data: structuredClone((data[table] || []).slice(first, last + 1)), error: null }).then(resolve, reject); }
      };
      return chain;
    },
    async rpc(name) { assert.equal(name, "get_top_searches"); return { data: logs, error: null }; }
  };
  w.eval(adminCode);
  return { dom, w, data, writes, el: id => w.document.getElementById(id), close: () => w.close() };
}

test("Every new geographic component and exact pickup name is queued; translated entries are omitted", () => {
  const s = adminFixture();
  const rows = [{ country: "Italy", region: "Lazio", city: "Rome", location_name: "Rome Airport (FCO)" }];
  const queue = s.w.Ride24SmartSearchAdmin.buildQueue(rows, []);
  assert.deepEqual(Array.from(queue, row => row.type).sort(), ["city", "country", "location", "region"]);
  const translated = queue.map((row, index) => ({ id: String(index), category: row.type, name_en: row.name, name_pl: "PL" }));
  assert.equal(s.w.Ride24SmartSearchAdmin.buildQueue(rows, translated).length, 0);
  s.close();
});

test("Categories, countries and missing Polish values do not conceal untranslated names", () => {
  const s = adminFixture();
  const rows = [{ country: "Italy", region: "Rome", city: "Rome", location_name: "Rome - Office" }];
  const dictionary = [{ category: "country", name_en: "Italy", name_pl: "Włochy" },
    { category: "city", name_en: "Rome", name_pl: "Rzym", parent_country_en: "Italy" },
    { category: "region", name_en: "Rome", name_pl: "" }];
  const queue = s.w.Ride24SmartSearchAdmin.buildQueue(rows, dictionary);
  assert.deepEqual(Array.from(queue, row => row.type).sort(), ["location", "region"]);
  assert.equal(s.w.Ride24SmartSearchAdmin.findEntry(dictionary, "Rome", "city", { country: "USA" }), null);
  s.close();
});

test("Partner duplicates create one mapping task, including apostrophes and HTML-shaped names", async () => {
  const s = adminFixture({ locations: [{ city: "Sant'Agata", location_name: '<img src=x onerror="alert(1)">' },
    { city: "Sant'Agata", location_name: '<img src=x onerror="alert(1)">' }] });
  await s.w.loadUnmappedLocations();
  assert.equal(s.el("unmapped-count").textContent, "2");
  assert.equal(s.el("unmapped-locations-tbody").querySelectorAll("img,[onclick]").length, 0);
  const row = [...s.el("unmapped-locations-tbody").rows].find(row => row.textContent.includes("Sant'Agata"));
  row.querySelector("button").click();
  assert.equal(s.el("dict-city-en").value, "Sant'Agata");
  assert.equal(s.el("dict-city-en").readOnly, true);
  s.close();
});

test("Loading all pages finds partner locations beyond the first thousand rows", async () => {
  const s = adminFixture({ locations: Array.from({ length: 1001 }, (_, i) => ({ id: String(i), city: "City " + i })) });
  await s.w.loadUnmappedLocations();
  assert.equal(s.el("unmapped-count").textContent, "1001");
  assert(s.el("unmapped-locations-tbody").textContent.includes("City 1000"));
  s.close();
});

test("Rome → Rzym saves only dictionary data, leaves partner originals intact and clears that queue task", async () => {
  const locations = [{ city: "Rome", location_name: "Rome Airport (FCO)" }];
  const before = JSON.stringify(locations), s = adminFixture({ locations });
  await s.w.loadUnmappedLocations();
  [...s.el("unmapped-locations-tbody").rows].find(row => row.cells[0].textContent === "Rome").querySelector("button").click();
  s.el("dict-city-pl").value = "Rzym"; s.el("dict-keywords").value = "rzim";
  await s.w.addDictionary();
  assert.equal(s.writes.length, 1); assert.equal(s.writes[0].table, "locations_dictionary");
  assert.equal(s.writes[0].rows[0].name_en, "Rome"); assert.equal(s.writes[0].rows[0].name_pl, "Rzym");
  assert.equal(s.el("unmapped-count").textContent, "1");
  assert.equal(JSON.stringify(locations), before);
  s.close();
});

test("Assigning a miss to an existing name updates it and keeps existing aliases and slug", async () => {
  const s = adminFixture({ dictionary: [{ id: "existing", category: "city", name_en: "Rome", name_pl: "Rzym",
    keywords: "eternal city", slug: "rome", parent_country_en: "Italy" }], logs: [{ query: "rzim", count: 4 }] });
  await Promise.all([s.w.loadUnmappedLocations(), s.w.loadSearchLogs()]);
  s.el("search-logs-tbody").querySelector("button").click();
  s.el("dict-existing").value = "existing"; s.w.editSmartDictionary();
  assert.equal(s.el("dict-keywords").value, "eternal city, rzim");
  await s.w.addDictionary();
  assert.equal(s.data.locations_dictionary.length, 1);
  assert.equal(s.writes[0].options.onConflict, "id");
  assert.equal(s.writes[0].rows[0].id, "existing");
  assert.equal(s.writes[0].rows[0].slug, "rome");
  assert.equal(s.writes[0].rows[0].keywords, "eternal city, rzim");
  s.close();
});

test("Incomplete form performs no writes and shows an actionable error", async () => {
  const s = adminFixture(); s.el("dict-city-en").value = "Rome";
  await s.w.addDictionary();
  assert.equal(s.writes.length, 0); assert.match(s.el("dict-status").textContent, /polskie tłumaczenie/);
  s.close();
});

function loggingFixture({ existing = false, dictionary = [], rateAllowed = true, fail = false } = {}) {
  const calls = [], writes = [];
  const handler = makeSearchMissHandler({ url: "https://example.supabase.co", serviceKey: "server-secret",
    internalSecret: "internal-secret", publicKeys: ["public-key"], fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const path = new URL(url).pathname;
      if (fail) return new Response("down", { status: 503 });
      if (path.endsWith("/rpc/consume_rate_limit")) return Response.json(rateAllowed);
      if (path.endsWith("/locations_dictionary")) return Response.json(dictionary);
      if (path.endsWith("/partner_locations")) return Response.json(existing ? [{ id: "point" }] : []);
      if (path.endsWith("/search_logs")) { writes.push(JSON.parse(options.body)); return new Response(null, { status: 201 }); }
      throw new Error("Unexpected endpoint");
    }
  });
  function request(query, { origin = "https://ride24.pl", key = "public-key", method = "POST" } = {}) {
    return handler(new Request("https://example.supabase.co/functions/v1/record-search-miss", {
      method, headers: { Origin: origin, apikey: key, "Content-Type": "application/json", "x-forwarded-for": "192.0.2.1" },
      body: ["GET", "OPTIONS"].includes(method) ? undefined : JSON.stringify({ query })
    }));
  }
  return { calls, writes, request };
}

test("Server saves a genuine miss; logs contain the phrase only, without IP, account or credentials", async () => {
  const s = loggingFixture(); const response = await s.request("  Tiranna ");
  assert.equal(response.status, 202); assert.deepEqual(s.writes, [{ query: "tiranna" }]);
  assert.deepEqual(await response.json(), { logged: true });
  const rate = JSON.parse(s.calls[0].options.body);
  assert.match(rate.p_key, /^[0-9a-f]{64}$/); assert(!JSON.stringify(rate).includes("192.0.2.1"));
  assert.equal(rate.p_limit, 30);
});

test("Server rechecks active locations and skips valid names, including expanded dictionary aliases", async () => {
  const s = loggingFixture({ existing: true, dictionary: [{ name_en: "Rome", name_pl: "Rzym", keywords: "rzim, eternal city" }] });
  const response = await s.request("rzim");
  assert.equal(response.status, 200); assert.equal(s.writes.length, 0);
  const url = new URL(s.calls.find(call => call.url.includes("/partner_locations")).url);
  assert.equal(url.searchParams.get("active"), "eq.true");
  assert(url.searchParams.get("or").includes('city.ilike."%rome%"'));
  assert(url.searchParams.get("or").includes('country.ilike."%rzym%"'));
});

test("CORS, public API key and methods are enforced before touching the database", async () => {
  const s = loggingFixture();
  assert.equal((await s.request("tiranna", { key: "wrong" })).status, 401);
  assert.equal((await s.request("tiranna", { origin: "https://evil.example" })).status, 403);
  assert.equal((await s.request("tiranna", { method: "GET" })).status, 405);
  assert.equal((await s.request("tiranna", { method: "OPTIONS" })).status, 204);
  assert.equal(s.calls.length, 0);
});

test("Short inputs and probable personal contact details are not collected", async () => {
  const s = loggingFixture();
  for (const query of ["ab", "a".repeat(81), "person@example.com", "123456789", "+48 123456789", "<script>"]) {
    assert.equal(normalizeSearchMiss(query), null);
    assert.equal((await s.request(query)).status, 400);
  }
  assert.equal(s.calls.length, 0);
  assert.equal(normalizeSearchMiss("  CITTÀ   D’ITALIA "), "città d’italia");
});

test("Rate limits and technical failures never insert a failed-search log", async () => {
  const s = loggingFixture({ rateAllowed: false });
  assert.equal((await s.request("tiranna")).status, 429); assert.equal(s.calls.length, 1); assert.equal(s.writes.length, 0);
  const failed = loggingFixture({ fail: true });
  assert.equal((await failed.request("tiranna")).status, 503); assert.equal(failed.writes.length, 0);
});

test("Client waits for a settled query, cancels intermediate typing and deduplicates per session", async () => {
  const dom = new JSDOM('<input id="smart-search-pickup"><div id="box" class="show"></div>', {
    url: "https://ride24.pl/", runScripts: "outside-only"
  });
  const w = dom.window, timers = new Map(), invocations = [];
  let id = 0;
  w.setTimeout = callback => { timers.set(++id, callback); return id; };
  w.clearTimeout = key => timers.delete(key);
  w.supabaseClient = { functions: { async invoke(name, args) { invocations.push({ name, args }); return { data: { logged: true }, error: null }; } } };
  w.eval(missCode);
  const input = w.document.getElementById("smart-search-pickup"), box = w.document.getElementById("box");
  input.value = "tir"; w.Ride24SearchMiss.schedule("tir", "pickup", box);
  w.Ride24SearchMiss.cancel("pickup"); assert.equal(timers.size, 0);
  input.value = "tiranna"; w.Ride24SearchMiss.schedule("tiranna", "pickup", box);
  const callback = [...timers.values()][0]; timers.clear(); await callback();
  assert.equal(invocations.length, 1); assert.equal(invocations[0].name, "record-search-miss");
  w.Ride24SearchMiss.schedule("tiranna", "pickup", box); assert.equal(timers.size, 0);
  input.value = "varnaa"; w.Ride24SearchMiss.schedule("varnaa", "pickup", box);
  input.value = "varna"; await [...timers.values()][0](); assert.equal(invocations.length, 1);
  for (const query of ["cypr", "paphos", "varna", "Città", "a", "example@test.pl"])
    assert.equal(w.Ride24SearchMiss.normalize(query), normalizeSearchMiss(query));
  w.close();
});

test("Client logging failure does not escape into search flow", async () => {
  const dom = new JSDOM('<input id="smart-search-pickup" value="tiranna"><div id="box" class="show"></div>', { url: "https://ride24.pl/", runScripts: "outside-only" });
  const w = dom.window; let callback;
  w.setTimeout = fn => { callback = fn; return 1; }; w.clearTimeout = () => {};
  w.supabaseClient = { functions: { async invoke() { throw new Error("offline"); } } };
  w.eval(missCode); w.Ride24SearchMiss.schedule("tiranna", "pickup", w.document.getElementById("box"));
  await assert.doesNotReject(callback()); w.close();
});

test("All inline scripts still parse and integration keeps partner return filtering intact", () => {
  for (const [name, html] of [["admin", adminHtml], ["home", home]]) {
    let count = 0;
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|application\/ld\+json|\btype\s*=\s*["']module/.test(match[1])) continue;
      new vm.Script(match[2], { filename: name + "-inline-" + (++count) });
    }
    assert(count > 0);
  }
  assert(home.includes(".in('partner_id', eligiblePickupPartnerIds)"));
  assert(home.includes('window.Ride24SearchMiss?.schedule(query, type, resultsBox)'));
  assert(home.includes("if (dictionaryError)"));
  assert(adminHtml.includes('id="dict-location-pl"'));
  assert.equal(snapshot.dictionary.length, 103);
});
