import test from 'node:test';
import assert from 'node:assert/strict';
import {arventBillingMode,arventPricedExtrasCatalog,arventSelectedExtrasQuote,arventBookingTotals,arventReceiptExtrasMatch}
 from '../../supabase/functions/_shared/arvent-extras-pricing.mjs';

const extras=[
 {code:'1',name:'GPS',price_eur:4.5,billing_type:'day',quantity_increasable:false,required:false},
 {code:'2',name:'IMM insurance',price_eur:4,billing_type:'day',quantity_increasable:false,required:false},
 {code:'6',name:'Infant seat',price_eur:5,billing_type:'1',quantity_increasable:true,max_quantity:2,required:false},
];
test('Arvent uses supplier-confirmed numeric billing enums',()=>{
 assert.equal(arventBillingMode('1'),'day');
 assert.equal(arventBillingMode(1),'day');
 assert.equal(arventBillingMode(0),'rental');
 assert.equal(arventBillingMode('1',{'1':'day'}),'day');
 assert.equal(arventBillingMode('per_day'),'day');
 assert.equal(arventBillingMode('once'),'rental');
 assert.equal(arventBillingMode('UNSPECIFIED'),null);
 assert.ok(arventPricedExtrasCatalog(extras,{'1':'day'},false).every(x=>x.bookable===false));
});
test('Arvent blocks IMM code 2 even if its price resembles the promised driver',()=>{
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,selections:[{id:'2',quantity:1}],billedDays:3,certified:true}),/NOT_PRICED/);
 const q=arventSelectedExtrasQuote({items:extras,selections:[],billedDays:3,certified:true});
 assert.equal(q.total_cents,0);
 const totals=arventBookingTotals({rentalCents:8475,ride24FeeCents:339,extrasCents:0,loyaltyPercent:0,nbpRate:4.4559});
 assert.equal(totals.partner_cents,8475);
 assert.equal(totals.gross_cents,8814);
 assert.equal(totals.online_pln_cents,1511);
});
test('Arvent refuses paid optional equipment not yet authorized by partner',()=>{
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,
    selections:[{id:'1',quantity:1}],billedDays:3,certified:true}),/NOT_PRICED/);
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,
    selections:[{id:'6',quantity:1}],billedDays:3,certified:true,certifiedMap:{'1':'day'}}),/NOT_PRICED/);
});
test('Arvent rejects incorrect driver rate or billing mode even with certified supplier extras',()=>{
 for(const broken of [{price_eur:5},{price_eur:4,billing_type:'rental'}]){
  const items=[{...extras[1],...broken}];
  assert.throws(()=>arventSelectedExtrasQuote({items,selections:[{id:'2',quantity:1}],
    billedDays:3,certified:true}),/NOT_PRICED/);
 }
});
test('Arvent cannot infer a multi-unit cap from the supplier increasable flag alone',()=>{
 const item={code:'6',name:'Infant seat',price_eur:5,billing_type:'day',
  quantity_increasable:true,required:false};
 const [normalized]=arventPricedExtrasCatalog([item],{},true);
 assert.equal(normalized.max_quantity,1);
 assert.throws(()=>arventSelectedExtrasQuote({items:[item],selections:[{id:'6',quantity:2}],
  billedDays:3,certified:true}),/NOT_PRICED/);
});

test('Arvent blocks IMM and unnecessary secondary driver identity',()=>{
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,selections:[{id:'2',quantity:1}],billedDays:3,certified:true}),/NOT_PRICED/);
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,selections:[],
  additionalDriverId:'some-saved-person',certified:true,billedDays:3}),/PERSONAL_DATA_UNNECESSARY/);
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,selections:[{id:'2',quantity:2}],
  certified:true,billedDays:3}),/NOT_PRICED/);
});
test('Arvent invalid amounts, duplicate, unknown or unpriced options never calculate totals',()=>{
 for(const selections of [
  [{id:'1',quantity:2}], [{id:'6',quantity:3}], [{id:'X',quantity:1}],
  [{id:'1',quantity:1},{id:'1',quantity:1}]
 ])assert.throws(()=>arventSelectedExtrasQuote({items:extras,selections,certified:true,
  billedDays:3,certifiedMap:{'1':'day'}}));
 assert.throws(()=>arventSelectedExtrasQuote({items:extras,
  selections:[{id:'6',quantity:1}],certified:true,billedDays:3}),/NOT_PRICED/);
});
test('Arvent mandatory services are added automatically; unknown price blocks payment',()=>{
 const req=[{code:'27',name:'Required equipment',price_eur:4,billing_type:'rental',
  quantity_increasable:false,required:true}];
 assert.equal(arventSelectedExtrasQuote({items:req,selections:[],certified:true,billedDays:5}).total_cents,400);
 assert.throws(()=>arventSelectedExtrasQuote({items:[{...req[0],price_eur:null}],
  selections:[],certified:true,billedDays:5}),/REQUIRED_EXTRA_UNPRICED/);
 assert.equal(arventSelectedExtrasQuote({items:[{code:'2',name:'IMM insurance',price_eur:0,
  billing_type:'rental',quantity_increasable:false,required:true}],
  selections:[],certified:true,billedDays:3}).total_cents,0);
});

test('Arvent voucher stays pending until supplier confirms every requested code and quantity',()=>{
 const selected=[{code:'2',quantity:1},{code:'6',quantity:2}];
 assert.equal(arventReceiptExtrasMatch(undefined,selected),false);
 assert.equal(arventReceiptExtrasMatch([{code:'2',piece:1}],selected),false);
 assert.equal(arventReceiptExtrasMatch([{code:'2',piece:1},{code:'6',piece:1}],selected),false);
 assert.equal(arventReceiptExtrasMatch([{code:'2',piece:1},{code:'6',piece:2}],selected),true);
 assert.equal(arventReceiptExtrasMatch([{code:'2',piece:1},{code:'6',piece:2},{code:'6',piece:2}],selected),false);
 assert.equal(arventReceiptExtrasMatch(undefined,[]),true);
});
