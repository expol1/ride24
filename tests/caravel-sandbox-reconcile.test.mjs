// All tests run against fake sandbox transport and a mock atomic store.
// No Supabase DDL, Caravel traffic or Ride24 production changes.
import test from "node:test";
import assert from "node:assert/strict";
import {runCaravelSandboxReconcile} from "../supabase/functions/_shared/caravel-sandbox-reconcile.mjs";
import {createCaravelSandboxWebhookRepository} from "../supabase/functions/_shared/caravel-webhook-repository.mjs";

const job=()=>({
  job_id:"00000000-0000-4000-8000-000000000076",
  operator_id:"test_operator",supplier_id:"acct_eur",
  since_at:"2026-11-16T14:00:00Z",page_token:null,
});
function store(){
  let current=job(),state="pending",lease=null;
  const applied=new Map(),history=[],stats={claims:0,commits:0,releases:0};
  return {applied,history,stats,get state(){return state;},get cursor(){return current.page_token;},
    async claimJob(token){
      if(state!=="pending")return null;
      stats.claims++;lease=token;state="running";return structuredClone(current);
    },
    async commitPage(id,token,items,next){
      assert.equal(token,lease);
      assert.equal(id,current.job_id);
      const checkpoint={items:structuredClone(items),next};
      for(const item of items){
        const old=applied.get(item.booking_id);
        if(!old||old.revision<item.revision)applied.set(item.booking_id,{...item});
      }
      history.push(checkpoint);stats.commits++;
      current.page_token=next;
      state=next===null?"done":"pending";
      lease=null;
      return {accepted:true,complete:next===null,applied:items.length};
    },
    async releaseJob(id,token){
      stats.releases++;
      if(id===current.job_id && token===lease){state="pending";lease=null;return true;}
      return false;
    },
  };
}
function client(pages,{failGet=null,refs=null}={}){
  const requests=[],gets=[];
  return {environment:"sandbox",requests,gets,
    async listBookings(params,supplier){
      requests.push({params:{...params},supplier});
      const cursor=params.page_token??null;
      if(!pages.has(cursor))throw Error("BAD_CURSOR");
      return pages.get(cursor);
    },
    async bookingStatusSandbox(id,supplier){
      gets.push({id,supplier});
      if(id===failGet)throw Error("UPSTREAM_503");
      return {data:refs?.get(id)??{
        booking_id:id,supplier_id:supplier,operator_id:"test_operator",
        revision:1,status:"confirmed",
        customer:{email:"NEVER_SAVE@example.test"},
      }};
    },
  };
}
const page=(ids,next)=>({data:ids.map(booking_id=>({booking_id})),meta:{next_page:next}});

test("gap recovery paginates, persists opaque cursor, and commits exactly one page per tick",async()=>{
  const r=store();
  const c=client(new Map([
    [null,page(["b-1","b-2"],"opaque+next==")],
    ["opaque+next==",page(["b-3"],null)],
  ]));
  const a=await runCaravelSandboxReconcile({repository:r,client:c});
  assert.deepEqual([a.ok,a.state,a.pages,a.bookings],[true,"more",1,2]);
  assert.equal(r.cursor,"opaque+next==");
  assert.equal(r.applied.size,2);
  const b=await runCaravelSandboxReconcile({repository:r,client:c});
  assert.deepEqual([b.ok,b.state,b.pages,b.bookings],[true,"complete",1,1]);
  assert.equal(r.applied.size,3);
  assert.equal(r.stats.commits,2);
  assert.deepEqual(c.requests.map(x=>x.params.page_token??null),[null,"opaque+next=="]);
  assert.ok(c.requests.every(x=>x.params.updated_since==="2026-11-16T14:00:00Z"&&x.supplier==="acct_eur"));
  assert.ok(c.gets.every(x=>x.supplier==="acct_eur"));
  assert.equal(JSON.stringify([...r.applied]).includes("NEVER_SAVE"),false);
  assert.equal((await runCaravelSandboxReconcile({repository:r,client:c})).state,"idle");
});

