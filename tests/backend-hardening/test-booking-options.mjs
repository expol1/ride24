import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAcceptedQuote, makeBookingQuote, priceFingerprint, validateDriverExtra, pricedExtrasEnabled, loadBookingOptions } from '../../supabase/functions/_shared/booking-options.mjs';
const options={pickup:{id:'p',name:'Airport',amount:50},dropoff:{id:'d',name:'City',amount:0},catalog:[]};
const input={options,selections:[],hasAdditionalDriver:false,context:{userId:'u',carId:'c'},rental:{base_total:200,final_total:250},days:7,marginPercent:25,loyaltyPercent:0,currency:'EUR',exchangeRate:4.3};
test('quote fingerprint accepts only the displayed current price',async()=>{const q=await makeBookingQuote(input);assert.ok(assertAcceptedQuote({pricing_version:2,pricing_fingerprint:q.publicQuote.fingerprint},q.publicQuote,options));const changed=await makeBookingQuote({...input,options:{...options,pickup:{...options.pickup,amount:60}}});assert.throws(()=>assertAcceptedQuote({pricing_version:2,pricing_fingerprint:q.publicQuote.fingerprint},changed.publicQuote,options),/Cena/);});
test('old Android cannot silently pay delivery fees',()=>assert.throws(()=>assertAcceptedQuote({}, {},options),e=>e.code==='PRICING_UPDATE_REQUIRED'));
test('old Android free locations retain their existing booking flow',()=>assert.equal(assertAcceptedQuote({}, {},{...options,pickup:{...options.pickup,amount:0}}),false));
test('fingerprint changes for user, dates, rate and totals',async()=>{const q=await makeBookingQuote(input);for(const variant of [{...input,context:{userId:'another'}},{...input,exchangeRate:4.31},{...input,loyaltyPercent:10}])assert.notEqual((await makeBookingQuote(variant)).publicQuote.fingerprint,q.publicQuote.fingerprint);assert.notEqual(await priceFingerprint(q.snapshot,{date:'changed'}),q.publicQuote.fingerprint);});
const driver={id:'driver',active:true,code:'additional_driver'};
test('driver service and selected driver must agree',()=>{validateDriverExtra([driver],[{id:'driver',quantity:1}],true);validateDriverExtra([driver],[],false);for(const [s,has] of [[[],true],[[{id:'driver',quantity:1}],false],[[{id:'driver',quantity:2}],true]])assert.throws(()=>validateDriverExtra([driver],s,has),e=>e.code==='DRIVER_EXTRA_MISMATCH');});
test('existing free driver service is retained if no catalog entry',()=>validateDriverExtra([],[],true));
function adminMock(result){const q={select:()=>q,eq:()=>q,single:async()=>result};return {from:()=>q};}
test('missing feature flag fails closed instead of bypassing charges',async()=>{await assert.rejects(pricedExtrasEnabled(adminMock({error:{message:'missing'}})));assert.equal(await pricedExtrasEnabled(adminMock({data:{priced_extras_enabled:false}})),false);});
test('foreign/missing location cannot be billed as free',async()=>{const q={select:()=>q,eq:()=>q,order:async()=>({data:[]}),then:(a,b)=>Promise.resolve({data:[]}).then(a,b)};await assert.rejects(loadBookingOptions({from:()=>q},'partner','Foreign','City'),e=>e.code==='LOCATION_UNAVAILABLE');});
