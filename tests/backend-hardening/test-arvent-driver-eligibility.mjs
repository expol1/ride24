import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { arventLicenseYears, arventLicenseEligible } from "../../supabase/functions/_shared/arvent-driver-eligibility.mjs";

test("licence eligibility uses fully completed calendar years at pickup, never age",()=>{
 assert.equal(arventLicenseYears("2025-02-17","2027-02-16","2026-11-19"),1);
 assert.equal(arventLicenseYears("2025-02-16","2027-02-16","2026-11-19"),2);
 assert.equal(arventLicenseEligible("2025-02-16","2027-02-16",2,"2026-11-19"),true);
 assert.equal(arventLicenseEligible("2025-02-17","2027-02-16",2,"2026-11-19"),false);
 assert.equal(arventLicenseEligible("2024-01-01","2027-02-16",3,"2026-11-19"),true);
});
test("date validator rejects missing, future, forged, malformed and impossible dates",()=>{
 for(const invalid of [undefined,null,"","2027-01-01","2026-02-29","2024-02-30",
   "2026/01/01","2020-1-1","1899-12-31","2020-13-01","2025-04-31"]){
  assert.equal(arventLicenseYears(invalid,"2027-02-16","2026-11-19"),null,String(invalid));
 }
 assert.equal(arventLicenseEligible("2024-01-01","2027-02-16",null,"2026-11-19"),false);
 assert.equal(arventLicenseEligible("2024-01-01","2027-02-16",51,"2026-11-19"),false);
});
test("licence field is isolated to Arvent web and booking backend; no bypass on Android",async()=>{
 const frontend=await readFile(new URL("../../klient.html",import.meta.url),"utf8");
 const booking=await readFile(new URL("../../supabase/functions/create-booking-request/index.ts",import.meta.url),"utf8");
 const paid=await readFile(new URL("../../supabase/functions/_shared/api-provider-fulfillment.ts",import.meta.url),"utf8");
 const supplier=await readFile(new URL("../../supabase/functions/_shared/arvent-kolaycar.ts",import.meta.url),"utf8");
 assert.doesNotMatch(frontend,/id="arventLicenseSince"/);
 assert.match(frontend,/chosen\?\.license_since/);
 assert.match(frontend,/profileCheck\.license_since/);
 assert.match(booking,/const mainDriverLicenseSince = savedMainDriverLicenseSince/);
 assert.match(booking,/isArventBooking && arventLicenseYears/);
 assert.match(booking,/main_driver_license_since: mainDriverLicenseSince/);
 assert.match(paid,/arventLicenseEligible\(booking.main_driver_license_since/);
 assert.match(supplier,/arventLicenseEligible\(input.main_driver\?\.license_first_issued/);
});
