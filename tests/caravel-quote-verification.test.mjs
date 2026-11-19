import test from "node:test";
import assert from "node:assert/strict";
import {verifyCaravelQuote,verifyCaravelMandatoryCharges} from "../supabase/functions/_shared/caravel-quote-verification.ts";
const base=()=>({currency:"EUR",rentalAmountMinor:12000,extrasAmountMinor:1500,mandatoryFeesAmountMinor:300,totalAmountMinor:13800,quoteId:"sandbox-quote",expiresAtEpochMs:2000000000000,plan:"Premium",depositAmountMinor:0,excessAmountMinor:0});
test("accepts provider-confirmed Premium total including extras and mandatory fees",()=>{
 assert.deepEqual(verifyCaravelQuote(base(),1900000000000),{ok:true,partnerPayableMinor:13800,quoteId:"sandbox-quote"});
});
test("rejects missing mandatory fee or double counted extras",()=>{
 const q=base();q.totalAmountMinor=13500;assert.equal(verifyCaravelQuote(q,1900000000000).ok,false);
});
test("rejects non-Premium, deposits and excess",()=>{
 for(const patch of [{plan:"Basic"},{depositAmountMinor:100},{excessAmountMinor:100}]){
  assert.equal(verifyCaravelQuote({...base(),...patch},1900000000000).ok,false);
 }
});
test("rejects expired quote and missing reference",()=>{
 assert.equal(verifyCaravelQuote(base(),2000000000000).ok,false);
 assert.equal(verifyCaravelQuote({...base(),quoteId:""},1900000000000).ok,false);
});
test("rejects fractional and unsafe monetary values",()=>{
 assert.equal(verifyCaravelQuote({...base(),extrasAmountMinor:0.5},1900000000000).ok,false);
 assert.equal(verifyCaravelQuote({...base(),rentalAmountMinor:Number.MAX_SAFE_INTEGER},1900000000000).ok,false);
});

test("missing provider quote fields return rejection rather than crash",()=>{
 for(const patch of [{plan:null},{quoteId:null},{currency:null}]){
  const result=verifyCaravelQuote({...base(),...patch},1900000000000);
  assert.equal(result.ok,false);
 }
});

const mandatory=()=>({
 charges:[
  {externalId:"night-p",label:"Late pickup",category:"out_of_hours",amountMinor:2500,currency:"EUR"},
  {externalId:"one-way",label:"One-way",category:"one_way",amountMinor:1000,currency:"EUR"}
 ],
 quoteCurrency:"EUR",quoteMandatoryFeesMinor:3500,
 pickupLocalTime:"23:30",returnLocalTime:"10:00",
 pickupTimezone:"Europe/Athens",returnTimezone:"Europe/Athens",
 pickupOutsideHours:true,returnOutsideHours:false
});
test("recognizes supplier-confirmed night pickup fee without double counting",()=>{
 assert.deepEqual(verifyCaravelMandatoryCharges(mandatory()),{ok:true,outOfHoursAmountMinor:2500});
});
test("rejects missing out-of-hours fee when supplier indicates outside operating hours",()=>{
 const x=mandatory();x.charges=x.charges.slice(1);x.quoteMandatoryFeesMinor=1000;
 assert.ok(!verifyCaravelMandatoryCharges(x).ok);
});
test("rejects missing operating hours, timezone and unverified mandatory breakdown",()=>{
 for(const patch of [{pickupOutsideHours:null},{pickupTimezone:""},{quoteMandatoryFeesMinor:100}]){
  assert.equal(verifyCaravelMandatoryCharges({...mandatory(),...patch}).ok,false);
 }
});
test("rejects duplicate charges and mixed currencies",()=>{
 const x=mandatory();x.charges.push({...x.charges[0]});
 assert.equal(verifyCaravelMandatoryCharges(x).ok,false);
 const y=mandatory();y.charges[0].currency="USD";
 assert.equal(verifyCaravelMandatoryCharges(y).ok,false);
});

test("malformed local time values fail closed without throwing",()=>{
 for(const patch of [{pickupLocalTime:null},{returnLocalTime:123},{pickupTimezone:null},{returnTimezone:5},{pickupLocalTime:"24:00"},{returnLocalTime:"10:60"}]){
  const result=verifyCaravelMandatoryCharges({...mandatory(),...patch});
  assert.equal(result.ok,false);
 }
});
test("rejects overflow of out-of-hours fee subtotals",()=>{
 const x=mandatory();
 x.charges=[
  {externalId:"a",label:"Late pickup",category:"out_of_hours",amountMinor:Number.MAX_SAFE_INTEGER,currency:"EUR"},
  {externalId:"b",label:"Late return",category:"out_of_hours",amountMinor:1,currency:"EUR"}
 ];
 x.quoteMandatoryFeesMinor=Number.MAX_SAFE_INTEGER;
 x.returnOutsideHours=true;
 assert.equal(verifyCaravelMandatoryCharges(x).ok,false);
});
