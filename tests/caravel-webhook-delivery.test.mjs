// No real Caravel API calls, Supabase mutations or secrets.
// Tests of a durable-claim webhooks workflow against an in-memory MOCK repository.
import test from "node:test";
import assert from "node:assert/strict";
import {handleCaravelSandboxDelivery} from "../supabase/functions/_shared/caravel-webhook-delivery.mjs";
import {createCaravelSandboxWebhookRepository} from "../supabase/functions/_shared/caravel-webhook-repository.mjs";
import {caravelSignatureFor} from "../supabase/functions/_shared/caravel-webhooks.ts";

const path="/functions/v1/caravel-sandbox-webhook-receiver";
const key="unit-test-fixture-only";
const now=Date.UTC(2026,10,16,18,10,0)/1000;
const eventId=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const event=(n=1,rev=1,sequence=1)=>({
  event_id:eventId(n),operator_id:eventId(22),booking_id:eventId(33),supplier_id:"acct_eur",
  external_ref:"ride24-sandbox-012",type:"booking.modified",occurred_at:"2026-11-16T18:10:00Z",
  api_version:"1.67.0",revision:rev,sequence,data:{
    booking_id:eventId(33),status:"confirmed",revision:rev,customer:{email:"DO_NOT_PERSIST@example.test"},
  },
});
const signed=async (e, opts={})=>{
  const rawBody=JSON.stringify(e),signature=`t=${now},v1=${await caravelSignatureFor(key,now,"POST",path,rawBody)}`;
  return {method:"POST",path,rawBody,signature,secrets:[key],nowSecs:now,...opts};
};
function memoryRepository(){
  const events=new Map(),bookings=new Map(),streams=new Map();
  const counter={fetches:0,releases:0};
  return {events,bookings,streams,counter,
    async claim(e,lease){
      const prior=events.get(e.event_id);
      if(prior)return prior.done?"complete":"busy";
      events.set(e.event_id,{lease,done:false});return "claimed";
    },
    async finalize(e,lease,fetched){
      const own=events.get(e.event_id);
      if(!own||own.lease!==lease)throw Error("NOT_OWNED");
      const prev=bookings.get(e.booking_id);
      const stale=!!prev&&prev.revision>=fetched.revision;
      if(!stale)bookings.set(e.booking_id,{revision:fetched.revision,status:fetched.status});
      const previous=streams.get(e.operator_id);
      const gap=previous!==undefined&&e.sequence!==null&&e.sequence>previous+1;
      if(e.sequence!==null)streams.set(e.operator_id,Math.max(previous??0,e.sequence));
      own.done=true;return {outcome:stale?"stale":"applied",sequence_gap:gap};
    },
    async release(e,lease){
      counter.releases++;
      if(events.get(e.event_id)?.lease===lease && !events.get(e.event_id)?.done)events.delete(e.event_id);
    },
  };
}
const booking=(rev=1)=>({booking_id:eventId(33),supplier_id:"acct_eur",revision:rev,status:"confirmed",customer:{email:"NOT_SAVED@example.test"}});

test("HMAC verified event is atomically claimed and Caravel booking is re-fetched; replay is deduped",async()=>{
  const repository=memoryRepository();
  const read=async(id,sid)=>{repository.counter.fetches++;assert.equal(id,eventId(33));assert.equal(sid,"acct_eur");return booking(3);};
  const params=await signed(event(1));
  const r=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:read});
  assert.deepEqual([r.status,r.accepted,r.reason],[202,true,"EVENT_REFETCHED_AND_RECORDED"]);
  assert.equal(repository.bookings.get(eventId(33)).revision,3);
  assert.equal(repository.counter.fetches,1);
  const replay=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:read});
  assert.equal(replay.status,200);
  assert.equal(replay.reason,"DUPLICATE_ALREADY_PROCESSED");
  assert.equal(repository.counter.fetches,1);
  assert.equal(JSON.stringify([...repository.bookings]).includes("NOT_SAVED"),false);
});

