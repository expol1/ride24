import test from "node:test";
import assert from "node:assert/strict";
import {issueVerifiedCaravelQuote}
 from "../supabase/functions/_shared/caravel-quote-issuance.ts";
import {assertApiQuoteContext}
 from "../supabase/functions/_shared/api-quote-contract.mjs";
const NOW=Date.UTC(2026,10,18,11,30,0);
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const CAR="d20bbca4-678c-4abf-bf4d-cf5356220170";
const QID="3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0c9e11";
const RID="4da4d7ca-7244-4416-ab7b-2632bd5f882a";
const IDENTITY="e2d2d947-d147-4975-b757-a9e76b52765d";
const HASH="a".repeat(64);
const money=(n=0)=>({amount:n,currency:"EUR"});
const protection=()=>({protection_id:"pro-premium",tier:"premium",
 product_type:"waiver",deposit:money(),excess:money(),theft_excess:money(),
 covers:["bodywork","theft","fire","glass","tyres_and_wheels","undercarriage"],
 excludes:[]});
const terms=()=>({document_id:"caravel-en-v4",language:"en",version:4,
 title:"Caravel Terms",format:"clauses/v1",
 content_hash:HASH,published_at:"2026-11-17T10:00:00Z",withdrawn_at:null});
const selection=()=>({
 pickup:{location_id:"ath-airport",at:"2027-01-10T10:00:00+02:00"},
 dropoff:{location_id:"ath-airport",at:"2027-01-13T10:00:00+02:00"},
 vehicle_id:"opaque-group",protection_id:"pro-premium",
 plan:"premium",currency:"EUR",drivers:[{age:30,role:"main"}],extras:[],
});
const supplier=()=>({supplier_id:"acct_eur",status:"active",currency:"EUR",
 tax_inclusive:true,payment_models:["pay_on_arrival"]});