test("mid-page GET failure never commits a partial page; next tick retries same cursor",async()=>{
  const r=store();
  const pages=new Map([[null,page(["b-1","b-2"],null)]]);
  const c=client(pages,{failGet:"b-2"});
  const first=await runCaravelSandboxReconcile({repository:r,client:c});
  assert.deepEqual([first.ok,first.state],[false,"retry"]);
  assert.equal(r.stats.commits,0);
  assert.equal(r.applied.size,0);
  assert.equal(r.cursor,null);
  assert.equal(r.stats.releases,1);
  c.bookingStatusSandbox=async(id,supplier)=>({data:{booking_id:id,supplier_id:supplier,revision:2,status:"cancelled"}});
  const second=await runCaravelSandboxReconcile({repository:r,client:c});
  assert.equal(second.ok,true);
  assert.equal(second.state,"complete");
  assert.equal(r.applied.get("b-2").status,"cancelled");
  assert.deepEqual(c.requests.map(x=>x.params.page_token??null),[null,null]);
});

test("revision monotonicity on replay preserves newer webhook state",async()=>{
  const r=store();
  r.applied.set("b-1",{booking_id:"b-1",revision:8,status:"cancelled"});
  const c=client(new Map([[null,page(["b-1"],null)]]),{
    refs:new Map([["b-1",{booking_id:"b-1",operator_id:"test_operator",revision:3,status:"confirmed"}]]),
  });
  const x=await runCaravelSandboxReconcile({repository:r,client:c});
  assert.equal(x.ok,true);
  assert.deepEqual(r.applied.get("b-1"),{booking_id:"b-1",revision:8,status:"cancelled"});
});

test("bad cursor, invalid summary or mismatched fetched supplier never advances checkpoint",async()=>{
  const cases=[
    {pages:new Map([[null,page(["b-1"],"\u0000bad")]])},
    {pages:new Map([[null,page(["../wrong"],null)]])},
    {pages:new Map([[null,page(["b-1"],null)]]),
      refs:new Map([["b-1",{booking_id:"b-1",supplier_id:"OTHER",revision:2,status:"confirmed"}]])},
    {pages:new Map([[null,page(["b-1"],null)]]),
      refs:new Map([["b-1",{booking_id:"b-1",operator_id:"OTHER",revision:2,status:"confirmed"}]])},
  ];
  for(const setup of cases){
    const r=store(),c=client(setup.pages,setup);
    const x=await runCaravelSandboxReconcile({repository:r,client:c});
    assert.equal(x.ok,false);
    assert.equal(r.stats.commits,0);
    assert.equal(r.cursor,null);
    assert.equal(r.state,"pending");
  }
});

test("repeated booking id in one page is fetched once and terminal status wins",async()=>{
  const r=store(),c=client(new Map([[null,page(["x","x","y"],null)]]));
  const x=await runCaravelSandboxReconcile({repository:r,client:c});
  assert.equal(x.ok,true);
  assert.deepEqual(c.gets.map(v=>v.id),["x","y"]);
  assert.equal(r.applied.size,2);
});

test("reconciliation requires sandbox client and complete durable RPC contract",async()=>{
  const r=store(),c=client(new Map());
  await assert.rejects(
    ()=>runCaravelSandboxReconcile({repository:r,client:{...c,environment:"production"}}),
    /SANDBOX_RECONCILIATION_CONFIG_REQUIRED/);
  await assert.rejects(
    ()=>runCaravelSandboxReconcile({repository:{claimJob:r.claimJob},client:c}),
    /SANDBOX_RECONCILIATION_CONFIG_REQUIRED/);
  assert.equal(r.stats.claims,0);
});

test("RPC adapter uses only Caravel sandbox recovery functions and supplier-bound parameters",async()=>{
  const calls=[];
  const admin={rpc:async(name,args)=>{
    calls.push({name,args});
    const value=name.endsWith("_claim")?job():
      name.endsWith("_apply_page")?{accepted:true,complete:true,applied:1}:true;
    return {data:value,error:null};
  }};
  const r=createCaravelSandboxWebhookRepository(admin);
  const claimed=await r.claimJob("11111111-1111-4111-8111-111111111111");
  assert.equal(claimed.supplier_id,"acct_eur");
  const applied=await r.commitPage(claimed.job_id,"11111111-1111-4111-8111-111111111111",
    [{booking_id:"b-1",revision:2,status:"cancelled"}],null);
  assert.equal(applied.complete,true);
  assert.equal(await r.releaseJob(claimed.job_id,"11111111-1111-4111-8111-111111111111"),true);
  assert.deepEqual(calls.map(x=>x.name),[
    "caravel_sbx_reconcile_claim","caravel_sbx_reconcile_apply_page","caravel_sbx_reconcile_release"]);
  assert.equal(calls[1].args.p_items[0].booking_id,"b-1");
});