test("stale revision never overrides fetched newer state, and sequence gaps are reported only",async()=>{
  const repository=memoryRepository();
  let out=await handleCaravelSandboxDelivery({...await signed(event(2,2,10)),repository,fetchBooking:async()=>booking(5)});
  assert.equal(out.status,202);
  out=await handleCaravelSandboxDelivery({...await signed(event(3,1,13)),repository,fetchBooking:async()=>booking(3)});
  assert.equal(out.status,202);
  assert.equal(out.reason,"STALE_EVENT_RECORDED");
  assert.equal(out.needs_reconciliation,true);
  assert.equal(repository.bookings.get(eventId(33)).revision,5);
  assert.equal(repository.streams.get(eventId(22)),13);
});

test("invalid HMAC/path/replay age rejected before touching DB or fetching booking",async()=>{
  const repository=memoryRepository();
  let fetched=false;
  const read=async()=>{fetched=true;return booking();};
  const good=await signed(event());
  for(const override of [{rawBody:good.rawBody+" "},{path:"/wrong"},{nowSecs:now+301},{secrets:["wrong-secret"]}]){
    const result=await handleCaravelSandboxDelivery({...good,...override,repository,fetchBooking:read});
    assert.equal(result.status,401);
  }
  assert.equal(repository.events.size,0);
  assert.equal(fetched,false);
});

test("HMAC-signed event lacking supplier and malformed event are rejected before writes",async()=>{
  const repository=memoryRepository();
  const x=event();delete x.supplier_id;
  const a=await handleCaravelSandboxDelivery({...await signed(x),repository,fetchBooking:async()=>booking()});
  assert.deepEqual([a.status,a.reason],[400,"INVALID_SIGNED_EVENT"]);
  assert.equal(repository.events.size,0);
  const malformed=await handleCaravelSandboxDelivery({...await signed({foo:"bad"}),repository,fetchBooking:async()=>booking()});
  assert.equal(malformed.status,400);
});

test("fetch failure or upstream revision behind signed event yields non-2xx and releases claim for redelivery",async()=>{
  const repository=memoryRepository();
  const params=await signed(event(4,4,1));
  let result=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:async()=>{throw Error("503");}});
  assert.equal(result.status,503);
  assert.equal(repository.counter.releases,1);
  assert.equal(repository.events.size,0);
  result=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:async()=>booking(3)});
  assert.equal(result.status,503);
  assert.equal(repository.events.size,0);
  result=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:async()=>booking(4)});
  assert.equal(result.status,202);
  assert.equal(repository.events.size,1);
});

test("provider mismatch cannot mark event processed; busy claim is retryable",async()=>{
  const repository=memoryRepository();
  const params=await signed(event(5,1,1));
  let r=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:async()=>({...booking(),supplier_id:"other"})});
  assert.equal(r.status,503);
  repository.events.set(eventId(5),{lease:"different",done:false});
  r=await handleCaravelSandboxDelivery({...params,repository,fetchBooking:async()=>booking()});
  assert.equal(r.status,503);
  assert.equal(r.reason,"EVENT_IN_PROGRESS");
});

test("repository adapter calls only expected restricted RPCs and does not expose values",async()=>{
  const calls=[];
  const admin={rpc:async(name,args)=>{
    calls.push({name,args});
    if(name.endsWith("_claim"))return {data:"claimed",error:null};
    if(name.endsWith("_finalize"))return {data:{outcome:"applied",sequence_gap:false},error:null};
    return {data:true,error:null};
  }};
  const r=createCaravelSandboxWebhookRepository(admin);
  const e=event(),lease=eventId(88);
  assert.equal(await r.claim(e,lease),"claimed");
  assert.deepEqual(await r.finalize(e,lease,{revision:2,status:"cancelled"}),{outcome:"applied",sequence_gap:false});
  assert.equal(await r.release(e,lease),true);
  assert.deepEqual(calls.map(c=>c.name),[
    "caravel_sbx_webhook_claim","caravel_sbx_webhook_finalize","caravel_sbx_webhook_release"]);
  assert.equal(calls[0].args.p_supplier_id,"acct_eur");
  assert.equal(calls[1].args.p_fetched_revision,2);
  assert.equal(JSON.stringify(calls).includes("DO_NOT_PERSIST"),false);
});
