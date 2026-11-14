import test from 'node:test';
import assert from 'node:assert/strict';
import {runRenteonDemo} from '../sandbox/renteon-demo-runner.mjs';
function fixture(changes={}) {
 const calls=[],events=[],claimed=new Set();let cancelled=false;
 const credentials={api_url:'https://aggregator.renteon.com',renteon_provider_code:'demo'};
 const input={run_id:'ride24-demo-fixture',pickup_location_id:'demo-airport',dropoff_location_id:'demo-airport',vehicle_group_id:'MBMV',selections:[{id:'seat',quantity:2}]};
 const adapter={aggregatorLocations:async()=>[{external_id:'demo-airport'}],
 aggregatorAvailability:async()=>[{external_id:'MBMV',provider_quote_data:{provider_code:'demo',offer:{Provider:'demo'}}}],
 aggregatorQuoteOptions:async()=>({calculated:{Total:100,Currency:'EUR'},provider_quote_data:{provider_code:'demo'}}),
 aggregatorBook:async(c,p)=>{calls.push({operation:'save',provider:c.renteon_provider_code,category:p.vehicle_group_id});if(changes.timeout)throw Error('TIMEOUT');return {booking_reference:'demo-new-reference',status:'confirmed'}},
 aggregatorStatus:async()=>{if(changes.readError&&!cancelled)throw Error('STATUS_ERROR');return {booking_reference:'demo-new-reference',status:cancelled?'cancelled':'confirmed'}},
 aggregatorCancel:async(c,r)=>{calls.push({operation:'cancel',provider:c.renteon_provider_code,reference:r});cancelled=true;return {booking_reference:r,status:changes.pendingCancel?'pending':'cancelled'}}};
 const journal={claim:async id=>{if(claimed.has(id))return false;claimed.add(id);return true},record:async(id,event)=>events.push({id,...event})};
 return {credentials,input,adapter,journal,calls,events};
}
test('demo quote/save/read/cancel stays on demo and retains category and supplier reference',async()=>{
 const f=fixture();await runRenteonDemo(f);assert.deepEqual(f.calls.map(x=>x.operation),['save','cancel']);
 assert.ok(f.calls.every(x=>x.provider==='demo'));assert.equal(f.calls[0].category,'MBMV');assert.equal(f.events.at(-1).phase,'cancelled_verified');
 await assert.rejects(runRenteonDemo(f),/RUN_ALREADY_CLAIMED/);assert.equal(f.calls.length,2);
});
for(const provider of ['Avia','Demo','caravel',undefined])test('refuse provider '+provider,async()=>{
 const f=fixture();f.credentials.renteon_provider_code=provider;await assert.rejects(runRenteonDemo(f),/DEMO_ONLY/);assert.equal(f.events.length+f.calls.length,0);
});
test('save timeout never creates a second booking or cancels an unrelated reference',async()=>{
 const f=fixture({timeout:true});await assert.rejects(runRenteonDemo(f),/TIMEOUT/);await assert.rejects(runRenteonDemo(f),/RUN_ALREADY_CLAIMED/);
 assert.equal(f.calls.length,1);assert.equal(f.events.at(-1).phase,'failed_or_unknown');
});
test('known demo reference is cleaned up even if status read fails',async()=>{
 const f=fixture({readError:true});await assert.rejects(runRenteonDemo(f),/STATUS_ERROR/);assert.equal(f.events.at(-1).phase,'cancelled_verified');
});
test('HTTP success with pending cancellation cannot pass acceptance',async()=>{
 const f=fixture({pendingCancel:true});await assert.rejects(runRenteonDemo(f),/DEMO_CANCELLATION_UNCONFIRMED/);assert.notEqual(f.events.at(-1).phase,'cancelled_verified');
});
