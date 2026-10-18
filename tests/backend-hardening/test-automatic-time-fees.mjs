import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBookingItems as calc, customerPricing, partnerItems } from '../../supabase/functions/_shared/booking-items.mjs';
import { assertAcceptedQuote, makeBookingQuote } from '../../supabase/functions/_shared/booking-options.mjs';

const base = {
  rental:{base_total:100,final_total:120},
  pickup:{id:'airport',name:'Airport',amount:0},
  dropoff:{id:'office',name:'Office',amount:0},
  days:5,marginPercent:20,loyaltyPercent:0,currency:'EUR',exchangeRate:4.3,
  pickupTime:'23:30',returnTime:'06:15',
};
const night={id:'night',applies_to:'pickup',starts_at:'22:00:00',ends_at:'07:00:00',
  amount:'50.00',once_per_booking:true,active:true,location_id:null};

test('Madeira-style pickup at 23:30 automatically adds 50 EUR without selection',()=>{
  const q=calc({...base,timeRules:[night],catalog:[],selections:[]});
  assert.equal(q.items.length,2);
  assert.equal(q.items[1].kind,'time_fee');
  assert.equal(q.items[1].partner_cents,5000);
  assert.equal(q.items[1].customer_cents,6000);
  assert.equal(q.partner_cents,15000);
  assert.equal(q.total_cents,18000);
  assert.equal(customerPricing(q).items[1].kind,'time_fee');
  assert.equal(partnerItems(q)[1].amount_cents,5000);
});
test('night rule crosses midnight; 07:00 is outside and 22:00 is inside',()=>{
  for(const pickupTime of ['22:00','23:59','00:00','06:59'])assert.equal(calc({...base,pickupTime,timeRules:[night]}).items.length,2);
  for(const pickupTime of ['07:00','12:00','21:59'])assert.equal(calc({...base,pickupTime,timeRules:[night]}).items.length,1);
});
test('either side triggers only one 50 EUR per booking when once flag is enabled',()=>{
  const rule={...night,applies_to:'either'};
  const q=calc({...base,timeRules:[rule]});
  assert.equal(q.items[1].partner_cents,5000);
  assert.equal(q.items[1].quantity,1);
  const perEvent=calc({...base,timeRules:[{...rule,once_per_booking:false}]});
  assert.equal(perEvent.items[1].partner_cents,10000);
  assert.equal(perEvent.items[1].quantity,2);
});
test('separate pickup and return fees are charged separately',()=>{
  const q=calc({...base,timeRules:[night,{...night,id:'return-rule',applies_to:'return',amount:'25.00'}]});
  assert.equal(q.items.filter(x=>x.kind==='time_fee').length,2);
  assert.equal(q.partner_cents,17500);
});
test('location restricted charge does not apply to an unrelated pickup',()=>{
  const rule={...night,location_id:'airport'};
  assert.equal(calc({...base,timeRules:[rule]}).items.length,2);
  assert.equal(calc({...base,pickup:{...base.pickup,id:'office'},timeRules:[rule]}).items.length,1);
});
test('Montenegro location surcharge remains independent from night rules',()=>{
  const q=calc({...base,pickup:{...base.pickup,amount:90},dropoff:{...base.dropoff,amount:50},pickupTime:'12:00',returnTime:'12:00',timeRules:[night]});
  assert.deepEqual(q.items.map(x=>x.kind),['rental','pickup','return']);
  assert.equal(q.partner_cents,24000);
  assert.equal(q.total_cents,28800);
});
test('hourly rules are automatic, never present in customer extras catalog',async()=>{
  const context={userId:'u',carId:'c',pickupTime:base.pickupTime,returnTime:base.returnTime};
  const {publicQuote,snapshot}=await makeBookingQuote({options:{pickup:base.pickup,dropoff:base.dropoff,catalog:[],timeRules:[night]},
    selections:[],hasAdditionalDriver:false,context,rental:base.rental,days:5,marginPercent:20,loyaltyPercent:0,currency:'EUR',exchangeRate:4.3});
  assert.equal(publicQuote.catalog.length,0);
  assert.equal(snapshot.items[1].kind,'time_fee');
  assert.ok(publicQuote.fingerprint);
  assert.throws(()=>assertAcceptedQuote({},{},{pickup:base.pickup,dropoff:base.dropoff,timeRules:[night],catalog:[]}),e=>e.code==='PRICING_UPDATE_REQUIRED');
});
test('time changes invalidate fingerprint and night pricing',async()=>{
  const options={pickup:base.pickup,dropoff:base.dropoff,catalog:[],timeRules:[night]};
  const input={options,selections:[],hasAdditionalDriver:false,context:{userId:'u',carId:'c',pickupTime:'21:30',returnTime:'06:15'},
    rental:base.rental,days:5,marginPercent:20,loyaltyPercent:0,currency:'EUR',exchangeRate:4.3};
  const old=await makeBookingQuote(input);
  const current=await makeBookingQuote({...input,context:{...input.context,pickupTime:'23:30'}});
  assert.notEqual(old.publicQuote.fingerprint,current.publicQuote.fingerprint);
  assert.throws(()=>assertAcceptedQuote({pricing_version:2,pricing_fingerprint:old.publicQuote.fingerprint},current.publicQuote,options),e=>e.code==='QUOTE_CHANGED');
});
test('zero length and invalid windows fail closed',()=>{
  for(const bad of [{...night,starts_at:'22:00',ends_at:'22:00'},{...night,starts_at:'xxx'}])
    assert.throws(()=>calc({...base,timeRules:[bad]}));
});
