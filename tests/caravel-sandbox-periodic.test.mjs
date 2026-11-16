// Periodic silent-webhook recovery: mock-only, no remote provider or Supabase.
import test from "node:test";
import assert from "node:assert/strict";
import {runCaravelSandboxPeriodicPoll} from "../supabase/functions/_shared/caravel-sandbox-periodic.mjs";
import {createCaravelSandboxWebhookRepository} from "../supabase/functions/_shared/caravel-webhook-repository.mjs";

const NOW=Date.parse("2026-11-16T18:05:00Z");
function repo(){
  const jobs=new Map(),observed=new Map(),log=[];
  return {jobs,observed,log,
    async registerSuppliers(ids){
      log.push(["register",ids]);
      for(const id of ids)if(!jobs.has(id))jobs.set(id,{
        supplier_id:id,scan_from:"2026-11-16T17:00:00Z",
        scan_to:"2026-11-16T18:00:00Z",page_token:null,
        state:"pending",lease:null,watermark:null,
      });
      return ids.length;
    },
    async claimPeriodic(lease){
      const job=[...jobs.values()].find(x=>x.state==="pending");
      if(!job)return null;
      job.lease=lease;job.state="running";
      log.push(["claim",job.supplier_id,job.page_token]);
      return structuredClone(job);
    },
    async commitPeriodicPage(supplier,lease,items,next){
      const job=jobs.get(supplier);
      assert.equal(job?.lease,lease);
      log.push(["commit",supplier,items,next]);
      for(const item of items){
        const key=supplier+":"+item.booking_id;
        const prior=observed.get(key);
        if(!prior||prior.revision<item.revision)observed.set(key,{...item});
      }
      job.page_token=next;
      job.state=next===null?"idle":"pending";
      if(next===null)job.watermark=job.scan_to;
      job.lease=null;
      return {accepted:true,complete:next===null,changed:items.length};
    },
    async releasePeriodic(supplier,lease){
      const job=jobs.get(supplier);
      log.push(["release",supplier]);
      if(job?.lease===lease){job.state="pending";job.lease=null;return true;}
      return false;
    },
  };
}
function provider({suppliers=["acct_eur","acct_gbp"],pages=new Map(),onGet=null}={}){
  const calls=[];
  return {environment:"sandbox",calls,
    async suppliers(){calls.push(["suppliers"]);return {data:suppliers.map(supplier_id=>({supplier_id}))};},
    async listBookings(params,supplier){
      calls.push(["list",supplier,params.page_token??null,params.updated_since]);
      const page=pages.get(supplier)?.get(params.page_token??null);
      if(!page)throw Error("PAGE_UNAVAILABLE");
      return structuredClone(page);
    },
    async bookingStatusSandbox(id,supplier){
      calls.push(["get",supplier,id]);
      if(onGet)return {data:await onGet(id,supplier)};
      return {data:{booking_id:id,supplier_id:supplier,revision:2,status:"confirmed",
        customer:{email:"private@example.test"}}};
    },
  };
}
const page=(ids,token=null)=>({data:ids.map(booking_id=>({booking_id})),meta:{next_page:token}});
const run=(client,repository,opts={})=>runCaravelSandboxPeriodicPoll({client,repository,now:()=>NOW,...opts});

test("no-webhook: supplier-scoped multi-page scans complete with fixed watermark and opaque cursor",async()=>{
  const r=repo(),p=provider({pages:new Map([
    ["acct_eur",new Map([[null,page(["e1","e2"],"opaque+1==")],["opaque+1==",page(["e3"],null)]])],
    ["acct_gbp",new Map([[null,page(["g1"],null)]])],
  ])});
  const first=await run(p,r);
  assert.deepEqual([first.ok,first.state,first.bookings],[true,"more",2]);
  assert.equal(r.jobs.get("acct_eur").watermark,null);
  const second=await run(p,r);
  assert.deepEqual([second.ok,second.state,second.bookings],[true,"complete",1]);
  assert.equal(r.jobs.get("acct_eur").watermark,"2026-11-16T18:00:00Z");
  const third=await run(p,r);
  assert.equal(third.ok,true);
  assert.equal(r.jobs.get("acct_gbp").watermark,"2026-11-16T18:00:00Z");
  assert.equal((await run(p,r)).state,"idle");
  assert.deepEqual(p.calls.filter(x=>x[0]==="list").map(x=>x.slice(1)),[
    ["acct_eur",null,"2026-11-16T17:00:00Z"],
    ["acct_eur","opaque+1==","2026-11-16T17:00:00Z"],
    ["acct_gbp",null,"2026-11-16T17:00:00Z"],
  ]);
  assert.equal(r.observed.size,4);
  assert.equal(JSON.stringify([...r.observed.values()]).includes("private@example.test"),false);
});

test("mid-page failure never advances cursor/watermark and full page is rechecked",async()=>{
  const r=repo();let unavailable=true;
  const pages=new Map([["acct_eur",new Map([[null,page(["x","y"],null)]])]]);
  const p=provider({suppliers:["acct_eur"],pages,onGet:async(id,supplier)=>{
    if(id==="y"&&unavailable)throw Error("network");
    return {booking_id:id,supplier_id:supplier,revision:3,status:"cancelled"};
  }});
  const fail=await run(p,r);
  assert.deepEqual([fail.ok,fail.state],[false,"retry"]);
  assert.equal(r.log.filter(x=>x[0]==="commit").length,0);
  assert.equal(r.jobs.get("acct_eur").watermark,null);
  unavailable=false;
  const pass=await run(p,r);
  assert.equal(pass.state,"complete");
  assert.equal(r.observed.get("acct_eur:y").status,"cancelled");
  assert.deepEqual(p.calls.filter(x=>x[0]==="list").map(x=>x[2]),[null,null]);
});

