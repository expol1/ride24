import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {clientProfileErrors, additionalDriverErrors, invoiceProfileErrors, isFirstLicenceDate} from "../../assets/js/client-profile-required.mjs";
const html=readFileSync(new URL("../../klient.html",import.meta.url),"utf8");
const good={name:"Anna Kowalska",age:30,phone:"+48 502 123 456",country:"PL",license_since:"2018-02-16"};
const email="anna@example.com";

test("core profile must be fully complete, including original licence date and residence country",()=>{
  assert.deepEqual(clientProfileErrors(good,email,"2026-11-19"),[]);
  for(const [field,broken] of [["name","Anna"],["age",17],["age",121],["age",null],
    ["phone","123"],["country",""],["license_since",null],["license_since","2027-12-01"]]){
    const errors=clientProfileErrors({...good,[field]:broken},email,"2026-11-19");
    assert.ok(errors.length,field+" should not unlock the panel");
    assert.ok(errors.some(e=>e.id==="profile-"+(field==="license_since"?"license-since":field)),field+" field error missing");
  }
  assert.ok(clientProfileErrors(good,"bad", "2026-11-19").some(x=>x.id==="profile-email"));
  assert.equal(isFirstLicenceDate("2024-02-29","2026-11-19"),true);
  assert.equal(isFirstLicenceDate("2024-02-30","2026-11-19"),false);
});

test("optional driver requires all four fields before any save",()=>{
  const driver={name:"Jan Nowak",age:"26",phone:"+48 502 123 456",license_since:"2020-06-01"};
  assert.deepEqual(additionalDriverErrors(driver,"2026-11-19"),[]);
  for(const [key,value] of [["name",""],["age",""],["phone","000"],["license_since",""]])
    assert.ok(additionalDriverErrors({...driver,[key]:value},"2026-11-19").some(e=>e.field===key));
});

test("optional billing requires full address; NIP is optional but checked if present",()=>{
  const invoice={company_name:"Firma XYZ",nip:"",street:"Spacerowa 10",postal_code:"70-000",city:"Szczecin"};
  assert.deepEqual(invoiceProfileErrors(invoice),[]);
  assert.ok(invoiceProfileErrors({...invoice,postal_code:"70-00"}).some(e=>e.id==="invoice-postal"));
  assert.ok(invoiceProfileErrors({...invoice,company_name:""}).some(e=>e.id==="invoice-company"));
  assert.ok(invoiceProfileErrors({...invoice,nip:"123"}).some(e=>e.id==="invoice-nip"));
  assert.deepEqual(invoiceProfileErrors({...invoice,nip:"1234567890"}),[]);
});

test("client gate is fail-closed and uses SAVED profile, not unsaved form values",()=>{
  const doc=new JSDOM('<!doctype html><body class="r24-profile-checking"><div id="profile-setup-missing"></div>'+
    ['dashboard','bookings','payments','android'].map(id=>'<div id="nav-'+id+'"></div>').join('')+
    ['name','age','email','phone','license-since','country'].map(id=>'<input id="profile-'+id+'">').join('')+
    '</body>',{url:"https://ride24.pl/klient"});
  const w=doc.window, selected=[];
  w.switchTab=tab=>selected.push(tab);
  const start=html.indexOf('window.r24ClientProfileReady = false;');
  const end=html.indexOf('        let payments = [];',start);
  assert.ok(start>=0&&end>start);
  const gate=html.slice(start,end);
  new Function("window","document","localStorage","clientProfileErrors","currentUser",gate)(
    w,w.document,w.localStorage,clientProfileErrors,{email});
  assert.equal(w.r24ClientProfileReady,false);
  assert.equal(w.r24ApplyClientProfileGate({...good,license_since:null}),false);
  assert.ok(w.document.body.classList.contains("r24-profile-incomplete"));
  assert.equal(w.document.getElementById("nav-payments").getAttribute("aria-disabled"),"true");
  assert.equal(selected.at(-1),"profile");
  assert.equal(w.r24ApplyClientProfileGate(good),true);
  assert.equal(w.r24ClientProfileReady,true);
  assert.equal(w.document.body.classList.contains("r24-profile-checking"),false);
  assert.equal(w.document.getElementById("nav-payments").hasAttribute("aria-disabled"),false);
  doc.window.close();
});

test("checkout data is not fetched before profile gate verification",()=>{
  const init=html.slice(html.indexOf('document.addEventListener("DOMContentLoaded", async () => {'),html.indexOf('const deleteInput = document.getElementById',html.indexOf('document.addEventListener("DOMContentLoaded", async () => {')));
  const checked=init.indexOf('const profileReady = window.r24ApplyClientProfileGate');
  assert.ok(checked>0);
  assert.ok(init.indexOf('await loadClientBookings()')>checked);
  assert.ok(init.indexOf('await loadPayments()')>checked);
  assert.match(html,/if \(!window\.r24ClientProfileReady && tabId !== "profile"\)/);
  assert.match(html,/if \(!window\.r24ClientProfileReady\) return;\s*const dashTbody/);
  assert.match(html,/if \(!window\.r24ClientProfileReady\) return;\s*console\.log\("💰 loadPayments start"\)/);
  assert.match(html,/<body class="r24-profile-checking">/);
  assert.ok(html.includes('data-r24-optional-profile="drivers"'));
  assert.ok(html.includes('data-r24-optional-profile="invoice"'));
});

test("saves verify all fields before any database replacement, and unlock only after readback",()=>{
  const profile=html.slice(html.indexOf('window.saveProfile = async function()'),html.indexOf('window.addDriverRow = function'));
  assert.ok(profile.indexOf('clientProfileErrors(profileData,currentUser.email)')>=0 ||
    profile.indexOf('clientProfileErrors(profileData, currentUser.email)')>=0);
  assert.ok(profile.indexOf('clientProfileErrors(')<profile.indexOf('.upsert(profileData'));
  assert.ok(profile.indexOf('const verified = await loadUserProfile()')<profile.indexOf('window.r24ApplyClientProfileGate(verified'));
  const invoice=html.slice(html.indexOf('window.saveInvoiceData = async function()'),html.indexOf('window.deleteInvoiceData = async function()'));
  assert.ok(invoice.indexOf('invoiceProfileErrors(payload)')<invoice.indexOf('.upsert(payload'));
  const driver=html.slice(html.indexOf('window.saveDrivers = async function()'),html.indexOf('// --- REALNE ANULOWANIE',html.indexOf('window.saveDrivers = async function()')));
  assert.ok(driver.indexOf('additionalDriverErrors(candidate)')>=0);
  assert.ok(driver.indexOf('additionalDriverErrors(candidate)')<driver.indexOf('.upsert(newDrivers'));
  assert.doesNotMatch(driver, /\.delete\(/);
});