const quote=()=>({quote_id:QID,status:"active",plan:"premium",
 currency:"EUR",payment_model:"pay_on_arrival",rental_days:3,
 expires_at:new Date(NOW+60*60000).toISOString(),
 totals:{grand_total:money(15000),pay_now:money(),pay_at_pickup:money(15000)},
 deposit:{amount:money()},
 line_items:[{kind:"base_rate",total:money(15000)}],
});
function db(){
 const state={partner:{id:PARTNER,api_provider:"caravel",api_enabled:true,
   api_status:"synced",provider_type:"api",active:true,
   account_status:"active",currency:"EUR",discount_percent:"0"},
   car:{id:CAR,partner_id:PARTNER,external_id:"opaque-group",active:true},
   quotes:[],lookups:0};
 return {state,from(table){
   if(table==="api_quotes")return {insert:row=>({
    select:columns=>({single:async()=>{
     assert.equal(columns,"id");
     state.quotes.push(row);
     return {data:{id:RID},error:null};
    }}),
   })};
   return {select:cols=>{const filters=[];
    const chain={
      eq:(col,v)=>{filters.push([col,v]);return chain;},
      maybeSingle:async()=>{
       state.lookups++;
       const data=table==="partners"?state.partner:
         table==="car_classes"?state.car:null;
       if(!data||filters.some(([k,v])=>data[k]!==v))
         return {data:null,error:null};
       return {data:{...data},error:null};
      },
    };return chain;
   }};
 }};
}
function client(){
 const state={quotes:0,supplierLists:0,termsLists:0,
   supplier:supplier(),quote:quote(),activeTerms:[terms()]};
 return {state,environment:"sandbox",
  async suppliers(){state.supplierLists++;return {data:[state.supplier]};},
  async referenceTerms(id){state.termsLists++;assert.equal(id,"acct_eur");
   return {data:state.activeTerms};},
  async quote(req,idempotency,supplierId){
   assert.deepEqual(req,selection());
   assert.equal(idempotency,IDENTITY);
   assert.equal(supplierId,"acct_eur");
   state.quotes++;return {data:state.quote};
  },
 };
}
const args=(admin,c,overrides={})=>({
 admin,client:c,idempotencyKey:IDENTITY,
 supplierId:"acct_eur",carClassId:CAR,
 quoteRequest:selection(),
 startDate:"2027-01-10",endDate:"2027-01-13",
 pickupLocalTime:"10:00",dropoffLocalTime:"10:00",
 pickupDisplayName:"Athens Airport",dropoffDisplayName:"Athens Airport",
 rentalDays:3,nowEpochMs:NOW,reviewedTerms:{
   supplierId:"acct_eur",language:"en",documentId:"caravel-en-v4",
   version:4,contentHash:HASH,publishedAt:terms().published_at,
 },canonicalHashIndependentlyVerified:true,
 protection:protection(),
 allowProductionQuoteIssuance:false,...overrides,
});
test("server verifies Caravel zero-prepay quote before saving standard Ride24 api_quotes row",async()=>{
 const admin=db(),c=client();
 const r=await issueVerifiedCaravelQuote(args(admin,c));
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.apiQuoteId,RID);
 assert.equal(r.providerQuoteId,QID);
 assert.equal(r.partnerPayableMinor,15000);
 assert.equal(c.state.quotes,1);
 assert.equal(admin.state.quotes.length,1);
 const saved=admin.state.quotes[0];
 assert.equal(saved.partner_id,PARTNER);
 assert.equal(saved.partner_discount_percent,0);
 assert.equal(saved.platform_margin_percent,0);
 assert.equal(saved.commission_total,0);
 assert.equal(saved.partner_net_total,150);
 assert.equal(saved.final_total,150);
 assert.equal(saved.external_quote_reference,QID);
 assert.equal(saved.raw_response.provider_quote_data.terms_document_id,"caravel-en-v4");
 assert.equal(saved.raw_response.provider_quote_data.protection.tier,"premium");
 assert.equal(saved.raw_response.provider_quote_data.amounts_minor.pay_now,0);
 assertApiQuoteContext(saved.raw_response,{
  pickup_time:"10:00",return_time:"10:00",
  pickup_location:"Athens Airport",return_location:"Athens Airport",
 });
});
test("no external supplier contact without independently verified terms or approved server selection",async()=>{
 for(const patch of [
  {canonicalHashIndependentlyVerified:false},
  {idempotencyKey:"bad"},
  {quoteRequest:{...selection(),plan:"basic"}},
  {quoteRequest:{...selection(),extras:[{extra_id:"gps",quantity:1}]}},
  {quoteRequest:{...selection(),currency:"USD"}},
  {quoteRequest:{...selection(),drivers:[{age:18,role:"additional"}]}},
  {pickupLocalTime:"14:00"},
  {startDate:"2027-01-11"},
  {pickupDisplayName:""},
 ]){
  const admin=db(),c=client();
  const r=await issueVerifiedCaravelQuote(args(admin,c,patch));
  assert.equal(r.ok,false,JSON.stringify(patch));
  assert.equal(c.state.quotes,0);
  assert.equal(admin.state.quotes.length,0);
 }
});
test("partner disabled or category changed prevents all Caravel supplier reads",async()=>{
 for(const [table,patch] of [
  ["partner",{api_enabled:false}],["partner",{api_provider:"custom"}],
  ["partner",{api_status:"draft"}],["partner",{discount_percent:"10"}],
  ["car",{active:false}],["car",{external_id:"different"}],
 ]){
  const admin=db(),c=client();
  Object.assign(admin.state[table],patch);
  const r=await issueVerifiedCaravelQuote(args(admin,c));
  assert.equal(r.ok,false,JSON.stringify(patch));
  assert.equal(c.state.supplierLists,0);
  assert.equal(c.state.quotes,0);
 }
});
test("unapproved pay-now, short quote expiry and changed supplier terms never reach Stripe",async()=>{
 for(const patch of [
  {totals:{...quote().totals,pay_now:money(3000),pay_at_pickup:money(12000)}},
  {expires_at:new Date(NOW+1000).toISOString()},
  {status:"expired"},{plan:"basic"},
  {line_items:[{kind:"base_rate",total:money(14900)}]},
  {deposit:{amount:money(20000)}},
  {payment_model:"prepaid"},
 ]){
  const admin=db(),c=client();c.state.quote={...quote(),...patch};
  const r=await issueVerifiedCaravelQuote(args(admin,c));
  assert.equal(r.ok,false,JSON.stringify(patch));
  assert.equal(admin.state.quotes.length,0);
 }
 const admin=db(),c=client();
 c.state.activeTerms=[{...terms(),document_id:"caravel-en-v5",version:5,
  content_hash:"b".repeat(64)}];
 const r=await issueVerifiedCaravelQuote(args(admin,c));
 assert.equal(r.ok,false);
 assert.equal(c.state.quotes,0);
 assert.equal(admin.state.quotes.length,0);
});
test("supplier offering prepaid-only or no tax-inclusive quotes fails before quote API",async()=>{
 for(const patch of [
  {tax_inclusive:false},{payment_models:["prepaid"]},{currency:"GBP"},
  {status:"inactive"},
 ]){
  const admin=db(),c=client();c.state.supplier={...supplier(),...patch};
  const r=await issueVerifiedCaravelQuote(args(admin,c));
  assert.equal(r.ok,false,JSON.stringify(patch));
  assert.equal(c.state.quotes,0);
 }
});
test("production Caravel quote requests require explicit operator gate",async()=>{
 const admin=db(),c=client();c.environment="production";
 const r=await issueVerifiedCaravelQuote(args(admin,c));
 assert.equal(r.ok,false);
 assert.equal(r.reason,"CARAVEL_QUOTE_PRODUCTION_NOT_AUTHORIZED");
 assert.equal(c.state.supplierLists,0);
 assert.equal(admin.state.quotes.length,0);
});
test("no quote is published when Ride24 database insert fails",async()=>{
 const admin=db(),base=admin.from.bind(admin),c=client();
 admin.from=name=>name==="api_quotes"?{
  insert:()=>({select:()=>({single:async()=>({
    data:null,error:{message:"write failed"},
  })})}),
 }:base(name);
 const r=await issueVerifiedCaravelQuote(args(admin,c));
 assert.equal(r.ok,false);
 assert.equal(r.reason,"CARAVEL_QUOTE_DB_WRITE_FAILED");
});
