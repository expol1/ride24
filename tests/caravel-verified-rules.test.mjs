import test from "node:test";
import assert from "node:assert/strict";
import {validateCaravelSelection} from "../supabase/functions/_shared/caravel-verified-rules.ts";
const day=86400000;
const base=()=>({
 pickupEpochMs:Date.UTC(2027,0,10),
 dropoffEpochMs:Date.UTC(2027,0,13),
 driverAge:30,
 rules:{minRentalMinutes:2*1440,minDriverAge:21,maxDriverAge:75,currency:"EUR"},
 extras:[
  {externalId:"free",name:"Free child seat",unitAmountMinor:0,currency:"EUR",chargingUnit:"rental",maxQuantity:1,selectedQuantity:1},
  {externalId:"gps",name:"GPS",unitAmountMinor:500,currency:"EUR",chargingUnit:"day",maxQuantity:1,selectedQuantity:1}
 ],
 rentalDaysForPricing:3
});
test("free and paid extras are validated and priced in minor units",()=>{
 const result=validateCaravelSelection(base());
 assert.deepEqual(result,{ok:true,rentalMinutes:4320,extrasAmountMinor:1500});
});
test("rejects rental shorter than confirmed minimum",()=>{
 const input=base();input.dropoffEpochMs=input.pickupEpochMs+day;
 assert.ok(!validateCaravelSelection(input).ok);
});
test("enforces both age bounds",()=>{
 for(const age of [20,76]){const input=base();input.driverAge=age;assert.ok(!validateCaravelSelection(input).ok);}
});
test("unknown mandatory rules fail closed",()=>{
 const input=base();input.rules.minRentalMinutes=0;
 assert.ok(!validateCaravelSelection(input).ok);
});
test("missing chargeable days fails closed for selected paid daily extras",()=>{
 const input=base();delete input.rentalDaysForPricing;
 assert.ok(!validateCaravelSelection(input).ok);
});
test("unselected daily extras do not add charges",()=>{
 const input=base();input.extras[1].selectedQuantity=0;delete input.rentalDaysForPricing;
 assert.equal(validateCaravelSelection(input).extrasAmountMinor,0);
});
test("rejects unsupported extra quantities and mismatched currency",()=>{
 const input=base();input.extras[1].selectedQuantity=2;input.extras[1].currency="USD";
 assert.ok(!validateCaravelSelection(input).ok);
});
