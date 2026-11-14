import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler} from '../../../../supabase/functions/pegasus-booking-export/handler.mjs';
const SECRET='A'.repeat(48);
function setup(overrides={}, runPage=async()=>({partnerId:'B61DFC7B',items:[],nextCursor:null,hasMore:false})) {
 const env={PEGASUS_EXPORT_TOKEN_CURRENT:SECRET,PEGASUS_EXPORT_ENABLED:'true',...overrides};
 const handler=makeHandler({getEnv:k=>env[k],runPage});
 const req=(url='https://example.test/functions/v1/pegasus-booking-export',token=SECRET,method='GET')=>
  new Request(url,{method,headers:{'x-pegasus-export-token':token}});
 return {handler,req};
}
test('success limited to Pegasus',async()=>{
 const {handler,req}=setup();const r=await handler(req());assert.equal(r.status,200);
 assert.equal((await r.json()).partnerId,'B61DFC7B');
 assert.equal(r.headers.get('cache-control'),'no-store, private');
});
test('wrong token rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req(undefined,'wrong'))).status,401)});
test('POST rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req(undefined,SECRET,'POST'))).status,405)});
test('disabled means zero DB reads',async()=>{
 let called=0;const {handler,req}=setup({PEGASUS_EXPORT_ENABLED:'false'},async()=>{called++});
 assert.equal((await handler(req())).status,503);assert.equal(called,0);
});
test('missing token configuration rejected',async()=>{const {handler,req}=setup({PEGASUS_EXPORT_TOKEN_CURRENT:''});assert.equal((await handler(req())).status,503)});
test('previous token accepted for rotation',async()=>{const old='B'.repeat(48);const {handler,req}=setup({PEGASUS_EXPORT_TOKEN_PREVIOUS:old});assert.equal((await handler(req(undefined,old))).status,200)});
test('invalid cursor rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req('https://e.test/?after=bad'))).status,400)});
test('limit above 100 rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req('https://e.test/?limit=101'))).status,400)});
test('limit 100 accepted',async()=>{const {handler,req}=setup();assert.equal((await handler(req('https://e.test/?limit=100'))).status,200)});
test('other partner query rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req('https://e.test/?partnerId=OTHER'))).status,400)});
test('duplicate cursor rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req('https://e.test/?after=11111111-1111-4111-8111-111111111111&after=22222222-2222-4222-8222-222222222222'))).status,400)});
test('other partner DB response rejected',async()=>{const {handler,req}=setup({},async()=>({partnerId:'OTHER',items:[]}));assert.equal((await handler(req())).status,503)});
test('internal errors sanitized',async()=>{const {handler,req}=setup({},async()=>{throw Error('private database info')});const r=await handler(req());assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private database info'))});
test('rate limit is 429',async()=>{const {handler,req}=setup({},async()=>{throw Error('EXPORT_RATE_LIMIT')});assert.equal((await handler(req())).status,429)});
test('credential in query string rejected',async()=>{const {handler,req}=setup();assert.equal((await handler(req('https://e.test/?token='+SECRET))).status,400)});
