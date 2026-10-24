import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSeoHandler} from '../../supabase/functions/admin-seo/handler.ts';
import {buildTopics,renderPage,normal,ensureSeoBenefits} from '../../supabase/functions/admin-seo/core.ts';
import {postSummary} from '../../supabase/functions/admin-seo/google.ts';
import {inspectHtml,inspectPublic,classifyReview,correctionAllowed,correctionChanged,dueReview} from '../../supabase/functions/admin-seo/review.ts';
const legacy=JSON.parse(readFileSync(new URL('../../supabase/functions/admin-seo/legacy-seed.json',import.meta.url)))[0];
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function fixture(){
 const locations=[{id:'faro',partner_id:'p',active:true,country:'Portugal',region:'Algarve',city:'Faro',type:'airport',location_name:'Faro Airport (FAO)',partners:{active:true,account_status:'active'}}];
 const classes=[{partner_id:'p',active:true,deposit_amount:0,features:{noDeposit:true,noCreditCard:true,fullInsurance:true}}];
 const topics=buildTopics(locations,classes,[]),topic=topics.find(t=>t.source.kind==='airport'),pair=structuredClone(legacy.content);
 for(const lang of ['pl','en'])pair[lang].slug=topic.source.slugs[lang];
 const doc={...topic,id:id(1),content:pair,published:{revision:2,content:structuredClone(pair),marker:'fixture-marker',published_at:'2026-10-01T00:00:00Z'},revision:2,state:'published',google:{},review_note:'Prior editorial note',last_error:'',lock_token:null,lock_until:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'};
 const rows=[doc,...topics.filter(t=>t!==topic).map((t,i)=>({...t,id:id(i+2),state:'dismissed',revision:1,published:null,lock_token:null,lock_until:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'}))];
 const cfg={id:1,enabled:true,auto_generate:false,auto_review_enabled:true,auto_correction_day:null,free_tier_confirmed:true,daily_limit:5,ai_count:0,ai_day:new Date().toISOString().slice(0,10),google_client_id:'fixture-client',business_target:'accounts/1/locations/2'};
 const tables={seo_documents:rows,seo_settings:[cfg],seo_revisions:[],partner_locations:locations,car_classes:classes,locations_dictionary:[]};
 const state={publicStatus:200,publicTransform:text=>text,headerRobots:'',sitemapMissing:false,sitemapFailure:false,searchStatus:200,tokenStatus:200,verdict:'PASS',businessPosts:[],businessStatus:200,aiMode:'changed',aiCalls:0,correctionReservations:0,unauthorized:false,unauthorizedRedirect:false};
 const requests=[],writes=[],secrets={cron:'fixture-cron',gemini:'fixture-gemini',search_refresh:'fixture-search-refresh',business_refresh:'fixture-business-refresh',google_client_secret:'fixture-client-secret'};
 class Query{
  constructor(table){this.table=table;this.filters=[];this.orders=[];this.max=Infinity;this.mode='read';}
  select(){return this;}eq(k,v){this.filters.push(row=>row[k]===v);return this;}is(k,v){return this.eq(k,v);}
  order(k,{ascending=true}={}){this.orders.push({k,ascending});return this;}limit(n){this.max=n;return this;}
  single(){this.one=true;return this;}maybeSingle(){this.one=true;return this;}
  update(v){this.mode='update';this.value=v;return this;}upsert(v){this.mode='upsert';this.value=v;return this;}
  then(resolve,reject){try{const table=tables[this.table];assert.ok(table,'Unknown table '+this.table);let result=table.filter(row=>this.filters.every(f=>f(row))).sort((a,b)=>{for(const {k,ascending}of this.orders){if(a[k]!==b[k])return (a[k]<b[k]?-1:1)*(ascending?1:-1);}return 0;}).slice(0,this.max);
   if(this.mode!=='read'){assert.ok(this.table.startsWith('seo_'),'No business-data writes');writes.push({table:this.table,value:structuredClone(this.value)});}
   if(this.mode==='update')for(const row of result)Object.assign(row,structuredClone(this.value));
   if(this.mode==='upsert')for(const row of (Array.isArray(this.value)?this.value:[this.value]))if(!table.some(d=>d.topic_key===row.topic_key))table.push({...structuredClone(row),id:id(200+table.length),state:'queued',revision:1,published:null,lock_token:null,lock_until:null});
   resolve({data:structuredClone(this.one?result[0]:result),error:null});
  }catch(e){reject(e);}}
 }
 const admin={from:table=>new Query(table),async rpc(name,args={}){
  if(name==='admin_seo_secret')return {data:secrets[args.p_name]||null};
  if(name==='admin_seo_correction_slot'){const today=new Date().toISOString().slice(0,10);if(!cfg.enabled||!cfg.auto_review_enabled||cfg.auto_correction_day===today)return {data:false};cfg.auto_correction_day=today;state.correctionReservations++;return {data:true};}
  if(name==='admin_seo_ai_slot'){const today=new Date().toISOString().slice(0,10);if(cfg.ai_day!==today){cfg.ai_day=today;cfg.ai_count=0;}if(!cfg.enabled||!cfg.free_tier_confirmed||cfg.ai_count>=cfg.daily_limit)return {data:false};cfg.ai_count++;return {data:true};}
  const row=rows.find(d=>d.id===args.p_id);assert.ok(row);
  if(name==='admin_seo_claim'){if(row.revision!==args.p_revision||row.lock_until&&Date.parse(row.lock_until)>Date.now())return {error:{message:'SEO_BUSY_OR_CONFLICT'}};row.lock_token=id(999);row.lock_until=new Date(Date.now()+300000).toISOString();return {data:structuredClone(row)};}
  if(name==='admin_seo_save'){if(row.revision!==args.p_revision||row.lock_token!==args.p_lock)return {error:{message:'SEO_CONFLICT'}};tables.seo_revisions.push({document_id:row.id,revision:row.revision,content:structuredClone(row.content),note:row.review_note});row.content=structuredClone(args.p_content);row.review_note=args.p_note;row.revision++;row.state=row.published?'changed':'draft';row.lock_token=null;row.lock_until=null;return {data:structuredClone(row)};}
  throw Error('Unknown RPC '+name);
 }};
 const fetcher=async(url,init={})=>{
  const u=new URL(url);requests.push({host:u.hostname,path:u.pathname,method:init.method||'GET'});
  if(u.hostname==='ride24.pl'){
   if(state.unauthorizedRedirect)return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/secret'}});
   if(u.pathname==='/sitemap.xml')return new Response(state.sitemapMissing?'<urlset></urlset>':'<urlset>'+Object.values(doc.published.content).map(p=>'<url><loc>https://ride24.pl'+p.slug+'</loc></url>').join('')+'</urlset>',{status:state.sitemapFailure?503:200});
   const lang=['pl','en'].find(l=>doc.published.content[l].slug===u.pathname);assert.ok(lang,'Only managed SEO URLs are fetched');
   return new Response(state.publicTransform(renderPage(doc.published.content,lang,doc.published.marker)),{status:state.publicStatus,headers:{'x-robots-tag':state.headerRobots}});
  }
  if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture-access',private_error:'fixture-token-never-returned'},{status:state.tokenStatus});
  if(u.hostname==='searchconsole.googleapis.com')return Response.json({inspectionResult:{indexStatusResult:{verdict:state.verdict,coverageState:state.verdict==='PASS'?'Submitted and indexed':'Discovered - currently not indexed',indexingState:'INDEXING_ALLOWED'}}},{status:state.searchStatus});
  if(u.hostname==='mybusiness.googleapis.com'){assert.equal(init.method,'GET','Review never publishes posts');return Response.json({localPosts:state.businessPosts},{status:state.businessStatus});}
  if(u.hostname==='generativelanguage.googleapis.com'){
   state.aiCalls++;const generated=structuredClone(doc.content);if(state.aiMode==='fail')return Response.json({private_error:'fixture-provider-secret'},{status:503});
   if(state.aiMode==='changed')for(const lang of ['pl','en']){generated[lang].h1+=' — '+(lang==='pl'?'poprawiona oferta':'revised offer');generated[lang].intro_text+=' '+(lang==='pl'?'Sprawdź rzeczywiste warunki.':'Check the actual terms.');generated[lang].main_content+='\n\n'+(lang==='pl'?'Opis właściwy dla tej lokalizacji.':'Details specific to this location.');}
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(generated)}]}}]});
  }
  throw Error('Unexpected external operation '+u.hostname);
 };
 const handler=createSeoHandler({fetch:fetcher,service:()=>admin,authorize:async()=>{if(state.unauthorized)throw Error('AUTH_REQUIRED');return {admin,user:{id:'admin'}};},env:()=>undefined});
 async function call(action,body={},cron=false){const response=await handler(new Request('https://fixture.invalid/admin-seo',{method:'POST',headers:{'Content-Type':'application/json',...(cron?{'x-seo-cron':'fixture-cron'}:{})},body:JSON.stringify({action,...(!cron?{id:doc.id,revision:doc.revision}:{}),...body})}));return {status:response.status,body:await response.json()};}
 function rejected(){doc.google.business={revision:doc.revision,target:cfg.business_target,posts:{pl:{name:'accounts/1/locations/2/localPosts/1',state:'LIVE'},en:{name:'accounts/1/locations/2/localPosts/2',state:'LIVE'}}};state.businessPosts=[{name:'accounts/1/locations/2/localPosts/1',state:'REJECTED'},{name:'accounts/1/locations/2/localPosts/2',state:'LIVE'}];}
 return {doc,rows,cfg,state,tables,requests,writes,secrets,call,rejected};
}

