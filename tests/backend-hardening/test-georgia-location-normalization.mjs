import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL('../../'+path, import.meta.url),'utf8');
const ctx={window:{}};
vm.runInNewContext(read('assets/js/location-names.js'),ctx);
const {displayName,normalizeForSave}=ctx.window.Ride24LocationNames;
const standard=(type,location_name,city='',region='')=>({country:'Georgia',type,location_name,city,region,extra_fee_amount:120,return_fee_amount:120,contact_required:true});
test('canonical city and airport labels are unique and preserve original external matching key',()=>{
 const expected=[
  [standard('airport','Tbilisi','Tbilisi','Other'),'Tbilisi International Airport (TBS)','Tbilisi','Tbilisi'],
  [standard('city','Tbilisi'),'Tbilisi City','Tbilisi','Tbilisi'],
  [standard('airport','Kutaisi'),'Kutaisi International Airport (KUT)','Kutaisi','Imereti'],
  [standard('airport','Batumi'),'Batumi International Airport (BUS)','Batumi','Adjara']
 ];
 const canonical=[];
 for(const [input,name,city,region] of expected){
  const after=normalizeForSave(input); canonical.push(displayName(after));
  assert.equal(after.location_name,input.location_name);
  assert.equal(after.city,city);assert.equal(after.region,region);
  assert.equal(after.display_name,name);
  assert.equal(after.extra_fee_amount,120);
  assert.equal(after.return_fee_amount,120);
  assert.equal(after.contact_required,true);
 }
 assert.equal(new Set(canonical).size,4);
});
test('legacy and other countries keep original names and rows',()=>{
 const legacy=standard('airport','Kutaisi');
 assert.equal(displayName(legacy),'Kutaisi');
 const foreign={country:'Italy',type:'airport',location_name:'Rome Airport (FCO)',region:'Lazio'};
 assert.equal(normalizeForSave(foreign),foreign);
 assert.equal(displayName({display_name:'Tbilisi City',location_name:'Tbilisi'}),'Tbilisi City');
});
test('future Georgian custom locations need full geographic components',()=>{
 assert.throws(()=>normalizeForSave(standard('airport','Unknown airport','','Other')),/GEORGIA_LOCATION_FIELDS_REQUIRED/);
 assert.throws(()=>normalizeForSave(standard('office','Custom Office','Tbilisi','')),/GEORGIA_LOCATION_FIELDS_REQUIRED/);
 const valid=normalizeForSave(standard('office','Custom Office','Rustavi','Kvemo Kartli'));
 assert.equal(valid.display_name,'Custom Office');
});
test('normalization never alters stored API/Android location_name columns or prices',()=>{
 const sql=read('supabase/migrations/20261025211500_georgia_location_public_names.sql');
 assert.match(sql,/ADD COLUMN IF NOT EXISTS display_name/);
 assert.doesNotMatch(sql,/SET\s+location_name\s*=/i);
 assert.match(sql,/ON CONFLICT \(slug\) DO NOTHING/);
 const index=read('index.html'),results=read('results.html'),panel=read('partner-dashboard.html');
 assert.match(index,/\.select\('id, partner_id, location_name, display_name, country, region, city, type'\)/);
 assert.match(index,/name: window\.Ride24LocationNames\.displayName\(item\)/);
 assert.match(index,/location_name: location\.location_name/);
 assert.match(results,/l => l\.location_name === \(loc\.location_name \|\| loc\.name\)/);
 assert.match(panel,/window\.Ride24LocationNames\.normalizeForSave\(locationData\)/);
 assert.match(panel,/window\.Ride24LocationNames\.displayName\(loc\)/);
 const api=read('supabase/functions/search-api/index.ts');
 assert.match(api,/if \(criteria\.locationName\) return query\.eq\("location_name", criteria\.locationName\)/);
});
