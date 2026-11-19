import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arventLicenseYears } from "../../supabase/functions/_shared/arvent-driver-eligibility.mjs";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const client = read("klient.html");
const partner = read("partner-dashboard.html");
const booking = read("supabase/functions/create-booking-request/index.ts");
const migration = read("supabase/migrations/20261119203000_local_partner_min_license_years.sql");

test("local rule uses completed calendar years at pickup (same helper already used by Arvent)", () => {
  assert.equal(arventLicenseYears("2025-11-20", "2026-11-19", "2026-11-19"), 0);
  assert.equal(arventLicenseYears("2025-11-19", "2026-11-19", "2026-11-19"), 1);
  assert.equal(arventLicenseYears("2024-11-19", "2026-11-19", "2026-11-19"), 2);
  assert.equal(arventLicenseYears("2024-02-29", "2027-02-28", "2026-11-19"), 2);
  assert.equal(arventLicenseYears("2024-02-29", "2027-03-01", "2026-11-19"), 3);
  assert.equal(arventLicenseYears("", "2027-03-01", "2026-11-19"), null);
  assert.equal(arventLicenseYears("2027-01-01", "2027-03-01", "2026-11-19"), null);
});

test("additional-driver form rejects missing/invalid date BEFORE deleting any saved drivers", () => {
  const start = client.indexOf("window.saveDrivers = async function");
  const end = client.indexOf("window.cancelBooking = ", start);
  assert.ok(start >= 0 && end > start);
  const fn = client.slice(start, end);
  // Full additional-driver validation now runs before an INSERT, and existing drivers
  // are never removed until the new rows have been stored successfully.
  assert.ok(fn.indexOf("additionalDriverErrors(candidate)") >= 0);
  assert.ok(fn.indexOf("additionalDriverErrors(candidate)") < fn.indexOf(".insert(newDrivers)"));
  assert.ok(fn.indexOf(".insert(newDrivers)") < fn.indexOf(".delete().eq(\"user_id\""));
  assert.match(client, /class="driver-license-since" required autocomplete="off"/);
});

test("browser date helper uses full anniversaries and does not round by 365 days", () => {
  const first = client.indexOf("window.ride24LicenseDate = function");
  const last = client.indexOf("window.saveProfile = async function", first);
  assert.ok(first >= 0 && last > first);
  const sandbox = {};
  new Function("window", client.slice(first, last))(sandbox);
  assert.equal(sandbox.ride24LicenceYearsAtPickup("2020-12-01", "2026-11-30"), 5);
  assert.equal(sandbox.ride24LicenceYearsAtPickup("2020-12-01", "2026-12-01"), 6);
  assert.equal(sandbox.ride24LicenceYearsAtPickup("2035-01-01", "2035-12-01"), null);
  assert.equal(sandbox.ride24LicenceYearsAtPickup("2020-02-30", "2026-12-01"), null);
});

test("only LOCAL partners can set/activate the optional rule", () => {
  assert.match(partner, /id="localLicenceExperienceSetting"/);
  assert.match(partner, /data\.provider_type !== "local"/);
  assert.match(partner, /isLocalPartner \? \{ min_license_years: minLicenseYears \} : \{\}/);
  assert.match(booking, /car\.partner\.provider_type === "local"/);
  assert.match(booking, /localMinLicenseYears > 0/);
  assert.match(booking, /LOCAL_MAIN_DRIVER_LICENSE_DATE_REQUIRED/);
  assert.match(booking, /LOCAL_MAIN_DRIVER_LICENSE_TOO_SHORT/);
  assert.match(booking, /LOCAL_ADDITIONAL_DRIVER_LICENSE_DATE_REQUIRED/);
  assert.match(booking, /LOCAL_ADDITIONAL_DRIVER_LICENSE_TOO_SHORT/);
  assert.match(booking, /savedAdditionalDriverLicenseSince/);
  assert.match(booking, /isArventBooking && arventLicenseYears/);
});

test("nullable migration never silently changes existing local or API partner settings", () => {
  assert.match(migration, /add column if not exists min_license_years integer/i);
  assert.match(migration, /add column if not exists additional_driver_license_since date/i);
  assert.match(migration, /add column if not exists min_license_years_snapshot integer/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\.partners\b/i);
  assert.doesNotMatch(migration, /\bdelete\b/i);
});
