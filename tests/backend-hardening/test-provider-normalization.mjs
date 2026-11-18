import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import * as normal from '../../supabase/functions/_shared/provider-normalization.mjs';
const read = p => fs.readFileSync(new URL('../../'+p, import.meta.url),'utf8');
test('ACRISS maps into existing A–F classes without using transmission or fuel as a category',()=>{
  for(const [code,expected] of Object.entries({MCMR:'A',EDAR:'A',CDMR:'B',CWAR:'B',IDMD:'C',SLAR:'C',CFAR:'D',SFMR:'D',CGMR:'D',LLAD:'E',FVAD:'F',CVAR:'F'})) {
    assert.equal(normal.ride24ClassFromAcriss(code),expected,code);
  }
  assert.equal(normal.ride24ClassFromAcriss('CFAR',7),'F');
  assert.equal(normal.ride24ClassFromAcriss('unknown'),null);
});
test('canonical airport labels preserve source names and external IDs; downtown codes are not IATA',()=>{
  const row={external_id:'HR-ZAD-ZAD',location_name:'Zadar airport',type:'airport',iata_code:'ZAD'};
  const result=normal.canonicalApiLocation(row);
  assert.equal(result.display_name,'Zadar Airport (ZAD)');
  assert.equal(result.external_id,row.external_id);assert.equal(result.location_name,row.location_name);
  assert.deepEqual(normal.canonicalApiLocation(result),result);
  assert.equal(normal.canonicalApiLocation({location_name:'Zadar downtown',type:'city',iata_code:'ZAD'}).display_name,'Zadar downtown');
});
test('missing metadata preserves known values while explicit zero remains zero',()=>{
  assert.deepEqual(normal.preserveKnownFields({image:null,seats:null,bags:0},{image:'verified.jpg',seats:7,bags:3},['image','seats','bags']),{image:'verified.jpg',seats:7,bags:0});
});
test('aggregator reads connector models, exact pictures and capacity; scooters are not passenger cars',async()=>{
  const code=ts.transpileModule(read('supabase/functions/_shared/renteon-aggregator.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const setup={Code:'Avia',CarCategories:[{Code:'MCMR'},{Code:'FVAD'},{Code:'XYAZ'}],Connectors:[{Url:'https://avia.renteon.com',CarCategories:[
    {SIPP:'MCMR',CarModel:'Fiat Panda',PassengerCapacity:4,BigBagsCapacity:0,SmallBagsCapacity:1,CarModelImageURL:'/en/api/fileItem/123',FuelTypes:[{Name:'Petrol'}]},
    {SIPP:'FVAD',CarModel:'Peugeot Traveller',PassengerCapacity:9,BigBagsCapacity:null,SmallBagsCapacity:null,CarModelImageURL:'https://untrusted.example/car.jpg'},
    {SIPP:'XYAZ',CarModel:'Aprilia',PassengerCapacity:2}
  ]}]};
  const box={exports:{},require:n=>n.includes('provider-normalization')?normal:{partnerApiRequest:async()=>setup,sanitizePartnerPayload:x=>x},URL,Intl,Date};
  vm.runInNewContext(code,box);
  const groups=await box.exports.aggregatorGroups({api_url:'https://aggregator.renteon.com',auth_type:'basic',username:'test',password:'test',renteon_provider_code:'Avia'});
  assert.equal(groups[0].model,'Fiat Panda');assert.equal(groups[0].seats,4);assert.equal(groups[0].bags,1);
  assert.equal(groups[0].image,'https://avia.renteon.com/en/api/fileItem/123');
  assert.equal(groups[1].class_code,'F');assert.equal(groups[1].bags,null);assert.equal(groups[1].image,null);
  assert.equal(groups[2].active,false);assert.equal(groups[2].external_id,'XYAZ');
});
test('public Croatia labels are English in both languages; Turkey translations remain functional',()=>{
  const box={window:{}};vm.runInNewContext(read('assets/js/location-names.js'),box);
  for(const lang of ['pl','en'])assert.equal(box.window.Ride24LocationNames.displayName({country:'Croatia',location_name:'Zadar airport'},lang),'Zadar Airport (ZAD)');
  assert.equal(box.window.Ride24LocationNames.displayName({country:'Turkey',location_name:'Milas-Bodrum Airport'},'pl'),'Lotnisko Milas–Bodrum (BJV)');
});

test('unmapped provider surcharges are reported as an integration error, not sold without the fee or hidden as no cars',async()=>{
  const code=ts.transpileModule(read('supabase/functions/_shared/renteon-aggregator.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const offer={Provider:'Avia',Prepaid:false,CarCategory:'MCMR',Amount:310.56,CarRentalAmount:150.56,Currency:'EUR',
    PickupOffice:{LocationCode:'HR-ZAD-ZAD'},DropOffOffice:{LocationCode:'HR-ZAD-ZAD'},
    PickupDate:'2027-03-10T23:00:00',DropOffDate:'2027-03-13T23:00:00'};
  const box={exports:{},require:n=>n.includes('provider-normalization')?normal:{partnerApiRequest:async()=>[offer],sanitizePartnerPayload:x=>x},URL,Intl,Date};
  vm.runInNewContext(code,box);
  await assert.rejects(()=>box.exports.aggregatorAvailability({api_url:'https://aggregator.renteon.com',auth_type:'basic',username:'test',password:'test',renteon_provider_code:'Avia'},
    {pickup_location_id:'HR-ZAD-ZAD',dropoff_location_id:'HR-ZAD-ZAD',pickup_date:'2027-03-10',return_date:'2027-03-13',pickup_time:'23:00',return_time:'23:00'}),/SURCHARGES_REQUIRE_QUOTE/);
});

test('updated web inline scripts parse and results loads the canonical label helper',()=>{
  for(const file of ['index.html','results.html']) {
    const html=read(file);
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if(/src=|application\/ld\+json|type="module"/.test(match[1]))continue;
      new vm.Script(match[2],{filename:file});
    }
  }
  assert.match(read('results.html'),/src="assets\/js\/location-names\.js/);
});