test('live metadata parser accepts the shared PL/EN template',()=>{const f=fixture();for(const lang of ['pl','en'])assert.deepEqual(inspectHtml(lang,f.doc.published,renderPage(f.doc.content,lang,f.doc.published.marker)).issues,[]);});
test('canonical, description, hreflang and noindex issues are distinguished',()=>{
 const f=fixture();let html=renderPage(f.doc.content,'pl',f.doc.published.marker).replace(/<meta name="description"[^>]*>/,'').replace(/<link rel="canonical"[^>]*>/,'').replace(/<link rel="alternate"[^>]*>/g,'').replace('index,follow','noindex,nofollow');
 const codes=inspectHtml('pl',f.doc.published,html).issues.map(i=>i.code);for(const code of ['missing_description','wrong_canonical','missing_hreflang','noindex'])assert.ok(codes.includes(code));
 assert.ok(inspectHtml('pl',f.doc.published,html,'noindex').issues.some(i=>i.code==='header_noindex'));
});
test('wrong published revision is a deployment issue, not a content rewrite',()=>{const f=fixture();const live=inspectHtml('pl',f.doc.published,renderPage(f.doc.content,'pl','old-revision'));assert.equal(live.ready,false);assert.equal(classifyReview({ready:false,issues:live.issues},null,null,[],[]).state,'technical_issue');});
test('off-site redirects are never followed',async()=>{const f=fixture();f.state.unauthorizedRedirect=true;const r=await f.call('review');assert.equal(r.status,200);assert.equal(f.doc.google.review.state,'technical_issue');assert.ok(f.requests.every(r=>r.host!=='untrusted.invalid'));});
test('invalid published URLs cannot trigger external site or Google requests',async()=>{const f=fixture();f.doc.published.content.pl.slug='https://untrusted.invalid/';const r=await f.call('review');assert.equal(r.status,200);assert.equal(f.requests.length,0);assert.equal(f.doc.google.review.state,'technical_issue');});
test('review stores real availability and index status without any content or AI changes',async()=>{
 const f=fixture(),before=structuredClone({published:f.doc.published,content:f.doc.content});const r=await f.call('review');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(f.doc.google.review.state,'healthy');assert.equal(f.doc.google.verification.ready,true);assert.equal(f.state.aiCalls,0);assert.deepEqual({published:f.doc.published,content:f.doc.content},before);assert.equal(f.doc.revision,2);assert.equal(f.doc.lock_token,null);
});
test('normal waiting for Google indexing never creates a rewrite candidate',async()=>{const f=fixture();f.state.verdict='NEUTRAL';await f.call('review');assert.equal(f.doc.google.review.state,'waiting_indexing');assert.equal(f.doc.google.review.correction_kind,null);await f.call('cron',{},true);assert.equal(f.doc.state,'published');assert.equal(f.state.aiCalls,0);});
test('403 permissions and missing credentials are connection problems, not content problems',async()=>{
 for(const missing of [false,true]){const f=fixture();if(missing)delete f.secrets.search_refresh;else f.state.searchStatus=403;await f.call('review');assert.equal(f.doc.google.review.state,'connection_issue');assert.equal(f.doc.google.review.correction_kind,null);await f.call('cron',{},true);assert.equal(f.state.aiCalls,0);assert.equal(f.doc.state,'published');}
});
test('provider limits are temporary and never exposed with upstream secret text',async()=>{const f=fixture();f.state.searchStatus=429;const r=await f.call('review');assert.equal(f.doc.google.review.state,'temporary_error');assert.ok(!JSON.stringify(r.body).includes('fixture-access'));assert.ok(!JSON.stringify(r.body).includes('fixture-token-never-returned'));});
test('404, server headers and unavailable sitemap require hosting attention',async()=>{
 for(const kind of ['404','header','sitemap']){const f=fixture();if(kind==='404')f.state.publicStatus=404;if(kind==='header')f.state.headerRobots='noindex';if(kind==='sitemap')f.state.sitemapFailure=true;await f.call('review');assert.equal(f.doc.google.review.state,'technical_issue',kind);await f.call('cron',{},true);assert.equal(f.doc.state,'published');assert.equal(f.state.aiCalls,0);}
});
test('actual metadata defects create one approved-later draft without using AI',async()=>{
 const f=fixture(),published=structuredClone(f.doc.published),content=structuredClone(f.doc.content);f.state.publicTransform=h=>h.replace(/<link rel="canonical"[^>]*>/,'');await f.call('review');assert.equal(f.doc.google.review.correction_kind,'metadata');const r=await f.call('cron',{},true);
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.corrected_id,f.doc.id);assert.equal(f.doc.state,'changed');assert.equal(f.doc.google.review.state,'draft_ready');assert.deepEqual(f.doc.content,content);assert.deepEqual(f.doc.published,published);assert.equal(f.doc.revision,3);assert.equal(f.tables.seo_revisions.length,1);assert.equal(f.state.aiCalls,0);assert.equal(f.state.correctionReservations,1);
});
test('a missing sitemap entry can be prepared for the existing publication workflow',async()=>{const f=fixture();f.state.sitemapMissing=true;await f.call('review');assert.ok(f.doc.google.review.issues.some(i=>i.code==='sitemap_missing'));await f.call('cron',{},true);assert.equal(f.doc.state,'changed');assert.equal(f.doc.published.revision,2);});
test('a rejected Google post triggers a factual PL/EN correction draft under the shared AI quota',async()=>{
 const f=fixture(),published=structuredClone(f.doc.published);f.rejected();await f.call('review');assert.equal(f.doc.google.business.posts.pl.state,'REJECTED');assert.equal(f.doc.google.review.correction_kind,'content');const r=await f.call('cron',{},true);
 assert.equal(r.body.corrected_id,f.doc.id);assert.equal(f.doc.state,'changed');assert.equal(f.doc.google.review.state,'draft_ready');assert.deepEqual(f.doc.published,published);assert.equal(f.cfg.ai_count,1);assert.equal(f.state.aiCalls,1);assert.notEqual(f.doc.content.pl.h1,published.content.pl.h1);assert.ok(f.doc.review_note.includes('Google odrzuciło'));
 assert.ok(f.requests.every(r=>r.host!=='api.github.com'));assert.ok(f.requests.filter(r=>r.host==='mybusiness.googleapis.com').every(r=>r.method==='GET'));
});
test('old-version rejected posts cannot trigger rewriting a newer approved page',async()=>{const f=fixture();f.rejected();f.doc.google.business.revision=1;await f.call('review');assert.equal(f.doc.google.review.state,'healthy');assert.equal(f.doc.google.review.correction_kind,null);});
test('an empty historical Business status checks access without claiming a post is processing',async()=>{const f=fixture();f.doc.google.business={revision:2,target:f.cfg.business_target,posts:{},state:'processing'};await f.call('review');assert.equal(f.doc.google.business.state,'not_published');assert.ok(f.doc.google.business.checked_at);assert.equal(f.doc.google.review.state,'healthy');assert.equal(f.doc.google.review.correction_kind,null);assert.ok(f.requests.some(r=>r.host==='mybusiness.googleapis.com'&&r.method==='GET'));assert.equal(f.state.aiCalls,0);});
test('matching existing posts can be recovered read-only for the current revision',async()=>{const f=fixture();f.doc.google.business={revision:2,target:f.cfg.business_target,posts:{},state:'processing'};f.state.businessPosts=['pl','en'].map(lang=>({name:'accounts/1/locations/2/localPosts/'+lang,state:lang==='pl'?'REJECTED':'LIVE',summary:postSummary(f.doc.published.content,lang),callToAction:{url:'https://ride24.pl'+f.doc.published.content[lang].slug},languageCode:lang}));await f.call('review');assert.equal(f.doc.google.business.posts.pl.state,'REJECTED');assert.equal(f.doc.google.review.correction_kind,'content');assert.ok(f.requests.filter(r=>r.host==='mybusiness.googleapis.com').every(r=>r.method==='GET'));assert.equal(f.doc.state,'published');});
test('Business permissions are checked even when a previous attempt saved no post IDs',async()=>{const f=fixture();f.doc.google.business={revision:2,target:f.cfg.business_target,posts:{},state:'processing'};f.state.businessStatus=403;await f.call('review');assert.equal(f.doc.google.review.state,'connection_issue');assert.equal(f.doc.google.review.correction_kind,null);assert.match(f.doc.google.review.summary,/Wizytówka Google/);assert.equal(f.state.aiCalls,0);});
test('an unchanged AI response cannot be saved as a successful rejection fix',async()=>{const f=fixture();f.doc.content=ensureSeoBenefits(f.doc.content,f.doc.source);f.doc.published.content=structuredClone(f.doc.content);const original=structuredClone(f.doc.content);f.rejected();f.state.aiMode='unchanged';await f.call('review');const r=await f.call('cron',{},true);assert.ok(r.body.correction_error);assert.equal(f.doc.state,'published');assert.deepEqual(f.doc.content,original);assert.equal(f.doc.google.review.state,'correction_failed');assert.equal(f.doc.lock_token,null);});
test('a full shared AI quota pauses corrections without resetting counters or reserving an attempt',async()=>{const f=fixture();f.rejected();await f.call('review');f.cfg.ai_count=5;await f.call('cron',{},true);assert.equal(f.doc.google.review.state,'quota_paused');assert.equal(f.doc.state,'published');assert.equal(f.state.aiCalls,0);assert.equal(f.cfg.ai_count,5);assert.equal(f.state.correctionReservations,0);});
test('existing manual drafts are excluded from monitoring and automatic edits',async()=>{const f=fixture();f.doc.state='changed';f.doc.revision=3;f.doc.content.pl.h1='Manual work';const old=structuredClone(f.doc);const r=await f.call('review');assert.equal(r.status,409);await f.call('cron',{},true);assert.deepEqual(f.doc,old);assert.equal(f.state.aiCalls,0);});
test('monitor selects due pages and does not inspect the same page again that day',async()=>{const f=fixture();let r=await f.call('review',{},true);assert.equal(r.body.checked,1);const requests=f.requests.length;r=await f.call('review',{},true);assert.equal(r.body.checked,0);assert.equal(f.requests.length,requests);});
test('monitor switch and module emergency stop make no external requests',async()=>{for(const field of ['enabled','auto_review_enabled']){const f=fixture();f.cfg[field]=false;const r=await f.call('review',{},true);assert.equal(r.body.checked,0);assert.equal(f.requests.length,0);}});
test('expired locks are recoverable and live locks cannot be replaced',async()=>{const f=fixture();f.doc.lock_token=id(55);f.doc.lock_until=new Date(Date.now()+300000).toISOString();const r=await f.call('review',{},true);assert.equal(r.body.checked,0);assert.equal(f.doc.lock_token,id(55));f.doc.lock_until='2000-01-01';await f.call('review',{},true);assert.equal(f.doc.google.review.state,'healthy');});
test('one automatic correction per day prevents repeated workers and duplicate draft revisions',async()=>{const f=fixture();f.state.publicTransform=h=>h.replace(/<link rel="canonical"[^>]*>/,'');await f.call('review');await Promise.all([f.call('cron',{},true),f.call('cron',{},true)]);assert.equal(f.doc.revision,3);assert.equal(f.state.correctionReservations,1);assert.equal(f.tables.seo_revisions.length,1);});
test('seven-day cooldown, two-attempt cap and fresh assessment are enforced',()=>{
 const f=fixture();f.doc.google.review={state:'needs_correction',revision:2,checked_at:new Date().toISOString(),correction_kind:'content',issues:[]};assert.equal(correctionAllowed(f.doc),true);
 f.doc.google.review.correction={attempted_at:new Date().toISOString(),base_revision:2,attempts:1};assert.equal(correctionAllowed(f.doc),false);
 f.doc.google.review.correction.attempted_at='2000-01-01';f.doc.google.review.correction.attempts=2;assert.equal(correctionAllowed(f.doc),false);
 f.doc.google.review.correction.attempts=1;f.doc.google.review.checked_at='2000-01-01';assert.equal(correctionAllowed(f.doc),false);
});
test('unauthenticated users cannot trigger review and cron still cannot publish',async()=>{const f=fixture();f.state.unauthorized=true;assert.equal((await f.call('review')).status,401);assert.equal((await f.call('publish',{},true)).status,403);assert.equal(f.requests.length,0);});
test('identical destination bodies are diagnosed without changing source or public pages',async()=>{
 const f=fixture();const other={...structuredClone(f.doc),id:id(77),topic_key:'city|portugal|different'};other.published.content.pl.slug='/seo/inny-kierunek';other.published.content.en.slug='/seo/another-destination';f.rows.push(other);const old=structuredClone(f.doc.published);await f.call('review');assert.ok(f.doc.google.review.issues.some(i=>i.code==='duplicate_content'));assert.deepEqual(f.doc.published,old);await f.call('cron',{},true);assert.notEqual(normal(f.doc.content.pl.main_content),normal(old.content.pl.main_content));assert.equal(other.state,'published');
});
test('Google robots and alternate-canonical warnings do not trigger speculative AI rewrites',()=>{
 const f=fixture(),live={ready:true,issues:[],pages:[{lang:'pl',url:'https://ride24.pl'+f.doc.content.pl.slug},{lang:'en',url:'https://ride24.pl'+f.doc.content.en.slug}]};
 const robots=classifyReview(live,{results:{pl:{verdict:'FAIL',robots:'DISALLOWED'},en:{verdict:'PASS'}}},null,[],[]);assert.equal(robots.state,'google_attention');assert.equal(robots.correction_kind,null);
 const canonical=classifyReview(live,{results:{pl:{verdict:'NEUTRAL',google_canonical:'https://ride24.pl/seo/different'},en:{verdict:'PASS'}}},null,[],[]);assert.equal(canonical.state,'google_attention');assert.equal(canonical.correction_kind,null);
});
test('provider failure preserves the approved version, holds the error safely and prevents a same-day retry loop',async()=>{
 const f=fixture(),old=structuredClone(f.doc.published);f.rejected();await f.call('review');f.state.aiMode='fail';const r=await f.call('cron',{},true);assert.ok(r.body.correction_error.includes('przeciążenie'));assert.ok(!JSON.stringify(r.body).includes('fixture-provider-secret'));assert.deepEqual(f.doc.published,old);assert.equal(f.doc.state,'published');assert.equal(f.doc.lock_token,null);await f.call('cron',{},true);assert.equal(f.state.aiCalls,1);
});
test('review and correction remain paused for an inactive offer source',async()=>{
 const f=fixture();f.rejected();await f.call('review');f.tables.partner_locations[0].partners.active=false;await f.call('cron',{},true);assert.equal(f.doc.google.review.state,'manual_attention');assert.equal(f.state.aiCalls,0);assert.equal(f.state.correctionReservations,0);
});
