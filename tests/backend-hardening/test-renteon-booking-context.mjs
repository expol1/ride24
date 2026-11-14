import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as services from '../../supabase/functions/_shared/provider-services.mjs';
import * as normalization from '../../supabase/functions/_shared/provider-normalization.mjs';

const source=ts.transpileModule(await readFile(new URL('../../supabase/functions/_shared/renteon-aggregator.ts',import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const credentials={api_url:'https://aggregator.renteon.com',auth_type:'basic',username:'test-only',password:'not-a-real-secret',renteon_provider_code:'Demo'};
const offer=()=>({Provider:'Demo',Prepaid:false,Currency:'EUR',CarCategory:'MDMR',Amount:100,
  PickupDate:'2027-03-01T10:00:00',DropOffDate:'2027-03-04T10:00:00',
  PickupOffice:{LocationCode:'HR-ZAD-ZAD'},DropOffOffice:{LocationCode:'HR-SPU-SPU'}});
const model=()=>({...offer(),Total:100,Services:[{ServiceId:1,Code:'CAR-RENT',Name:'Rent',Quantity:1,IsSelected:true,IsMandatory:true,IsRent:true,Prepaid:false,ServicePrice:{Currency:'EUR',Amount:100,AmountTotal:100}}]});
const input=()=>({provider_quote_data:{provider_code:'Demo',offer:offer(),calculated:model(),driver_ages:[35]},partner_amount:100,
  vehicle_group_id:'MDMR',pickup_location_id:'HR-ZAD-ZAD',dropoff_location_id:'HR-SPU-SPU',
  pickup_date:'2027-03-01',return_date:'2027-03-04',pickup_time:'10:00',return_time:'10:00',
  main_driver:{name:'Sandbox Driver',age:35},client_email:'test@example.invalid',ride24_booking_id:'test-only'});
function adapter(change=()=>{},stage='calculate') {
  const calls=[];
  const sandbox={exports:{},URL,Intl,structuredClone,require:name=>{
    if(name.includes('provider-services'))return services;
    if(name.includes('provider-normalization'))return normalization;
    if(name.includes('partner-api'))return {sanitizePartnerPayload:x=>x,partnerApiRequest:async(_c,path,options)=>{
      calls.push(path);const result=structuredClone(path.endsWith('/create')?model():options.body);
      if(path.endsWith('/save'))result.Number='DEMO-ONLY';
      if(path.endsWith('/'+stage))change(result);
      return result;
    }};
    throw Error(name);
  }};
  vm.runInNewContext(source,sandbox);return {...sandbox.exports,calls};
}
const mutations={pickup:x=>x.PickupOffice.LocationCode='HR-ZAG-ZAG',dropoff:x=>x.DropOffOffice.LocationCode='HR-ZAD-ZAD',
  date:x=>x.PickupDate='2027-03-02T10:00:00',time:x=>x.DropOffDate='2027-03-04T11:00:00',
  category:x=>x.CarCategory='CDMR',currency:x=>x.Currency='USD',prepaid:x=>x.Prepaid=true,number:x=>x.Number='ALREADY-SAVED'};
for(const [name,change] of Object.entries(mutations)) {
  test(`options rejects changed ${name} returned by supplier`,async()=>{
    const a=adapter(change);await assert.rejects(a.aggregatorQuoteOptions(credentials,{provider_code:'Demo',offer:offer()},[],[35]));
    assert.equal(a.calls.some(x=>x.endsWith('/save')),false);
  });
  test(`booking rejects changed ${name} before durable save`,async()=>{
    const a=adapter(change);await assert.rejects(a.aggregatorBook(credentials,input()));
    assert.equal(a.calls.some(x=>x.endsWith('/save')),false);
  });
}
test('one-way route survives quote and booking without using public labels',async()=>{
  const a=adapter();const q=await a.aggregatorQuoteOptions(credentials,{provider_code:'Demo',offer:offer()},[],[35]);
  assert.equal(q.calculated.DropOffOffice.LocationCode,'HR-SPU-SPU');
  const booked=await a.aggregatorBook(credentials,input());assert.equal(booked.status,'confirmed');assert.equal(booked.needs_manual_review,false);
  assert.equal(a.calls.filter(x=>x.endsWith('/save')).length,1);
});
test('changed saved route retains reference for manual review and never retries save',async()=>{
  const a=adapter(mutations.dropoff,'save');const booked=await a.aggregatorBook(credentials,input());
  assert.equal(booked.booking_reference,'DEMO-ONLY');assert.equal(booked.status,'pending');assert.equal(booked.needs_manual_review,true);
  assert.equal(a.calls.filter(x=>x.endsWith('/save')).length,1);
});
test('missing saved service is not reported as confirmed',async()=>{
  const a=adapter(x=>{x.Services=[];},'save');const booked=await a.aggregatorBook(credentials,input());
  assert.equal(booked.status,'pending');assert.equal(booked.needs_manual_review,true);
});
