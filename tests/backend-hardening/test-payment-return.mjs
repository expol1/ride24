import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {androidPaymentReturnUrl,paymentReturnBridgeUrl} from '../../supabase/functions/_shared/payment-return.mjs';

const id='b2946bd3-c586-4ce5-ab11-d8f3a5a5f9f1';
const base='https://zwyerdeuvyzgkgwglowr.supabase.co';
const root=new URL('../../',import.meta.url);
test('old Android checkout returns to a fixed HTTPS bridge without leaking the Stripe session id',()=>{
 const result=new URL(paymentReturnBridgeUrl(`${base}/functions/v1/payment-return?status=success&booking_id=${id}&session_id=cs_not_forwarded`));
 assert.equal(result.origin,'https://ride24.pl');assert.equal(result.pathname,'/auth/payment-return.html');
 assert.equal(result.searchParams.get('app'),'production');assert.equal(result.searchParams.get('booking_id'),id);
 assert.equal(result.searchParams.has('session_id'),false);
});
test('TEST and production callbacks remain separate and preserve PL/EN',()=>{
 for(const [appId,expected] of [['pl.ride24.client.test','test'],['pl.ride24.client','production']]) {
  const returned=new URL(androidPaymentReturnUrl(base,id,'success',appId,'en'));
  assert.equal(returned.searchParams.get('app'),expected);assert.equal(returned.searchParams.get('lang'),'en');
  const bridge=new URL(paymentReturnBridgeUrl(returned));assert.equal(bridge.searchParams.get('app'),expected);
 }
});
test('untrusted package, language and status cannot become an arbitrary redirect',()=>{
 const generated=androidPaymentReturnUrl(base,id,'evil','evil.app','javascript:alert(1)');
 const bridge=new URL(paymentReturnBridgeUrl(generated));
 assert.equal(bridge.origin,'https://ride24.pl');assert.equal(bridge.searchParams.get('status'),'cancel');
 assert.equal(bridge.searchParams.get('app'),'production');assert.equal(bridge.searchParams.get('lang'),'pl');
 assert.throws(()=>androidPaymentReturnUrl(base,'not-an-id','success','pl.ride24.client','pl'),/INVALID_BOOKING/);
 assert.throws(()=>paymentReturnBridgeUrl(`${base}?booking_id=<script>`),/INVALID_BOOKING/);
});
function bridge({agent='Android Chrome/140',query=`?status=success&booking_id=${id}&app=test&lang=en`}={}) {
 const html=fs.readFileSync(new URL('auth/payment-return.html',root),'utf8');
 const script=html.match(/<script>([\s\S]+)<\/script>/)[1];
 const elements=Object.fromEntries(['title','description','open-app','open-web','note','language'].map(key=>[key,{textContent:'',href:'',value:'',addEventListener(){}}]));
 const document={documentElement:{lang:'pl'},getElementById:key=>elements[key]};
 const location={search:query,href:'https://ride24.pl/auth/payment-return.html'+query};
 const timers=[];vm.runInNewContext(script,{URL,URLSearchParams,encodeURIComponent,document,location,navigator:{userAgent:agent},setTimeout:fn=>timers.push(fn)});
 return {elements,document,location,timers,html};
}
test('Chrome bridge targets the correct application and has a visible manual fallback',()=>{
 const b=bridge();assert.match(b.elements['open-app'].href,/package=pl\.ride24\.client\.test/);
 assert.match(b.elements['open-app'].href,/browser_fallback_url=/);assert.equal(b.elements['open-app'].textContent,'Open the Ride24 app TEST');
 assert.equal(b.document.documentElement.lang,'en');assert.match(b.elements['open-web'].href,/^https:\/\/ride24.pl\/klient.html/);
 assert.equal(b.timers.length,1);b.timers[0]();assert.equal(b.location.href,b.elements['open-app'].href);
});
test('Firefox retains a standard deep link and a usable Polish cancel page',()=>{
 const b=bridge({agent:'Android Firefox/158',query:`?status=cancel&booking_id=${id}&lang=pl`});
 assert.equal(b.elements['open-app'].href,`ride24://payment-cancel?booking_id=${id}`);
 assert.equal(b.elements.title.textContent,'Płatność została przerwana');
 assert.equal(b.elements['open-app'].textContent,'Otwórz aplikację Ride24');
});
test('desktop and malformed returns never force navigation or claim successful payment',()=>{
 const desktop=bridge({agent:'Desktop Firefox/158'});assert.equal(desktop.timers.length,0);
 const invalid=bridge({query:'?status=success&booking_id=<img>&app=evil'});assert.equal(invalid.timers.length,0);
 assert.equal(invalid.elements['open-app'].href,'https://ride24.pl/klient.html');
 assert.doesNotMatch(invalid.elements.description.textContent,/payment confirmed|płatność potwierdzona/i);
 assert.match(invalid.html,/name="robots" content="noindex,nofollow"/);
});
test('the checkout change only selects callback URLs and retains its server-owned money checks',()=>{
 const source=fs.readFileSync(new URL('supabase/functions/create_checkout_session/index.ts',root),'utf8');
 for(const invariant of ['booking.client_id !== user.id','Number(booking.online_payment_pln || 0)','unit_amount: Math.round(amount * 100)','metadata: { booking_id: booking.id, client_id: user.id }',': "https://ride24.pl/klient.html?payment=success"',': "https://ride24.pl/klient.html?payment=cancel"']) assert.ok(source.includes(invariant),invariant);
 assert.match(source,/androidPaymentReturnUrl\(SUPABASE_URL, booking.id, "success", body.return_app, body.language\)/);
 const handler=fs.readFileSync(new URL('supabase/functions/payment-return/index.ts',root),'utf8');
 assert.doesNotMatch(handler,/serviceClient|from\("bookings"\)|stripe\.checkout|status:\s*["']paid["']/);
});

function captureHandler(relative, bindings) {
 const source=fs.readFileSync(new URL(relative,root),'utf8').replace(/^import[^\n]*\n/gm,'');
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 let captured;vm.runInNewContext(code,{URL,Request,Response,encodeURIComponent,console,...bindings,serve:fn=>captured=fn});
 return captured;
}
test('deployed redirect handler supports GET/HEAD, rejects invalid requests and never touches bookings',async()=>{
 const handler=captureHandler('supabase/functions/payment-return/index.ts',{paymentReturnBridgeUrl});
 const result=await handler(new Request(`${base}/functions/v1/payment-return?status=success&booking_id=${id}`));
 assert.equal(result.status,302);assert.match(result.headers.get('Location'),/^https:\/\/ride24\.pl\/auth\/payment-return\.html\?/);
 assert.match(result.headers.get('Cache-Control'),/no-store/);assert.equal(result.headers.get('Referrer-Policy'),'no-referrer');
 assert.equal((await handler(new Request(`${base}/functions/v1/payment-return?booking_id=${id}`,{method:'HEAD'}))).status,302);
 assert.equal((await handler(new Request(`${base}/functions/v1/payment-return`,{method:'POST'}))).status,405);
 assert.equal((await handler(new Request(`${base}/functions/v1/payment-return?booking_id=bad`))).status,400);
});
test('real checkout handler still ignores client amounts and authorizes the saved booking before Stripe',async()=>{
 for(const [owner,expected] of [['user-a',200],['another-user',403]]) {
  const calls=[];const updates=[];
  const saved={id,client_id:owner,status:'accepted',online_payment_pln:7.86,reservation_code:'FIXTURE',payment_deadline:'2027-01-01'};
  const admin={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:saved,error:null})})}),update:data=>({eq:async()=>{updates.push(data);return {error:null};}})})};
  const userClient={auth:{getUser:async()=>({data:{user:{id:'user-a'}},error:null})}};
  class Stripe {constructor(){this.checkout={sessions:{create:async data=>{calls.push(data);return {id:'cs_fixture',url:'https://checkout.stripe.com/fixture'};}}};}}
  const handler=captureHandler('supabase/functions/create_checkout_session/index.ts',{
   Stripe,androidPaymentReturnUrl,Deno:{env:{get:name=>name==='SUPABASE_URL'?base:name}},
   createClient:(_url,key,options)=>options?userClient:admin,
  });
  const request=new Request(`${base}/functions/v1/create_checkout_session`,{method:'POST',headers:{Authorization:'Bearer fixture-jwt','Content-Type':'application/json'},body:JSON.stringify({booking_id:id,amount:0.01,client:'android',return_app:'pl.ride24.client.test',language:'en'})});
  const response=await handler(request);assert.equal(response.status,expected);
  if(expected===403){assert.equal(calls.length,0);assert.equal(updates.length,0);continue;}
  assert.equal(calls.length,1);assert.equal(calls[0].line_items[0].price_data.unit_amount,786);
  assert.equal(calls[0].line_items[0].price_data.currency,'pln');assert.equal(calls[0].metadata.client_id,'user-a');
  assert.equal(new URL(calls[0].success_url).searchParams.get('app'),'test');assert.equal(new URL(calls[0].cancel_url).searchParams.get('status'),'cancel');
  assert.equal(JSON.stringify(updates),JSON.stringify([{status:'awaiting_payment',stripe_session_id:'cs_fixture'}]));
 }
});
