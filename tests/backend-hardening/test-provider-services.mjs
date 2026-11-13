import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileAvailabilityServices,selectedServices,applyProviderSelections,verifySelectedServices,providerPricingSnapshot,providerServiceCatalog} from '../../supabase/functions/_shared/provider-services.mjs';
import {assertApiOptionsQuote} from '../../supabase/functions/_shared/api-quote-contract.mjs';
import {validateVoucherPricing} from '../../supabase/functions/_shared/voucher-booking-items.mjs';
const service=(id,code,total,selected,mandatory=false,quantity=1)=>({ServiceId:id,Code:code,Name:code,Quantity:quantity,IsSelected:selected,IsMandatory:mandatory,IsRent:code==='CAR-RENT',IsQuantityEditable:true,MaximumQuantity:4,Prepaid:false,ServicePrice:{Currency:'EUR',Amount:total,AmountTotal:total,MaxDurationMeasuringUnitForPayment:10}});
const model=()=>({Currency:'EUR',Total:284.72,Services:[service(361,'CAR-RENT',124.72,true,true),service(119,'FEE-OOH',80,true,true),service(121,'FEE-OOH',80,true,true),service(489,'EQ-BABYSEAT',37.5,false)]});
test('night fees are reconciled once against supplier total',()=>{
 const o={Amount:284.72,CarRentalAmount:124.72,IncludedServices:[{ServiceId:119,Name:'pickup',AmountTotal:80,Prepaid:false},{ServiceId:121,Name:'return',AmountTotal:80,Prepaid:false}]};
 assert.equal(reconcileAvailabilityServices(o),true);assert.throws(()=>reconcileAvailabilityServices({...o,Amount:364.72}));
 assert.throws(()=>reconcileAvailabilityServices({...o,IncludedServices:[{ServiceId:119,Name:'pickup',AmountTotal:null,Prepaid:false}]}));
});
test('period prices are not multiplied by days and limits come from supplier',()=>{
 const c=providerServiceCatalog(model(),10);assert.equal(c[0].unit_customer_cents,4125);assert.equal(c[0].billing,'rental');assert.equal(c[0].max_quantity,4);
});
test('selections cannot change mandatory fees or inject unknown service IDs',()=>{
 for(const xs of [[{id:'119',quantity:1}],[{id:'489',quantity:5}],[{id:'489',quantity:0}],[{id:'489',quantity:1},{id:'489',quantity:1}]])assert.throws(()=>applyProviderSelections(model(),xs));
 const m=applyProviderSelections(model(),[{id:'489',quantity:2}]);assert.equal(m.Services[3].Quantity,2);assert.equal(m.Services[3].IsSelected,true);assert.equal(model().Services[3].IsSelected,false);
});
test('provider must echo selected quantities and reconcile totals',()=>{
 const requested=applyProviderSelections(model(),[{id:'489',quantity:2}]);assert.throws(()=>verifySelectedServices(requested,model()));
 const c=structuredClone(requested);c.Services[3].ServicePrice.AmountTotal=75;c.Total=359.72;verifySelectedServices(requested,c);
 c.Services[3].Quantity=1;assert.throws(()=>verifySelectedServices(requested,c));
});
test('snapshot uses common voucher schema and preserves partner amount',()=>{
 const s=providerPricingSnapshot(model(),{marginPercent:10,loyaltyPercent:5,exchangeRate:4.3,days:3});
 assert.equal(s.partner_cents,28472);assert.equal(s.gross_cents,31319);assert.equal(s.items.length,3);assert.equal(validateVoucherPricing(s),s);
});
test('quote bound to customer, drivers, selections and consent',()=>{
 const snapshot=providerPricingSnapshot(model(),{marginPercent:10,loyaltyPercent:0,exchangeRate:4.3,days:3});
 const raw={ride24_options:{fingerprint:'abc',snapshot,binding:{user_id:'user1',driver_id:null,additional_driver_id:null,ages:[35],selections:[]}}};
 const body={pricing_version:2,pricing_fingerprint:'abc',extras:[]};assert.equal(assertApiOptionsQuote(raw,body,'user1',[35]),snapshot);
 assert.throws(()=>assertApiOptionsQuote(raw,body,'user2',[35]));assert.throws(()=>assertApiOptionsQuote(raw,body,'user1',[18]));assert.throws(()=>assertApiOptionsQuote(raw,{...body,extras:[{id:'489',quantity:1}]},'user1',[35]));
});

test('zero optional price needs an explicit supplier free/included flag',()=>{
 const m=model(); const seat=m.Services[3];seat.ServicePrice.Amount=0;
 assert.equal(providerServiceCatalog(m).length,0);
 assert.throws(()=>applyProviderSelections(m,[{id:'489',quantity:1}]));
 seat.ServicePrice.FreeOfCharge=true;assert.equal(providerServiceCatalog(m)[0].unit_customer_cents,0);
 seat.ServicePrice.Amount=null;assert.equal(providerServiceCatalog(m).length,0);
 const selected=applyProviderSelections(model(),[{id:'489',quantity:1}]);
 const bad=structuredClone(selected);bad.Services[3].ServicePrice.Amount=0;bad.Services[3].ServicePrice.AmountTotal=0;
 assert.throws(()=>verifySelectedServices(selected,bad),/PRICE_UNCONFIRMED/);
});
test('recorded live AVIA period and quantity totals match supplied tariff caps',async()=>{
 const {readFile}=await import('node:fs/promises');
 const evidence=JSON.parse(await readFile(new URL('../../maintenance/2026-11-13-avia-extras-audit.json',import.meta.url),'utf8'));
 const daily={'EQ-BABYSEAT':12.5,'EQ-CHILDSEAT':12.5,'EQ-BOOSTER':7,'EQ-GPS':8,'FEE-WINTERTIRE':12.5,'ADD-DRIVER':9};
 assert.deepEqual(evidence.cases.map(x=>x.days),[1,3,7,10,11,14]);
 for(const c of evidence.cases)for(const s of c.services){
  if(daily[s.code]){assert.equal(s.unit_period,daily[s.code]*Math.min(c.days,10));assert.equal(s.total,s.unit_period*s.quantity);}
  if(s.code==='FEE-FERRY')assert.equal(s.total,50);
  if(s.code==='EQ-CHAINS')assert.equal(s.total,0); // Recorded conflict, not an accepted tariff.
 }
});
