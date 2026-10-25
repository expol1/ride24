import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const scope = {window:{}};
vm.runInNewContext(read('assets/js/seasonal-minimum-info.js'), scope);
const seasonal = scope.window.Ride24SeasonalMinimum;
test('informational preference uses the pickup month, not the booking date',()=>{
  const p={min_rental_days:3,seasonal_min_rental_days:5,seasonal_min_rental_months:[6,7,8,9]};
  assert.equal(seasonal.forPickup(p,'2027-07-01'),5);
  assert.equal(seasonal.forPickup(p,'2027-12-31'),null);
  assert.equal(seasonal.forPickup(p,'2028-07-30'),5);
  assert.equal(p.min_rental_days,3);
});
test('disabled and invalid seasonal preferences fail closed for display',()=>{
  for(const value of [null,undefined,0,-5,367,'wrong']) assert.equal(seasonal.forPickup({seasonal_min_rental_days:value,seasonal_min_rental_months:[6]},'2027-06-01'),null);
  assert.equal(seasonal.forPickup({seasonal_min_rental_days:5,seasonal_min_rental_months:[]},'2027-06-01'),null);
  assert.equal(seasonal.forPickup({seasonal_min_rental_days:5,seasonal_min_rental_months:[6]},'2027-00-01'),null);
  assert.deepEqual([...seasonal.normalizedMonths([9,6,9,2,0,13,'7'])],[2,6,7,9]);
});
test('web uses season preference only as a notice, preserving the enforced base minimum and Android contracts',()=>{
 const results=read('results.html'), partner=read('partner-dashboard.html'), booking=read('supabase/functions/create-booking-request/index.ts');
 assert.match(results,/seasonal_min_rental_months/);
 assert.match(results,/Ride24SeasonalMinimum\?\.forPickup/);
 assert.match(results,/\.lte\('partners\.min_rental_days', Math\.max\(1, duration\.fullDays\)\)/);
 assert.match(booking,/meetsMinimumRental\(duration, car\.partner\.min_rental_days\)/);
 assert.doesNotMatch(booking,/seasonal_min_rental_days/);
 assert.match(partner,/id="partner-season-min-enabled"/);
 assert.match(partner,/id="partner-season-min-days"/);
 assert.match(partner,/seasonal_min_rental_months: seasonalMonths/);
 assert.match(partner,/seasonal_min_rental_days: seasonalDays/);
});

test('mobile settings editor never uses the desktop two-column grid or six-column month selector',()=>{
 const partner=read('partner-dashboard.html');
 const start=partner.indexOf('/* RIDE24 MOBILE: seasonal minimum & settings stay inside the viewport.');
 const end=partner.indexOf('</style>',start);
 assert.ok(start>0 && end>start,'mobile responsive CSS is present');
 const mobile=partner.slice(start,end);
 assert.match(mobile,/@media\s*\(max-width:\s*768px\)/);
 assert.match(mobile,/#view-settings\s*>\s*\.settings-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)\s*!important/s);
 assert.match(mobile,/#view-settings\s*>\s*\.settings-card\s*>\s*\*\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*!important/s);
 assert.match(mobile,/\.r24-min-panels\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)\s*!important/s);
 assert.match(mobile,/\.r24-season-months\s*\{[^}]*grid-template-columns:\s*repeat\(4,minmax\(0,1fr\)\)\s*!important/s);
 assert.match(mobile,/@media\s*\(max-width:\s*360px\)/);
 assert.match(mobile,/\.r24-season-months\s*\{[^}]*grid-template-columns:\s*repeat\(3,minmax\(0,1fr\)\)\s*!important/s);
 assert.match(partner,/id="partner-season-min-enabled"/);
 assert.match(partner,/id="partner-min-rental-days"/);
});