import test from 'node:test';
import assert from 'node:assert/strict';
import { arventCatalogRows } from '../../supabase/functions/_shared/arvent-kolaycar-contract.mjs';

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
