import test from "node:test";
import assert from "node:assert/strict";
import {caravelVoucherPricing} from "../supabase/functions/_shared/caravel-voucher-pricing.mjs";
import {validateVoucherPricing} from "../supabase/functions/_shared/voucher-booking-items.mjs";
const id="10000000-0000-4000-8000-000000000001",qid="20000000-0000-4000-8000-000000000002",pid="78721481-7619-44df-a9b7-5faa344b69bb",ref="30000000-0000-4000-8000-000000000003";
const booking={id,api_quote_id:qid,partner_id:pid,caravel_supplier_quote_id:ref,partner_currency:"EUR",
 pickup_payment_partner_currency:183,online_payment_pln:64.5};
const quote={id:qid,booking_id:id,partner_id:pid,external_quote_reference:ref,currency:"EUR",
 partner_net_total:183,commission_total:15,final_total:198,raw_response:{provider_quote_data:{
 provider:"caravel",payment_model:"pay_on_arrival",price_breakdown:{
 version:1,currency:"EUR",rental_minor:15000,mandatory_fees_minor:3300,extras_minor:0,total_minor:18300,
 fees:[{label:"Young driver",type:"young_driver",amount_minor:3300}],extras:[],
 }}}};
test("Caravel voucher: paid partner quote and independent Ride24 fee, with mandatory charge",()=>{
 const p=validateVoucherPricing(caravelVoucherPricing(booking,quote));
 assert.equal(p.partner_cents,18300);
 assert.equal(p.total_cents,19800);
 assert.equal(p.online_pln_cents,6450);
 // Like other partners: no separate Ride24 fee line; the fee is in the rental price.
 assert.deepEqual(p.items.map(x=>x.kind),["rental","fee"]);
 assert.equal(p.items[0].customer_cents,16500);
 assert.equal(p.items[0].partner_cents,15000);
 assert.equal(p.commission_cents,1500);
 assert.ok(!p.items.some(x=>/Ride24/.test(x.name_en+x.name_pl)));
 assert.equal(p.items[1].name_pl,"Młody kierowca");
 assert.equal(p.items[1].customer_cents,3300);
});
test("Caravel voucher: GPS and two child seats shown as distinct supplier-priced lines",()=>{
 const extraQuote=structuredClone(quote);
 extraQuote.partner_net_total=213;extraQuote.final_total=228;
 const bd=extraQuote.raw_response.provider_quote_data.price_breakdown;
 bd.extras_minor=3000;bd.total_minor=21300;
 bd.extras=[{extra_id:"gps-1",code:"EQ-GPS",quantity:1,name_pl:"Nawigacja GPS",name_en:"GPS",amount_minor:1800},
 {extra_id:"seat-1",code:"EQ-SEAT",quantity:2,name_pl:"Fotelik dziecięcy",name_en:"Child seat",amount_minor:1200}];
 const b={...booking,pickup_payment_partner_currency:213};
 const p=validateVoucherPricing(caravelVoucherPricing(b,extraQuote));
 assert.equal(p.partner_cents,21300);
 assert.equal(p.total_cents,22800);
 assert.equal(p.items.filter(x=>x.kind==="extra").length,2);
 assert.equal(p.items.find(x=>x.name_en==="Child seat").quantity,2);
});
test("Caravel voucher: fail closed on tampered supplier total, cross-booking and extra lines",()=>{
 const bad=structuredClone(quote);bad.partner_net_total=184;
 assert.throws(()=>caravelVoucherPricing(booking,bad),/TOTALS/);
 const crossed={...booking,api_quote_id:"99999999-9999-4999-8999-999999999999"};
 assert.throws(()=>caravelVoucherPricing(crossed,quote),/SCOPE/);
 const missing=structuredClone(quote);missing.raw_response.provider_quote_data.price_breakdown.extras_minor=1;
 assert.throws(()=>caravelVoucherPricing(booking,missing),/TOTALS/);
});
