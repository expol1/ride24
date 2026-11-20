import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";

const html = readFileSync(new URL("../../admin/index.html",import.meta.url),"utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
const begin = script.indexOf("/* Read-only readiness indicator.");
const end = script.indexOf("let partnerContactRequestId = 0;",begin);
assert.ok(begin >= 0 && end > begin,"Cannot isolate partner list presentation logic");
const moduleSource = script.slice(begin,end);
const records = [
  {id:"unsigned", company_name:"Podpis oczekuje", country:"Kosovo", active:false, account_status:"pending", provider_type:"local", agreement_accepted:false},
  {id:"no-car", company_name:"Brak samochodów", country:"Romania", active:true, account_status:"active", provider_type:"local", agreement_accepted:true},
  {id:"no-location", company_name:"Brak lokalizacji", country:"Spain", active:true, account_status:"active", provider_type:"local", agreement_accepted:true},
  {id:"ready-local", company_name:"Gotowy partner", country:"Bosnia", active:true, account_status:"active", provider_type:"local", agreement_accepted:true},
  {id:"ready-api", company_name:"API partner", country:"Greece", active:true, account_status:"active", provider_type:"api", agreement_accepted:true}
];
const locations = [
  {id:"l1",partner_id:"unsigned",active:true},
  {id:"l2",partner_id:"no-car",active:true},
  {id:"l3",partner_id:"ready-local",active:true},
  {id:"l4",partner_id:"ready-api",active:true}
];
const cars = [
  {id:"c1",partner_id:"unsigned",active:true},
  {id:"c2",partner_id:"no-location",active:true},
  {id:"c3",partner_id:"ready-local",active:true},
  {id:"c4",partner_id:"ready-api",active:true},
  {id:"c5",partner_id:"no-car",active:false}
];

const escapeHtml = value => String(value??"")
 .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

function createFixture({tables={}, failures={}}={}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="view-partners"><table><tbody id="admin-partners-tbody"></tbody></table></div></body></html>');
  const fixtureTables={partners:records,car_classes:cars,partner_locations:locations,partner_agreement_documents:[],...tables};
  const rangeLog=[];
  class Query {
    constructor(table){this.table=table;this.filters=[];this.start=0;this.end=9999;}
    select(){return this;}
    eq(key,value){this.filters.push(row=>row[key]===value);return this;}
    in(key,values){this.filters.push(row=>values.includes(row[key]));return this;}
    order(){return this;}
    range(a,b){this.start=a;this.end=b;rangeLog.push({table:this.table,a,b});return this;}
    then(resolve,reject){
      const error=failures[this.table] ? {message:"Read unavailable"} : null;
      const raw=(fixtureTables[this.table]||[]).filter(r=>this.filters.every(f=>f(r)));
      return Promise.resolve({data:error?null:raw.slice(this.start,this.end+1),error}).then(resolve,reject);
    }
  }
  const db={from:table=>new Query(table)};
  const logic=new Function("db","document","escapeHtml",moduleSource+";return {loadPartnersData,adminPartnerRowReadiness};")(db,dom.window.document,escapeHtml);
  return {dom,document:dom.window.document,logic,rangeLog};
}

test("agreement has priority over missing cars and locations",()=>{
  const {logic}=createFixture();
  assert.equal(logic.adminPartnerRowReadiness(records[0],0,0,true).key,"agreement");
  assert.equal(logic.adminPartnerRowReadiness(records[0],20,20,true).key,"agreement");
  assert.equal(logic.adminPartnerRowReadiness(records[1],0,1,true).key,"setup");
  assert.equal(logic.adminPartnerRowReadiness(records[2],1,0,true).key,"setup");
  assert.equal(logic.adminPartnerRowReadiness(records[3],1,1,true).key,"ready");
  assert.equal(logic.adminPartnerRowReadiness(records[3],0,0,false).key,"unknown");
});

test("all four cells of each partner row share a single left-to-right gradient",()=>{
  const style=html.slice(html.indexOf("<style>"),html.indexOf("</style>"));
  for(const key of ["agreement","setup","ready"]){
    assert.match(style,new RegExp('tr\\.r24-partner-row--'+key+'\\s*\\{\\s*background:linear-gradient\\(90deg,'));
    assert.match(style,new RegExp('r24-partner-row--'+key+' > td:first-child'));
  }
  assert.match(style,/r24-partner-row--ready > td,\s*#view-partners/);
  assert.match(html,/class="r24-partner-readiness-legend"/);
  assert.match(html,/Umowa niepodpisana/);
  assert.match(html,/Brak aktywnych aut lub lokalizacji/);
});

test("readiness backgrounds remain saturated across the full row and grey stays neutral",()=>{
  const block=html.slice(html.indexOf("/* Baza Partnerów"),html.indexOf("/* RIDE24_PARTNER_CONTACT_DIALOG_START"));
  const variants=[
    ["agreement","#fbd75e","#fff3c7"],
    ["setup","#c4c4c4","#f0f0f0"],
    ["ready","#80e89e","#dcf9e5"]
  ];
  for(const [key,left,right] of variants){
    const rule=new RegExp("tr\\.r24-partner-row--"+key+"\\s*\\{\\s*background:linear-gradient\\(90deg,([^;]+);");
    const match=block.match(rule);
    assert.ok(match,"Missing gradient: "+key);
    assert.ok(match[1].includes(left+" 0%"),"Distinct visible left edge: "+key);
    assert.ok(match[1].includes(right+" 100%"),"Tint must remain at right edge: "+key);
  }
  assert.doesNotMatch(block,/#94a3b8|#f1f5f9|rgba\\(148,163,184/);
});

test("read-only queries render correct classes for unsigned, incomplete, local and API partners",async()=>{
  const f=createFixture();
  await f.logic.loadPartnersData();
  const rows=[...f.document.querySelectorAll("#admin-partners-tbody > tr")];
  assert.equal(rows.length,5);
  assert.deepEqual(rows.map(r=>r.dataset.r24Readiness),["agreement","setup","setup","ready","ready"]);
  assert.match(rows[1].title,/Aktywne auta: 0, aktywne lokalizacje: 1/);
  assert.match(rows[2].title,/Aktywne auta: 1, aktywne lokalizacje: 0/);
  assert.match(rows[3].title,/Aktywne auta: 1, aktywne lokalizacje: 1/);
  for(const row of rows)assert.equal(row.cells.length,4);
  assert.match(rows[3].querySelector(".status").textContent,/AKTYWNY/);
  assert.match(rows[4].innerHTML,/openApiConfiguration/);
  assert.match(rows[2].innerHTML,/togglePartner/);
  f.dom.window.close();
});

test("pagination prevents silent missing counts above PostgREST 500-row page",async()=>{
  const many=Array.from({length:505},(_,i)=>({id:"car-"+String(i).padStart(4,"0"),partner_id:"ready-local",active:true}));
  const f=createFixture({tables:{car_classes:many}});
  await f.logic.loadPartnersData();
  const row=[...f.document.querySelectorAll("#admin-partners-tbody > tr")].find(r=>r.cells[0].textContent.includes("Gotowy partner"));
  assert.equal(row.dataset.r24Readiness,"ready");
  assert.match(row.title,/Aktywne auta: 505, aktywne lokalizacje: 1/);
  assert.ok(f.rangeLog.some(x=>x.table==="car_classes"&&x.a===500));
  f.dom.window.close();
});

test("inventory read failure does not falsely label signed partners as ready or empty",async()=>{
  const originalWarn=console.warn;
  console.warn=()=>{};
  try {
    const f=createFixture({failures:{car_classes:true}});
    await f.logic.loadPartnersData();
    const rows=[...f.document.querySelectorAll("#admin-partners-tbody > tr")];
    assert.equal(rows[0].dataset.r24Readiness,"agreement");
    for(const row of rows.slice(1)){
      assert.equal(row.dataset.r24Readiness,"unknown");
      assert.equal(row.className,"");
    }
    f.dom.window.close();
  } finally {console.warn=originalWarn;}
});

test("partner readiness is strictly read-only and preserves original admin moderation",()=>{
  assert.doesNotMatch(moduleSource,/\.update\(|\.delete\(|\.insert\(|\.upsert\(|db\.rpc\(/);
  for(const method of ["togglePartner(","generateAgreementForPartner(","deletePartner(","openAdminPartnerDocs(","openPartnerCustomAgreement("])
    assert.ok(moduleSource.includes(method),"Preserve action "+method);
  assert.ok(moduleSource.includes('agreement_accepted !== true'));
});
