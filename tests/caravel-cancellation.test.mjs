import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {cancelCaravelBooking} from "../supabase/functions/_shared/caravel-paid-fulfillment.ts";

const REF = "c0ffee00-1111-4222-8333-444455556666";
const creds = {api_key: "prod-key-fixture", api_url: "https://api.caravelway.com"};
const ON = (k) => (k === "CARAVEL_PRODUCTION_WRITES_ALLOWED" ? "true" : undefined);
function supplier({status = "confirmed", conflictOnce = false, fee = 0} = {}) {
  const calls = []; let revision = 1; let conflicted = false;
  const factory = (_key, writes) => ({
    async bookingStatusSandbox(ref) { calls.push(["get", ref]); return {data: {booking_id: ref, status, revision}}; },
    async cancel(ref, rev, key) {
      calls.push(["cancel", ref, rev, key, writes]);
      if (conflictOnce && !conflicted) { conflicted = true; revision = 2; const e = new Error("conflict"); e.code = "revision_conflict"; throw e; }
      return {data: {booking_id: ref, status: "cancelled", revision: rev + 1, cancellation: {fee: {amount: fee, currency: "EUR"}}}};
    },
  });
  return {calls, factory};
}

test("existing cancellation flow -> Caravel cancel with current revision and stable key; free until pickup", async () => {
  const s = supplier();
  const r = await cancelCaravelBooking(creds, REF, {idempotency_key: "ride24:cancel:b1"}, {factory: s.factory, read: ON});
  assert.equal(r.status, "cancelled"); assert.equal(r.booking_reference, REF);
  assert.equal(r.provider_payload.cancellation_fee_minor, 0);
  const c = s.calls.find((x) => x[0] === "cancel");
  assert.equal(c[2], 1); assert.equal(c[4], true);
  const again = supplier();
  await cancelCaravelBooking(creds, REF, {idempotency_key: "ride24:cancel:b1"}, {factory: again.factory, read: ON});
  assert.equal(again.calls.find((x) => x[0] === "cancel")[3], c[3], "same Ride24 cancel -> same Idempotency-Key");
});

test("revision conflict -> refetch once and retry; already cancelled -> no second cancel; fee reported, not hidden", async () => {
  const s = supplier({conflictOnce: true});
  const r = await cancelCaravelBooking(creds, REF, {}, {factory: s.factory, read: ON});
  assert.equal(r.status, "cancelled");
  assert.deepEqual(s.calls.filter((x) => x[0] === "cancel").map((x) => x[2]), [1, 2]);
  const done = supplier({status: "cancelled"});
  assert.equal((await cancelCaravelBooking(creds, REF, {}, {factory: done.factory, read: ON})).status, "cancelled");
  assert.equal(done.calls.filter((x) => x[0] === "cancel").length, 0);
  const late = supplier({fee: 5000});
  assert.equal((await cancelCaravelBooking(creds, REF, {}, {factory: late.factory, read: ON})).provider_payload.cancellation_fee_minor, 5000);
});

test("writes flag off, sandbox host or bad reference -> throw (existing flow queues manual review)", async () => {
  await assert.rejects(cancelCaravelBooking(creds, REF, {}, {factory: supplier().factory, read: () => undefined}), /WRITES_DISABLED/);
  await assert.rejects(cancelCaravelBooking({api_key: "k", api_url: "https://sandbox-api.caravelway.com"}, REF, {}, {factory: supplier().factory, read: ON}), /PRODUCTION_CREDENTIALS_INVALID/);
  await assert.rejects(cancelCaravelBooking(creds, "not-a-uuid", {}, {factory: supplier().factory, read: ON}), /REFERENCE_INVALID/);
});

test("shared cancelProviderBooking routes only 'caravel' to the Caravel cancel, before the generic provider check", () => {
  const src = readFileSync(new URL("../supabase/functions/_shared/provider-adapters.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const i = src.indexOf('=== "caravel")\n    return await cancelCaravelBooking(');
  const j = src.indexOf("const provider = safeProvider(providerValue);\n  if (provider === \"kayfleet\") {");
  assert.ok(i > 0 && j > i);
  assert.match(src, /\["ride24_standard_v1", "custom", "kayfleet", "renteon", "renteon_aggregator", "easy_web_rent", "arvent_kolaycar"\]\.includes\(key\)/,
    "generic search/sync still reject caravel (UNSUPPORTED_PROVIDER)");
});
