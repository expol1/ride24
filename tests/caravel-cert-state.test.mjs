// Tests for the private Postgres RPC sandbox reference snapshots.
// No real DB, provider API, credentials, customer PII or Ride24 bookings.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CARAVEL_CERT_TABLE, createCaravelSandboxReferenceRepository, validateCaravelCertSnapshot,
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
  const rows = new Map(), calls = [];
  return {rows,calls,
    async rpc(name, args) {
      calls.push({name,args});
      const k=args.p_session_id+":"+args.p_supplier_id;
      if(name==="caravel_sbx_reference_load")
        return {data:rows.has(k)?structuredClone(rows.get(k)):null,error:null};
      if(name==="caravel_sbx_reference_save"){
        rows.set(k,structuredClone(args.p_snapshot));return {data:true,error:null};
      }
      if(name==="caravel_sbx_reference_clear"){
        const existing=rows.delete(k);return {data:existing,error:null};
      }
      return {data:null,error:{message:"UNKNOWN_RPC"}};
    },
  };
}

test("private RPC snapshot persists between runs and preserves opaque vehicle ID", async () => {
  assert.equal(CARAVEL_CERT_TABLE, "caravel_sbx_reference_snapshots");
  const admin=fakeAdmin();
  const repoA=createCaravelSandboxReferenceRepository(admin,SESSION);
  assert.equal(await repoA.load(SUP),null);
  await repoA.save(SUP,sample());
  const repoB=createCaravelSandboxReferenceRepository(admin,SESSION);
  assert.deepEqual(await repoB.load(SUP),sample());
  assert.deepEqual([...admin.rows.keys()],[SESSION+":"+SUP]);
  assert.deepEqual(admin.calls.map(x=>x.name),[
    "caravel_sbx_reference_load","caravel_sbx_reference_save","caravel_sbx_reference_load",
  ]);
  assert.equal(admin.calls[1].args.p_snapshot.vehicles[0][0],encodeURIComponent(SUP+"\u0000opaque-vehicle-id"));
  assert.equal(JSON.stringify(admin.calls[1].args.p_snapshot).includes("\\u0000"),false);
  await repoB.clear(SUP);
  assert.equal(await repoA.load(SUP),null);
});

test("different certification session UUIDs cannot read each other's snapshot", async () => {
  const admin=fakeAdmin(),a=createCaravelSandboxReferenceRepository(admin,SESSION);
  const b=createCaravelSandboxReferenceRepository(admin,"00000000-0000-4000-8000-000000000002");
  await a.save(SUP,sample());
  assert.equal(await b.load(SUP),null);
  assert.deepEqual(await a.load(SUP),sample());
});

test("scope checks reject non-UUID session and supplier path traversal before RPC",async()=>{
  const admin=fakeAdmin();
  assert.throws(()=>createCaravelSandboxReferenceRepository(admin,"../../"),/CERT_STATE_BAD_CONFIGURATION/);
  assert.throws(()=>createCaravelSandboxReferenceRepository({},SESSION),/CERT_STATE_BAD_CONFIGURATION/);
  const repo=createCaravelSandboxReferenceRepository(admin,SESSION);
  await assert.rejects(()=>repo.save("../admin",sample()),/CERT_STATE_BAD_SCOPE/);
  await assert.rejects(()=>repo.load(""),/CERT_STATE_BAD_SCOPE/);
  assert.equal(admin.calls.length,0);
});

test("malformed, excessive or PII-style extra-key snapshots are rejected locally",async()=>{
  const admin=fakeAdmin(),repo=createCaravelSandboxReferenceRepository(admin,SESSION);
  assert.throws(()=>validateCaravelCertSnapshot({...sample(),booking:{customer_email:"secret"}}),/CERT_STATE_BAD_SNAPSHOT/);
  assert.throws(()=>validateCaravelCertSnapshot({...sample(),vehicles:[["bad"]]}),/CERT_STATE_BAD_ENTRY/);
  assert.throws(()=>validateCaravelCertSnapshot({...sample(),vehicles:Array(301).fill(["x",record])}),/CERT_STATE_TOO_LARGE/);
  await assert.rejects(()=>repo.save(SUP,{...sample(),extras:null}),/CERT_STATE_BAD_SNAPSHOT/);
  assert.equal(admin.rows.size,0);
  assert.equal(admin.calls.length,0);
});

test("an invalid or failed SQL RPC never returns a supposedly saved snapshot",async()=>{
  const bad={
    rpc:async name=> name==="caravel_sbx_reference_load"
      ? {data:{locations:[]},error:null}
      : {data:null,error:{message:"simulated DB error"}},
  };
  const repo=createCaravelSandboxReferenceRepository(bad,SESSION);
  await assert.rejects(()=>repo.load(SUP),/CERT_STATE_BAD_SNAPSHOT/);
  await assert.rejects(()=>repo.save(SUP,sample()),/CERT_STATE_RPC_FAILED/);
});

test("opaque vehicle IDs with percent signs and non-ASCII roundtrip without Postgres NUL",async()=>{
  const admin=fakeAdmin(),repo=createCaravelSandboxReferenceRepository(admin,SESSION);
  const snapshot=sample();
  snapshot.vehicles.push([SUP+"\u0000"+"id/%+łódź",{
    ...structuredClone(record),id:"id/%+łódź",data:{vehicle_id:"id/%+łódź",name:"Reference"},
  }]);
  await repo.save(SUP,snapshot);
  const saved=admin.rows.get(SESSION+":"+SUP);
  assert.ok(saved.vehicles.every(([key])=>!key.includes("\u0000")));
  assert.deepEqual(await repo.load(SUP),snapshot);
});
