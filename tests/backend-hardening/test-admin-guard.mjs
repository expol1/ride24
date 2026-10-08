import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ride24RequireAdmin,ride24RequireInternal} from '../../supabase/functions/admin-refund/ride24-admin-auth.ts';
const env={SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_URL:'https://fixture.supabase.co',RIDE24_INTERNAL_SECRET:'fixture-internal'};
globalThis.Deno={env:{get:k=>env[k]}};
let calls=[];
function request(headers={}){return new Request('https://fixture.test',{method:'POST',headers,body:'{}'});}
function mock(responses){calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});const r=responses.shift();if(r instanceof Error)throw r;if(!r)throw Error('Unexpected network call');return new Response(JSON.stringify(r.body),{status:r.status??200});};}
const checks=[];
function check(name,actual,expected){assert.deepEqual(actual,expected,name);checks.push(name);}
mock([]);check('anonymous request denied',(await ride24RequireAdmin(request())).status,401);check('anonymous request makes no external call',calls.length,0);
mock([]);check('existing trusted service bearer accepted',await ride24RequireAdmin(request({Authorization:'Bearer sb_secret_fixture'})),null);check('service bearer makes no authentication request',calls.length,0);
mock([{body:{id:'client-id'}},{body:[{role:'client'}]}]);check('ordinary client denied',(await ride24RequireAdmin(request({Authorization:'Bearer client-token'}))).status,403);
mock([{body:{id:'partner-id'}},{body:[{role:'partner'}]}]);check('ordinary partner denied',(await ride24RequireAdmin(request({Authorization:'Bearer partner-token'}))).status,403);
mock([{body:{id:'admin-id'}},{body:[{role:'admin'}]}]);check('verified administrator accepted',await ride24RequireAdmin(request({Authorization:'Bearer admin-token'})),null);check('user identity verified by Auth API',calls[0].options.headers.Authorization,'Bearer admin-token');check('role read from database',calls[1].url.includes('id=eq.admin-id'),true);check('modern secret used as apikey',calls[1].options.headers,{apikey:'sb_secret_fixture'});
mock([{status:401,body:{error:'expired'}}]);check('expired user token denied',(await ride24RequireAdmin(request({Authorization:'Bearer expired-token'}))).status,401);
mock([{body:{id:'user'}},{body:[]}]);check('missing profile denied',(await ride24RequireAdmin(request({Authorization:'Bearer user-token'}))).status,403);
mock([{body:{id:'admin-id'}},{status:500,body:{}}]);check('profile lookup failure fails closed',(await ride24RequireAdmin(request({Authorization:'Bearer admin-token'}))).status,503);
mock([new Error('network failure')]);check('network failure fails closed',(await ride24RequireAdmin(request({Authorization:'Bearer admin-token'}))).status,503);
mock([]);const deny=await ride24RequireAdmin(request(),{'Access-Control-Allow-Origin':'https://ride24.pl'});check('existing CORS header preserved',deny.headers.get('Access-Control-Allow-Origin'),'https://ride24.pl');
check('existing worker internal secret accepted',ride24RequireInternal(request({'x-internal-secret':'fixture-internal'})),null);check('incorrect internal secret denied',ride24RequireInternal(request({'x-internal-secret':'wrong'})).status,401);check('empty internal authentication denied',ride24RequireInternal(request()).status,401);
const report={passed:checks.length,checks,scope:'authentication gates only; business code unchanged',completed_at:new Date().toISOString()};console.log(JSON.stringify(report));