test("older provider revision never overwrites newer observed revision",async()=>{
  const r=repo();
  r.observed.set("acct_eur:x",{booking_id:"x",revision:8,status:"cancelled"});
  const p=provider({suppliers:["acct_eur"],
    pages:new Map([["acct_eur",new Map([[null,page(["x"],null)]])]]),
    onGet:async(id,supplier)=>({booking_id:id,supplier_id:supplier,revision:2,status:"confirmed"}),
  });
  assert.equal((await run(p,r)).ok,true);
  assert.equal(r.observed.get("acct_eur:x").revision,8);
  assert.equal(r.observed.get("acct_eur:x").status,"cancelled");
});

test("invalid opaque token, foreign supplier and bad ID do not checkpoint",async()=>{
  const scenarios=[
    {page:page(["x"],"\u0000bad")},
    {page:page(["../bad"],null)},
    {page:page(["x"],null),onGet:async id=>({booking_id:id,supplier_id:"other",revision:1,status:"confirmed"})},
    {page:page(["x"],null),onGet:async id=>({booking_id:id,supplier_id:"acct_eur",revision:0,status:"confirmed"})},
  ];
  for(const scenario of scenarios){
    const r=repo(),p=provider({suppliers:["acct_eur"],
      pages:new Map([["acct_eur",new Map([[null,scenario.page]])]]),onGet:scenario.onGet});
    const result=await run(p,r);
    assert.equal(result.ok,false);
    assert.equal(r.jobs.get("acct_eur").watermark,null);
    assert.equal(r.observed.size,0);
    assert.equal(r.log.filter(x=>x[0]==="commit").length,0);
  }
});

test("same booking repeated in a page is fetched once",async()=>{
  const r=repo(),p=provider({suppliers:["acct_eur"],
    pages:new Map([["acct_eur",new Map([[null,page(["x","x","y"],null)]])]])});
  const result=await run(p,r);
  assert.deepEqual([result.ok,result.bookings],[true,2]);
  assert.deepEqual(p.calls.filter(x=>x[0]==="get").map(x=>x[2]),["x","y"]);
});

test("cannot poll production client or accept invalid supplier catalogue",async()=>{
  const r=repo(),p=provider({suppliers:["acct_eur"],pages:new Map()});
  await assert.rejects(()=>run({...p,environment:"production"},r),
    /CARAVEL_PERIODIC_SANDBOX_REPOSITORY_REQUIRED/);
  const wrong=provider({suppliers:["../bad"]});
  await assert.rejects(()=>run(wrong,r),/CARAVEL_PERIODIC_SUPPLIERS_INVALID/);
  assert.equal(r.jobs.size,0);
});

test("DB scan time after slow supplier discovery is valid even when >1s past worker start",async()=>{
  const r=repo(),p=provider({suppliers:["acct_eur"],
    pages:new Map([["acct_eur",new Map([[null,page(["x"],null)]])]])});
  let clock=NOW;
  const claim=r.claimPeriodic.bind(r);
  r.claimPeriodic=async lease=>{
    // A real RPC uses clock_timestamp() after the earlier supplier API + DB calls.
    clock=NOW+2500;
    r.jobs.get("acct_eur").scan_to=new Date(clock).toISOString().replace(".000Z","Z");
    return claim(lease);
  };
  const out=await runCaravelSandboxPeriodicPoll({client:p,repository:r,now:()=>clock});
  assert.equal(out.state,"complete");
  assert.equal(out.bookings,1);
  assert.equal(r.log.filter(x=>x[0]==="release").length,0);
});

test("far-future DB scan time still fails closed without reading bookings",async()=>{
  const r=repo(),p=provider({suppliers:["acct_eur"]});
  let clock=NOW;
  const claim=r.claimPeriodic.bind(r);
  r.claimPeriodic=async lease=>{
    clock=NOW+2500;
    r.jobs.get("acct_eur").scan_to=new Date(clock+120000).toISOString().replace(".000Z","Z");
    return claim(lease);
  };
  const out=await runCaravelSandboxPeriodicPoll({client:p,repository:r,now:()=>clock});
  assert.equal(out.state,"invalid_job");
  assert.equal(out.ok,false);
  assert.equal(r.log.filter(x=>x[0]==="release").length,1);
  assert.equal(p.calls.some(x=>x[0]==="list"),false);
});

test("repository adapter uses only four restricted periodic RPCs",async()=>{
  const calls=[];
  const admin={rpc:async(name,args)=>{
    calls.push({name,args});
    if(name.endsWith("_register"))return {data:2,error:null};
    if(name.endsWith("_claim"))return {data:{
      supplier_id:"acct_eur",scan_from:"2026-11-16T17:00:00Z",
      scan_to:"2026-11-16T18:00:00Z",page_token:null,
    },error:null};
    if(name.endsWith("_commit"))return {data:{accepted:true,complete:true,changed:1},error:null};
    return {data:true,error:null};
  }};
  const r=createCaravelSandboxWebhookRepository(admin);
  assert.equal(await r.registerSuppliers(["acct_eur","acct_gbp"]),2);
  const leased="00000000-0000-4000-8000-000000000010";
  assert.equal((await r.claimPeriodic(leased)).supplier_id,"acct_eur");
  assert.equal((await r.commitPeriodicPage("acct_eur",leased,[{booking_id:"x",revision:2,status:"cancelled"}],null)).complete,true);
  assert.equal(await r.releasePeriodic("acct_eur",leased),true);
  assert.deepEqual(calls.map(x=>x.name),[
    "caravel_sbx_periodic_register","caravel_sbx_periodic_claim",
    "caravel_sbx_periodic_commit","caravel_sbx_periodic_release",
  ]);
});
