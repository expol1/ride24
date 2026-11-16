import test from "node:test";
import assert from "node:assert/strict";
import { auditCollection, sanitizedPath } from "../../tools/arvent-postman-audit.mjs";

function req(name, method, raw) {
  return { name, request: { method, url: { raw }, header: [{ key: "Authorization", value: "SHOULD_NOT_APPEAR_IN_REPORT" }] } };
}

const endpoint = "https://racapi.arventcarrental.com";

test("detects missing supplier contract operations without inventing endpoints", () => {
  const report = auditCollection({ info: { schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [{ name: "Locations", item: [req("Get Locations", "GET", endpoint + "/offices")] }] });
  assert.equal(report.request_count, 1);
  assert.deepEqual(report.missing_required_operations, ["availability", "booking_create", "booking_status", "booking_cancel"]);
  assert.equal(report.verified_connection, false);
  assert.equal(report.live_booking_tests_allowed, false);
});

test("detects operation hints but never permits booking calls", () => {
  const report = auditCollection({ item: [
    req("Get Locations", "GET", endpoint + "/locations"),
    req("Search Availability", "POST", endpoint + "/availability"),
    req("Create Reservation", "POST", endpoint + "/booking/create"),
    req("Booking Status", "GET", endpoint + "/booking/status"),
    req("Cancel Reservation", "POST", endpoint + "/booking/cancel"),
  ] });
  assert.equal(report.missing_required_operations.length, 0);
  assert.equal(report.requests_requiring_host_review, 0);
  assert.equal(report.live_booking_tests_allowed, false);
});

test("hides query parameter values and very long path tokens", () => {
  const secret = "FAKE_ONLY_SHOULD_NOT_BE_PRINTED";
  const report = auditCollection({ item: [
    req("Some request", "GET", endpoint + "/path/" + secret + "?password=" + secret)
  ] });
  const printed = JSON.stringify(report);
  assert.ok(!printed.includes(secret));
  assert.ok(!printed.includes("password="));
  assert.ok(!printed.includes("SHOULD_NOT_APPEAR_IN_REPORT"));
  assert.ok(report.endpoints[0].header_names.includes("Authorization"));
});

test("different host or non-HTTPS URL must be manually reviewed", () => {
  const report = auditCollection({ item: [
    req("Get Locations", "GET", "http://racapi.arventcarrental.com/locations"),
    req("Get Locations", "GET", "https://other.example/locations"),
    req("Get Locations", "GET", "{{baseUrl}}/locations")
  ] });
  assert.equal(report.requests_requiring_host_review, 3);
});

test("rejects invalid JSON shape and does not perform network calls", () => {
  assert.throws(() => auditCollection(null), /Expected a Postman/);
  assert.throws(() => auditCollection({ item: {} }), /Expected a Postman/);
  assert.equal(sanitizedPath("https://racapi.arventcarrental.com/locations?api_key=dummy"), "/locations");
});
