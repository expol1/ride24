import test from 'node:test';
import assert from 'node:assert/strict';
import { arventCatalogRows, arventOfferExtrasRows, arventAssertVehicleOnlyExtrasSafe, arventSavePayload } from '../../supabase/functions/_shared/arvent-kolaycar-contract.mjs';

test('Arvent global extras catalog parses actual supplier codes and names only', () => {
 const result=arventCatalogRows({success:true,resultCode:0,data:[
  {code:1,name:'GPS',price:999},
  {code:2,extraName:'IMM insurance',price:19},
  {extraCode:6,name:'Bebek Koltuğu',price:7},
  {code:1,name:'Duplicate GPS'},
  {code:40,name:'GPS (other code)'}
 ]});
 assert.deepEqual(result,[
  {code:'1',name:'GPS'},
  {code:'2',name:'IMM insurance'},
  {code:'6',name:'Bebek Koltuğu'},
  {code:'40',name:'GPS (other code)'}
 ]);
 assert.ok(result.every(x=>!Object.hasOwn(x,'price')),'global catalog is not a quote');
});
test('Arvent accepts wrapped supplier catalog but rejects invalid envelope',()=>{
 assert.deepEqual(arventCatalogRows({success:true,resultCode:0,data:{extras:[{code:'18',name:'Wi-Fi'}]}}),[{code:'18',name:'Wi-Fi'}]);
 assert.throws(()=>arventCatalogRows({success:false,data:[]}),/BUSINESS_FAILURE/);
 assert.throws(()=>arventCatalogRows({success:true,data:{unknown:[]}}),/CATALOG_SHAPE/);
});

test('Arvent offer extras keep IMM code 2, supplier amount and unknown billing; never mark bookable',()=>{
 const items=arventOfferExtrasRows([
  {code:2,name:'IMM insurance',price:4.99,extraRentalType:3,extraQuantityIncreasable:false,isRequired:false},
  {code:6,name:'Bebek Koltuğu',price:5,extraRentalType:'unknown',extraQuantityIncreasable:true,isRequired:false},
 ]);
 assert.equal(items.length,2);
 assert.deepEqual(items[0],{
  code:'2',name:'IMM insurance',price_eur:4.99,billing_type:'3',
  quantity_increasable:false,max_quantity:null,required:false,kind:'other',booking_confirmed:false
 });
 assert.equal(items[1].kind,'other');
 assert.equal(items[1].quantity_increasable,true);
 assert.equal(items[1].booking_confirmed,false);
 assert.equal(items[1].price_eur,5);
});
test('Arvent absent extras and ambiguous pricing never become a confirmed charge',()=>{
 assert.deepEqual(arventOfferExtrasRows(null),[]);
 const item=arventOfferExtrasRows([{code:2,name:'IMM insurance',price:'not a price',isRequired:false}])[0];
 assert.equal(item.price_eur,null);
 assert.equal(item.booking_confirmed,false);
 assert.throws(()=>arventOfferExtrasRows([{code:'2'},{code:'2'}]),/DUPLICATE_OR_CODE/);
 assert.throws(()=>arventOfferExtrasRows({extras:[]}),/EXTRAS_SHAPE/);
 assert.throws(()=>arventOfferExtrasRows([{code:'',price:5}]),/DUPLICATE_OR_CODE/);
});

test('Arvent exact two-decimal supplier prices accept JSON number or decimal text, never estimates',()=>{
 const rows=arventOfferExtrasRows([
  {code:2,name:'IMM insurance',price:'4.99',isRequired:false},
  {code:6,name:'Bebek Koltuğu',price:0,isRequired:false},
  {code:18,name:'Wi-Fi',price:'100.00',isRequired:false},
  {code:40,name:'GPS',price:'4,99',isRequired:false},
  {code:41,name:'GPS',price:2.555,isRequired:false},
  {code:42,name:'GPS',price:-3,isRequired:false},
  {code:43,name:'GPS',price:'1e2',isRequired:false}
 ]);
 assert.deepEqual(rows.map(x=>x.price_eur),[4.99,0,100,null,null,null,null]);
 assert.ok(rows.every(x=>x.booking_confirmed===false));
});

test('Arvent SaveReservation extra codes and quantities are bounded, unique, single extra driver',()=>{
 const base={driverCode:'TEST-driver',reservationToken:'11111111-1111-4111-8111-111111111111',
  reference:'RIDE24-TEST',
  customer:{name:'Anna',surname:'Nowak',email:'anna@example.invalid',phoneNumber:'000000000'}};
 const valid=arventSavePayload({...base,extras:[{code:'TEST-driver',piece:1},{code:'6',piece:2}]});
 assert.deepEqual(valid.extras,[{code:'TEST-driver',piece:1},{code:'6',piece:2}]);
 for(const extras of [
  [{code:'TEST-driver',piece:2}], [{code:'6',piece:11}],
  [{code:'6',piece:1},{code:'6',piece:2}], [{code:'6',piece:0}],
  [{code:'6',piece:1.5}], [{code:'',piece:1}],
  Array.from({length:21},(_,i)=>({code:String(i+1),piece:1}))
 ]) assert.throws(()=>arventSavePayload({...base,extras}),/ARVENT_EXTRAS_INVALID/);
});

test('Arvent missing or payable mandatory extras fail before the Stripe booking flow',()=>{
 assert.doesNotThrow(()=>arventAssertVehicleOnlyExtrasSafe(null));
 assert.doesNotThrow(()=>arventAssertVehicleOnlyExtrasSafe([]));
 assert.doesNotThrow(()=>arventAssertVehicleOnlyExtrasSafe([
   {code:6,name:'Free required item',price:0,isRequired:true},
   {code:2,name:'IMM insurance',price:6,isRequired:false}
 ]));
 assert.throws(()=>arventAssertVehicleOnlyExtrasSafe([
   {code:6,name:'Required infant seat',price:5,isRequired:true}
 ]),/REQUIRED_EXTRAS_UNPRICED/);
 assert.throws(()=>arventAssertVehicleOnlyExtrasSafe([
   {code:6,name:'Required item',price:'invalid',isRequired:true}
 ]),/REQUIRED_EXTRAS_UNPRICED/);
 assert.throws(()=>arventAssertVehicleOnlyExtrasSafe([
   {code:6,name:'Unknown required status',price:0}
 ]),/REQUIRED_EXTRAS_UNVERIFIED/);
 assert.throws(()=>arventAssertVehicleOnlyExtrasSafe([{code:2},{code:2}]),/EXTRAS_DUPLICATE_OR_CODE/);
});
