import test from 'node:test';
import assert from 'node:assert/strict';
import { arventCatalogRows, arventOfferExtrasRows } from '../../supabase/functions/_shared/arvent-kolaycar-contract.mjs';

test('Arvent global extras catalog parses actual supplier codes and names only', () => {
 const result=arventCatalogRows({success:true,resultCode:0,data:[
  {code:1,name:'GPS',price:999},
  {code:2,extraName:'Ek Sürücü',price:19},
  {extraCode:6,name:'Bebek Koltuğu',price:7},
  {code:1,name:'Duplicate GPS'},
  {code:40,name:'GPS (other code)'}
 ]});
 assert.deepEqual(result,[
  {code:'1',name:'GPS'},
  {code:'2',name:'Ek Sürücü'},
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

test('Arvent offer extras keep driver code 2, supplier amount and unknown billing; never mark bookable',()=>{
 const items=arventOfferExtrasRows([
  {code:2,name:'Ek Sürücü',price:4.99,extraRentalType:3,extraQuantityIncreasable:false,isRequired:false},
  {code:6,name:'Bebek Koltuğu',price:5,extraRentalType:'unknown',extraQuantityIncreasable:true,isRequired:false},
 ]);
 assert.equal(items.length,2);
 assert.deepEqual(items[0],{
  code:'2',name:'Ek Sürücü',price_eur:4.99,billing_type:'3',
  quantity_increasable:false,required:false,kind:'additional_driver',booking_confirmed:false
 });
 assert.equal(items[1].kind,'other');
 assert.equal(items[1].quantity_increasable,true);
 assert.equal(items[1].booking_confirmed,false);
 assert.equal(items[1].price_eur,5);
});
test('Arvent absent extras and ambiguous pricing never become a confirmed charge',()=>{
 assert.deepEqual(arventOfferExtrasRows(null),[]);
 const item=arventOfferExtrasRows([{code:2,name:'Ek Sürücü',price:'not a price',isRequired:false}])[0];
 assert.equal(item.price_eur,null);
 assert.equal(item.booking_confirmed,false);
 assert.throws(()=>arventOfferExtrasRows([{code:'2'},{code:'2'}]),/DUPLICATE_OR_CODE/);
 assert.throws(()=>arventOfferExtrasRows({extras:[]}),/EXTRAS_SHAPE/);
 assert.throws(()=>arventOfferExtrasRows([{code:'',price:5}]),/DUPLICATE_OR_CODE/);
});
