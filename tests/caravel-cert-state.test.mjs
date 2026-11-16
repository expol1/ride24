// Tests for the PRIVATE sandbox reference snapshots used across certification phases.
// No live Supabase, API key, production booking or HTTP request.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CARAVEL_CERT_BUCKET, createCaravelSandboxReferenceRepository, validateCaravelCertSnapshot,
} from "../supabase/functions/_shared/caravel-cert-state.mjs";

const SESSION = "00000000-0000-4000-8000-000000000001";
const SUP = "acct_eur";
const record = {
  id: "opaque-vehicle-id", supplier_id: SUP, first_seen: "2026-11-16T00:00:00Z",
  last_seen: "2026-11-16T00:00:00Z", missing_since: null,
  data: {vehicle_id: "opaque-vehicle-id", supplier_id: SUP, name: "Test vehicle"},
};
const sample = () => ({
  locations: [], vehicles: [[SUP + "\u0000opaque-vehicle-id", structuredClone(record)]],
  protections: [], extras: [],
});
function fakeAdmin() {
  const files = new Map();
  let openedBucket;
  const bucket = {
    async download(path) {
      if (!files.has(path)) return {data: null, error: {statusCode: 404}};
      return {data: new Blob([files.get(path)], {type: "application/json"}), error: null};
    },
    async upload(path, blob) { files.set(path, await blob.text()); return {error: null}; },
    async remove(paths) { for(const p of paths) files.delete(p); return {error: null}; },
  };
  return {files, getBucket: () => openedBucket, storage: {from(name) {openedBucket = name; return bucket;}}};
}

test("sandbox snapshot persists between calls, preserves exact opaque ID and can be erased", async () => {
  const admin = fakeAdmin();
  const repoA = createCaravelSandboxReferenceRepository(admin, SESSION);
  assert.equal(admin.getBucket(), CARAVEL_CERT_BUCKET);
  assert.equal(await repoA.load(SUP), null);
  await repoA.save(SUP, sample());
  const repoB = createCaravelSandboxReferenceRepository(admin, SESSION);
  const restored = await repoB.load(SUP);
  assert.deepEqual(restored, sample());
  assert.deepEqual([...admin.files.keys()], [SESSION + "/" + SUP + ".json"]);
  await repoB.clear(SUP);
  assert.equal(await repoB.load(SUP), null);
});

test("snapshot scope is a UUID and a supplier id; paths cannot escape private bucket", async () => {
  const admin = fakeAdmin();
  assert.throws(() => createCaravelSandboxReferenceRepository(admin, "../../"), /CERT_STATE_BAD_CONFIGURATION/);
  const repo = createCaravelSandboxReferenceRepository(admin, SESSION);
  await assert.rejects(() => repo.save("../admin", sample()), /CERT_STATE_BAD_SCOPE/);
  await assert.rejects(() => repo.load(""), /CERT_STATE_BAD_SCOPE/);
  assert.equal(admin.files.size, 0);
});

test("malformed, oversized or extra-key snapshots are rejected without any upload", async () => {
  const admin = fakeAdmin();
  const repo = createCaravelSandboxReferenceRepository(admin, SESSION);
  assert.throws(() => validateCaravelCertSnapshot({...sample(), booking: {customer_email: "secret"}}), /CERT_STATE_BAD_SNAPSHOT/);
  assert.throws(() => validateCaravelCertSnapshot({...sample(), vehicles: [["bad"]]}), /CERT_STATE_BAD_ENTRY/);
  assert.throws(() => validateCaravelCertSnapshot({...sample(), vehicles: Array(301).fill(["x", record])}), /CERT_STATE_TOO_LARGE/);
  await assert.rejects(() => repo.save(SUP, {...sample(), extras: null}), /CERT_STATE_BAD_SNAPSHOT/);
  assert.equal(admin.files.size, 0);
});
