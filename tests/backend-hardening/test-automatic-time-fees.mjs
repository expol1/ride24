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

test('Azores pickup is impossible at airport between 23:45 and 07:00',()=>{
 const airport={id:'airport',name:'Ponta Delgada Airport (PDL)',city:'Ponta Delgada',amount:7.5};
 const block={id:'block-p',location_id:'airport',applies_to:'pickup',starts_at:'23:45:00',ends_at:'07:00:00',active:true};
 for(const pickupTime of ['23:45','00:00','04:59','06:59'])assert.throws(()=>calc({...base,pickup:airport,pickupTime,timeBlocks:[block]}),/PICKUP_UNAVAILABLE_TIME/);
 for(const pickupTime of ['07:00','19:45','23:44'])assert.doesNotThrow(()=>calc({...base,pickup:airport,pickupTime,timeBlocks:[block]}));
 assert.doesNotThrow(()=>calc({...base,pickup:{...base.pickup,id:'different-point'},pickupTime:'02:00',timeBlocks:[block]}));
});
test('Azores return 23:45–05:00 is unavailable; 05:00–07:00 incurs 25 EUR',()=>{
 const office={id:'airport',name:'Ponta Delgada Airport (PDL)',city:'Ponta Delgada',amount:7.5};
 const block={id:'block-r',location_id:'airport',applies_to:'return',starts_at:'00:00:00',ends_at:'05:00:00',active:true};
 const fee={id:'return-after-hours',location_id:'airport',applies_to:'return',starts_at:'05:00:00',ends_at:'07:00:00',amount:'25.00',once_per_booking:true,active:true};
 assert.throws(()=>calc({...base,dropoff:office,returnTime:'04:59',timeBlocks:[block],timeRules:[fee]}),/RETURN_UNAVAILABLE_TIME/);
 const q=calc({...base,dropoff:office,returnTime:'05:00',timeBlocks:[block],timeRules:[fee]});
 assert.equal(q.items.filter(i=>i.kind==='time_fee')[0].partner_cents,2500);
 assert.equal(calc({...base,dropoff:office,returnTime:'07:00',timeBlocks:[block],timeRules:[fee]}).items.filter(x=>x.kind==='time_fee').length,0);
});
test('Madeira airport transfer 15 EUR is added once for either pickup or return',()=>{
 const airport={id:'fnc',name:'Madeira Airport (FNC)',city:'Funchal',amount:0};
 const fee={id:'airport-fee',active:true,kind:'location_either',location_id:'fnc',city_scope:null,name_pl:'Transfer lotnisko Madera',name_en:'Madeira Airport transfer',amount:'15.00'};
 for(const [pickup,dropoff,n] of [[airport,base.dropoff,2],[base.pickup,airport,2],[airport,airport,2],[base.pickup,base.dropoff,1]]){
 const q=calc({...base,pickup,dropoff,conditionalFees:[fee],pickupTime:'12:00'});
 assert.equal(q.items.length,n);
 if(n===2)assert.equal(q.items[1].partner_cents,1500);
 }
});
test('Portugal 120 EUR one-way charge only for two distinct mainland cities',()=>{
 const loc=city=>({id:city,name:city,city,amount:0});
 const fee={id:'cross-city',active:true,kind:'cross_city',city_scope:['Lisbon','Porto','Faro'],location_id:null,name_pl:'Zwrot w innym mieście kontynentalnym',name_en:'One-way return',amount:'120.00'};
 for(const [a,b,expected] of [['Lisbon','Porto',2],['Faro','Porto',2],['Porto','Porto',1],['Lisbon','Funchal',1],['Faro','Faro',1]]){
 const q=calc({...base,pickup:loc(a),dropoff:loc(b),pickupTime:'12:00',returnTime:'12:00',conditionalFees:[fee]});
 assert.equal(q.items.length,expected);
 if(expected===2)assert.equal(q.items[1].partner_cents,12000);
 }
});
test('Prior approval note is visible for Bulgarian conditional night service',()=>{
 const rule={...night,id:'bulgaria',applies_to:'either',amount:'20.00',starts_at:'19:40:00',ends_at:'00:00:00',requires_approval:true};
 const q=calc({...base,pickupTime:'21:00',returnTime:'12:00',timeRules:[rule]});
 assert.match(q.items[1].name_pl,/wymaga uzgodnienia/);
 assert.match(q.items[1].name_en,/approval required/);
});
