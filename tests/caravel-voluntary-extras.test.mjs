import test from "node:test";
import assert from "node:assert/strict";
import {caravelSafeExtraCatalog,caravelCheckExtraSelection,caravelSnapshotChoices} from "../supabase/functions/_shared/caravel-extra-selection.ts";

const sid="acct_eur";
const money=amount=>({amount,currency:"EUR"});
const records=[
 {supplier_id:sid,extra_id:"gps-1",code:"EQ-GPS",category:"navigation",name:"GPS",
  unit_price:money(700),price_cap:null,pricing_type:"per_day",requires_quantity:false,
  quantity:{min:0,max:1},payable:"at_pickup"},
 {supplier_id:sid,extra_id:"seat-1",code:"EQ-SEAT",category:"child_seat",name:"Baby seat",
  unit_price:money(200),price_cap:null,pricing_type:"per_rental",requires_quantity:true,
  quantity:{min:0,max:2},payable:"at_pickup"},
 {supplier_id:sid,extra_id:"second-driver",code:"DRIVER-2",category:"additional_driver",
  name:"Additional driver",unit_price:money(500),price_cap:null,pricing_type:"per_day",
  requires_quantity:false,quantity:{min:0,max:1},payable:"at_pickup"},
 {supplier_id:sid,extra_id:"prepay-1",code:"PREPAY",category:"other",name:"Prepaid service",
  unit_price:money(300),price_cap:null,pricing_type:"per_rental",
  requires_quantity:false,quantity:{min:0,max:1},payable:"prepaid"},
];
test("supplier catalogue includes only independently priced pay-on-arrival extras",()=>{
 const {catalog,unavailable,driverServices}=caravelSafeExtraCatalog(records,sid);
 assert.deepEqual(catalog.map(x=>x.extra_id),["gps-1","seat-1"]);
 assert.equal(driverServices[0].extra_id,"second-driver");
 assert.equal(catalog[0].name_pl,"Nawigacja GPS");
 assert.equal(catalog[1].name_pl,"Fotelik dziecięcy — Baby seat");
 assert.equal(catalog[1].max_quantity,2);
 assert.deepEqual(unavailable.map(x=>x.reason),["PAYMENT_METHOD_UNSUPPORTED"]);
});
test("exact supplier quote lines, quantities, money and caps are required",()=>{
 const {catalog}=caravelSafeExtraCatalog(records,sid);
 const selected=[{extra_id:"gps-1",quantity:1},{extra_id:"seat-1",quantity:2}];
 const lines=[{code:"EQ-GPS",quantity:1,totalMinor:2100},{code:"EQ-SEAT",quantity:2,totalMinor:400}];
 const checked=caravelCheckExtraSelection(selected,catalog,lines,3);
 assert.equal(checked.ok,true);
 assert.equal(checked.totalMinor,2500);
 assert.deepEqual(checked.priced.map(x=>x.name_pl),["Nawigacja GPS","Fotelik dziecięcy — Baby seat"]);
 for(const bad of [
  lines.slice(0,1),
  [lines[0],{...lines[1],quantity:1}],
  [lines[0],{...lines[1],totalMinor:500}],
  [{...lines[0],code:"EQ-OTHER"},lines[1]],
  [{...lines[0],totalMinor:9999},lines[1]],
 ])assert.equal(caravelCheckExtraSelection(selected,catalog,bad,3).ok,false,JSON.stringify(bad));
 assert.equal(caravelCheckExtraSelection(selected,catalog,null,3).ok,false);
 assert.equal(caravelCheckExtraSelection([],catalog,[lines[0]],3).ok,false);
});
test("reject forged, duplicated, excessive or prepayment-only selections",()=>{
 const {catalog}=caravelSafeExtraCatalog(records,sid);
 for(const choices of [
  [{extra_id:"gps-1",quantity:0}],
  [{extra_id:"gps-1",quantity:2}],
  [{extra_id:"seat-1",quantity:3}],
  [{extra_id:"prepay-1",quantity:1}],
  [{extra_id:"second-driver",quantity:1}],
  [{extra_id:"gps-1",quantity:1},{extra_id:"gps-1",quantity:1}],
 ])assert.equal(caravelCheckExtraSelection(choices,catalog,[],3).ok,false,JSON.stringify(choices));
 assert.equal(caravelSnapshotChoices([{extra_id:"seat-1",quantity:1},{extra_id:"seat-1",quantity:1}]),null);
 assert.deepEqual(caravelSnapshotChoices([]),[]);
});
test("reference identity and currency never leak across suppliers",()=>{
 assert.deepEqual(caravelSafeExtraCatalog(records,"different", "EUR").catalog,[]);
 assert.throws(()=>caravelSafeExtraCatalog([records[0],records[0]],sid),/IDENTITY/);
 assert.throws(()=>caravelSafeExtraCatalog(records,sid,"USD"),/REFERENCE_INVALID/);
});

test("three supplier child seats remain distinguishable in Polish without inventing age limits",()=>{
 const one={...records[1],extra_id:"seat-a",code:"SEAT-A",name:"Baby seat"};
 const two={...records[1],extra_id:"seat-b",code:"SEAT-B",name:"Child seat"};
 const three={...records[1],extra_id:"seat-c",code:"SEAT-C",name:"Child seat"};
 const {catalog}=caravelSafeExtraCatalog([one,two,three],sid);
 assert.equal(new Set(catalog.map(x=>x.name_pl)).size,3);
 assert.match(catalog[0].name_pl,/Baby seat/);
 assert.match(catalog[1].name_pl,/SEAT-B/);
 assert.match(catalog[2].name_pl,/SEAT-C/);
});

test("four-day supplier quote bills equipment days and a free named driver",()=>{
 const {catalog,driverServices}=caravelSafeExtraCatalog(records.map(e=>e.category==="additional_driver"?{...e,unit_price:money(0)}:e),sid);
 const choices=[{extra_id:"gps-1",quantity:1},{extra_id:"second-driver",quantity:1}];
 const lines=[{code:"EQ-GPS",quantity:4,totalMinor:2800},{code:"DRIVER-2",quantity:4,totalMinor:0}];
 const result=caravelCheckExtraSelection(choices,[...catalog,...driverServices],lines,4);
 assert.equal(result.ok,true);
 assert.deepEqual(result.priced.map(e=>[e.quantity,e.billed_quantity,e.total_minor]),[[1,4,2800],[1,4,0]]);
 assert.equal(caravelCheckExtraSelection(choices,[...catalog,...driverServices],[{...lines[0],quantity:3},lines[1]],4).ok,false);
});
