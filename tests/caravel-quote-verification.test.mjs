import test from "node:test";
import assert from "node:assert/strict";
import {verifyCaravelQuote} from "../supabase/functions/_shared/caravel-quote-verification.ts";
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
