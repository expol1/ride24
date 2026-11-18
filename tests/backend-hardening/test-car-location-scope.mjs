import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const file=new URL('../../assets/js/car-location-scope.js',import.meta.url);
const root={};
runInNewContext(readFileSync(file,'utf8'),{window:root});
const {isCarAllowed}=root.Ride24CarLocationScope;
const p='partner-one', mostar='mostar-city', sarajevo='sarajevo-airport';
const raw={id:'scooter',partner_id:p,partners:{id:p,partner_locations:[{id:mostar}]}};
function returns(id, partner=p) {return new Map([[partner,[{id}]]]);}

test('all-locations default (also for group 0) remains unrestricted',()=>{
  assert.equal(isCarAllowed({...raw,allowed_location_ids:null},returns(sarajevo)),true);
  assert.equal(isCarAllowed({...raw},returns(sarajevo)),true);
  assert.equal(isCarAllowed({...raw,class_code:'0',allowed_location_ids:null},returns(sarajevo)),true);
});
test('scoped scooter requires pickup AND return location in approved ids',()=>{
  const scooter={...raw,allowed_location_ids:[mostar]};
  assert.equal(isCarAllowed(scooter,returns(mostar)),true);
  assert.equal(isCarAllowed(scooter,returns(sarajevo)),false);
  assert.equal(isCarAllowed({...scooter,partners:{id:p,partner_locations:[{id:sarajevo}]}},returns(mostar)),false);
  assert.equal(isCarAllowed({...scooter,allowed_location_ids:[]},returns(mostar)),false);
});
test('scopes are partner-owned; same-named location of another partner is not allowed',()=>{
  const scooter={...raw,allowed_location_ids:[mostar]};
  assert.equal(isCarAllowed(scooter,returns(mostar,'different-partner')),false);
});

const partner=readFileSync(new URL('../../partner-dashboard.html',import.meta.url),'utf8');
const results=readFileSync(new URL('../../results.html',import.meta.url),'utf8');
const quote=readFileSync(new URL('../../supabase/functions/booking-options/index.ts',import.meta.url),'utf8');
const booking=readFileSync(new URL('../../supabase/functions/create-booking-request/index.ts',import.meta.url),'utf8');
test('partner UI, public results, server quote and booking all honor the scope',()=>{
  for (const token of ['allowed_location_ids: allowedLocationIds','allBox.checked = selected === null;','carLocationChoices','carLocationScopeSection']) {
    assert.ok(partner.includes(token), 'missing partner UI '+token);
  }
  assert.ok(partner.includes('const allowedLocationIds = allCarLocations ? null : scopedLocationIds')); 
  assert.ok(!partner.includes('if (class_code === "0" && (allCarLocations'));
  assert.ok(results.includes('window.Ride24CarLocationScope.isCarAllowed'));
  assert.ok(results.includes("select('id,partner_id,return_fee_amount"));
  assert.ok(quote.includes("VEHICLE_LOCATION_UNAVAILABLE"));
  assert.ok(booking.includes("VEHICLE_LOCATION_UNAVAILABLE"));
});
