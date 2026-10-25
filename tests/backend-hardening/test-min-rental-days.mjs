import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const modalScript = read("assets/js/min-rental-search.js");
const index = read("index.html");
const partner = read("partner-dashboard.html");
const results = read("results.html");
const booking = read("supabase/functions/create-booking-request/index.ts");
const apiSearch = read("supabase/functions/search-api/index.ts");

function setup(partners, carPartnerIds, opts = {}) {
  const html = '<button id="searchBtn">Search</button><input id="drop-date" value="2026-10-26"><input id="smart-search-drop" value="Airport">';
  const dom = new JSDOM(html, {url:"https://ride24.pl/", runScripts:"outside-only"});
  const {window:w} = dom;
  w.localStorage.setItem("lang", "pl");
  const location = {location_name:"Airport",country:"Poland",city:"Wroclaw"};
  const search = {pickup_location:location,drop_location:location,pickup_date:"2026-10-25",drop_date:"2026-10-26"};
  let searchCalls = 0, calendarCalls = [];
  w.collectSearchData = () => ({...search});
  w.ride24DateRangePicker = {setDate:(dates,trigger,format) => calendarCalls.push({dates,trigger,format})};
  w.supabaseClient = {
    from(table) {
      const equal = {};
      let included = {};
      const query = {
        select() {return query;},
        eq(name,value) {equal[name]=value;return query;},
        in(name,values) {included[name]=values;return query;},
        async limit() {
          if (opts.networkError) return {data:null,error:{message:"Offline"}};
          if (table === "car_classes") return {
            data:carPartnerIds.filter(id => included.partner_id?.includes(id)).map(id=>({partner_id:id})),
            error:null
          };
          return {data:partners.filter(p => (
            p.active !== false &&
            (!equal.location_name || equal.location_name === p.location_name) &&
            (!equal.country || equal.country === p.country) &&
            (!equal.city || equal.city === p.city)
          )).map(p=>({
            partner_id:p.id,
            partners:{id:p.id,min_rental_days:p.min,provider_type:p.api?"api":"local",
              api_enabled:p.api===true,active:true,account_status:"active"}
          })),error:null};
        }
      };
      return query;
    }
  };
  w.document.querySelector("#searchBtn").addEventListener("click",()=>{searchCalls++;});
  w.eval(modalScript);
  return {w, search,dom, get searchCalls(){return searchCalls;}, get calendarCalls(){return calendarCalls;}};
}

const row = (id, min, api=false) => ({id,min,api,location_name:"Airport",country:"Poland",city:"Wroclaw"});
const tick = () => new Promise(resolve=>setTimeout(resolve,15));

test("the existing search button and its click listener remain structurally untouched",()=>{
  assert.match(index, /document\.getElementById\("searchBtn"\)\?\.addEventListener\("click", async function\(\)/);
  assert.match(index, /assets\/js\/min-rental-search\.js/);
  assert.match(partner, /id="partner-min-rental-days"/);
  assert.match(results, /\.lte\('partners\.min_rental_days', days\)/);
  assert.match(apiSearch, /minimum > days\) uniquePartners\.delete/);
  assert.match(booking, /code: "MIN_RENTAL_DAYS"/);
});

test("a single company requiring 3 days opens only a small separate modal",async()=>{
  const s=setup([row("one",3)],["one"]);
  s.w.document.querySelector("#searchBtn").click();
  await tick();
  const overlay=s.w.document.querySelector("#r24-minimum-overlay");
  assert.equal(s.searchCalls,0);
  assert.ok(overlay?.classList.contains("r24-minimum-visible"));
  assert.match(overlay.textContent,/3 dni/);
  assert.equal(s.w.document.querySelector("#drop-date").value,"2026-10-26");
  overlay.querySelector("#r24-minimum-accept").click();
  assert.equal(s.w.document.querySelector("#drop-date").value,"2026-10-28");
  assert.equal(s.calendarCalls[0].dates[1],"2026-10-28");
  assert.equal(s.searchCalls,1);
  assert.equal(overlay.classList.contains("r24-minimum-visible"),false);
  s.dom.window.close();
});

test("when another company allows 1 day, no modal delays normal search",async()=>{
  const s=setup([row("one",3),row("two",1)],["one","two"]);
  s.w.document.querySelector("#searchBtn").click();
  await tick();
  assert.equal(s.searchCalls,1);
  assert.equal(s.w.document.querySelector("#r24-minimum-overlay"),null);
  assert.equal(s.w.document.querySelector("#drop-date").value,"2026-10-26");
  s.dom.window.close();
});

test("dialog cancellation never changes dates or performs a search",async()=>{
  const s=setup([row("one",5)],["one"]);
  s.w.document.querySelector("#searchBtn").click();
  await tick();
  s.w.document.querySelector("#r24-minimum-cancel").click();
  assert.equal(s.searchCalls,0);
  assert.equal(s.w.document.querySelector("#drop-date").value,"2026-10-26");
  s.dom.window.close();
});

test("network errors never corrupt or block the original search flow",async()=>{
  const s=setup([row("one",3)],["one"],{networkError:true});
  s.w.console.error=()=>{};
  s.w.document.querySelector("#searchBtn").click();
  await tick();
  assert.equal(s.searchCalls,1);
  assert.equal(s.w.document.querySelector("#r24-minimum-overlay"),null);
  s.dom.window.close();
});

test("every local partner language has the new settings labels",()=>{
  const catalogWindow={};
  new Function("window",read("assets/i18n/partner-panel.js"))(catalogWindow);
  const dictionary=catalogWindow.Ride24PartnerLocales;
  const keys=["Minimum rental duration","Minimum (days)","calendar days",
    "Applies to all your locations. A value of 1 means no extra restriction. Customers will see a notice when their selected rental period is too short.",
    "Minimum rental duration must be between 1 and 366 days."];
  for(const key of keys){
    assert.ok(dictionary.source[key],key);
    for(const lang of ["es","el","it","de","ru","fr"]) assert.ok(dictionary.languages[lang][key],lang+" "+key);
  }
});
