import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {calculateBookingItems} from '../../supabase/functions/_shared/booking-items.mjs';
import {driverAgeAllowed,driverAgeLimits} from '../../supabase/functions/_shared/driver-age.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const browser={window:{}};vm.runInNewContext(read('assets/js/results-location-pricing.js'),browser);
const pricing=browser.window.Ride24ResultPricing;
const base={rental:{base_total:100,final_total:110},pickup:{id:'pickup',name:'Airport',amount:40,free_from_rental_days:7},dropoff:{id:'return',name:'City',amount:30,free_from_rental_days:10},days:7,marginPercent:10,currency:'EUR',exchangeRate:4.3};
for(const [days,expected] of [[6,70],[7,30],[9,30],[10,0],[11,0]]) test(`location thresholds at ${days} days agree in search and server quote`,()=>{
 const quote=calculateBookingItems({...base,days});
 const fees=quote.items.filter(x=>['pickup','return'].includes(x.kind));
 assert.equal(fees.reduce((sum,x)=>sum+x.partner_cents,0),expected*100);
 const car={partners:{id:'p',partner_locations:[{location_name:'Airport',extra_fee:true,extra_fee_amount:40,free_from_rental_days:7}]}};
 const result=pricing.selectedLocationFees(car,'Airport','City',new Map([['p',[{return_fee_amount:30,free_from_rental_days:10}]]]),days);
 assert.equal(result.pickup+result.return,expected);
 assert.equal(pricing.customerLocationFeeTotal(result,10),expected*1.1);
});
test('unset threshold preserves charges and old snapshot stays unchanged',()=>{
 const input={...base,pickup:{...base.pickup,free_from_rental_days:null},dropoff:{...base.dropoff,free_from_rental_days:null}};
 const old=calculateBookingItems(input);const serialized=JSON.stringify(old);
 input.pickup.free_from_rental_days=1;
 assert.equal(JSON.stringify(old),serialized);
 assert.equal(old.items.filter(x=>['pickup','return'].includes(x.kind)).length,2);
});
test('free standard location does not waive night or conditional charges',()=>{
 const quote=calculateBookingItems({...base,days:10,pickupTime:'23:00',returnTime:'10:00',timeRules:[{id:'night',active:true,location_id:'pickup',applies_to:'pickup',starts_at:'22:00',ends_at:'07:00',amount:15,once_per_booking:true}],conditionalFees:[{id:'special',active:true,kind:'location_either',location_id:'pickup',name_pl:'Dopłata',name_en:'Fee',amount:5}]});
 assert.deepEqual(quote.items.map(x=>x.kind),['rental','conditional_fee','time_fee']);
});
test('age inheritance, override and inclusive maximum',()=>{
 assert.deepEqual(driverAgeLimits({min_driver_age:null},{min_driver_age:25,max_driver_age:80}),{min:25,max:80});
 for(const age of [25,80]) assert.equal(driverAgeAllowed(age,{}, {min_driver_age:25,max_driver_age:80}),true);
 for(const age of [24,81,null,25.5]) assert.equal(driverAgeAllowed(age,{}, {min_driver_age:25,max_driver_age:80}),false);
 assert.equal(driverAgeAllowed(21,{min_driver_age:21},{min_driver_age:25}),true);
 assert.equal(driverAgeAllowed(20,{min_driver_age:null},{min_driver_age:null,max_driver_age:null}),false);
 assert.equal(driverAgeAllowed(90,{}, {max_driver_age:null}),true);
 assert.equal(driverAgeAllowed(null,{driver_included:true},{min_driver_age:25}),true);
});
test('new vehicle field belongs to vehicle form and settings fields are unique',()=>{
 const doc=new JSDOM(read('partner-dashboard.html')).window.document;
 assert.ok(doc.querySelector('#vehicleForm #carMinAge'));
 for(const id of ['carMinAge','partner-max-age','locFreeFromDays']) assert.equal(doc.querySelectorAll('#'+id).length,1);
 assert.equal(doc.querySelector('#carMinAge').value,'');
});
