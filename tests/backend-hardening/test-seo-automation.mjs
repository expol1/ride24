import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSeoHandler} from '../../supabase/functions/admin-seo/handler.ts';
import {buildTopics} from '../../supabase/functions/admin-seo/core.ts';

const seed=JSON.parse(readFileSync(new URL('../../supabase/functions/admin-seo/legacy-seed.json',import.meta.url)))[0].content;
const uuid=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function fixture(){
 const locations=[{id:'location',active:true,partner_id:'partner',partners:{active:true,account_status:'active'},country:'Albania',region:'Tirana',city:'Tirana',type:'airport',location_name:'Tirana Airport (TIA)'}];
 const classes=[{partner_id:'partner',active:true,deposit_amount:0,features:{noDeposit:true,noCreditCard:true,fullInsurance:true}}];
 const topics=buildTopics(locations,classes,[]);
 const rows=topics.map((topic,i)=>({...structuredClone(topic),id:uuid(i+1),state:topic.source.kind==='airport'?'queued':'dismissed',revision:1,published:null,google:{},review_note:'',last_error:'',lock_token:null,lock_until:null,created_at:'2020-01-02T00:00:00Z',updated_at:'2020-01-02T00:00:00Z'}));
 const target=rows.find(d=>d.state==='queued');
 const stale={...structuredClone(target),id:uuid(90),topic_key:'region|montenegro|central',label:'Old inactive location',created_at:'2000-01-01T00:00:00Z',updated_at:'2000-01-01T00:00:00Z',last_error:'No longer active'};
 rows.unshift(stale);
 const cfg={id:1,enabled:true,auto_generate:true,free_tier_confirmed:true,daily_limit:5,ai_count:0,ai_day:new Date().toISOString().slice(0,10)};
 const tables={seo_documents:rows,seo_settings:[cfg],seo_revisions:[],partner_locations:locations,car_classes:classes,locations_dictionary:[]};
 const secrets={cron:'fixture-cron',gemini:'fixture-gemini'};
 const requests=[],writes=[];
 const state={providerStatus:200,invalidJson:false,readFailure:false,aiCalls:0};
 class Query{
  constructor(table){this.table=table;this.filters=[];this.orders=[];this.max=Infinity;this.mode='read';}
  select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}is(k,v){return this.eq(k,v);}
  order(k,{ascending=true}={}){this.orders.push({k,ascending});return this;}limit(n){this.max=n;return this;}
  single(){this.one=true;return this;}maybeSingle(){this.one=true;return this;}
  update(value){this.mode='update';this.value=value;return this;}
  upsert(value){this.mode='upsert';this.value=value;return this;}
  then(resolve,reject){try{
   if(state.readFailure&&this.table==='partner_locations')return resolve({data:null,error:{message:'fixture read failure'}});
   const table=tables[this.table];assert.ok(table,'Unexpected table '+this.table);
   let found=table.filter(row=>this.filters.every(fn=>fn(row))).sort((a,b)=>{for(const {k,ascending}of this.orders){if(a[k]===b[k])continue;return (a[k]<b[k]?-1:1)*(ascending?1:-1);}return 0;}).slice(0,this.max);
   if(this.mode!=='read'){assert.ok(this.table.startsWith('seo_'));writes.push({table:this.table,value:structuredClone(this.value)});}
   if(this.mode==='update')for(const row of found)Object.assign(row,this.value);
   if(this.mode==='upsert'){for(const row of (Array.isArray(this.value)?this.value:[this.value]))if(!table.some(d=>d.topic_key===row.topic_key))table.push({...structuredClone(row),id:uuid(100+table.length),state:'queued',revision:1,published:null,lock_until:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});found=[];}
   resolve({data:structuredClone(this.one?found[0]:found),error:null});
  }catch(e){reject(e);}}
 }
 const admin={from:table=>new Query(table),async rpc(name,args={}){
  if(name==='admin_seo_secret')return {data:secrets[args.p_name]||null};
  if(name==='admin_seo_ai_slot'){
   const today=new Date().toISOString().slice(0,10);if(cfg.ai_day!==today){cfg.ai_day=today;cfg.ai_count=0;}
   if(!cfg.enabled||!cfg.free_tier_confirmed||cfg.ai_count>=cfg.daily_limit)return {data:false};cfg.ai_count++;return {data:true};
  }
  const row=rows.find(d=>d.id===args.p_id);assert.ok(row);
  if(name==='admin_seo_claim'){
   if(row.revision!==args.p_revision||row.lock_until&&Date.parse(row.lock_until)>Date.now())return {error:{message:'SEO_BUSY_OR_CONFLICT'}};
   row.lock_token=uuid(999);row.lock_until=new Date(Date.now()+300000).toISOString();return {data:structuredClone(row)};
  }
  if(name==='admin_seo_save'){
   if(row.revision!==args.p_revision||row.lock_token!==args.p_lock)return {error:{message:'SEO_CONFLICT'}};
   row.content=structuredClone(args.p_content);row.revision++;row.state=row.published?'changed':'draft';row.last_error='';row.lock_until=null;row.lock_token=null;row.updated_at=new Date().toISOString();return {data:structuredClone(row)};
  }
  throw Error('Unexpected RPC '+name);
 }};
 const handler=createSeoHandler({authorize:async()=>{throw Error('Cron must use scoped authorization');},service:()=>admin,env:()=>undefined,fetch:async(url,init)=>{
  requests.push(String(url));assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');assert.equal(init.headers['x-goog-api-key'],'fixture-gemini');state.aiCalls++;
  if(state.providerStatus!==200)return Response.json({}, {status:state.providerStatus});
  const body=JSON.parse(init.body);assert.ok(body.contents[0].parts[0].text.includes('Tirana'));const pair=structuredClone(seed);
  return Response.json({candidates:[{content:{parts:[{text:state.invalidJson?'not JSON':JSON.stringify(pair)}]}}]});
 }});
 async function cron(body={}){const response=await handler(new Request('https://fixture.invalid/admin-seo',{method:'POST',headers:{'Content-Type':'application/json','x-seo-cron':'fixture-cron'},body:JSON.stringify({action:'cron',...body})}));return {status:response.status,body:await response.json()};}
 return {rows,target,stale,cfg,secrets,state,requests,writes,cron};
}

test('inactive oldest proposals do not starve the next active queued draft',async()=>{
 const f=fixture(),old=structuredClone(f.stale);const r=await f.cron();
 assert.equal(r.status,200);assert.equal(r.body.generated_id,f.target.id);assert.equal(f.target.state,'draft');assert.equal(f.target.revision,2);assert.equal(f.state.aiCalls,1);assert.equal(f.cfg.ai_count,1);assert.deepEqual(f.stale,old);
 assert.ok(f.target.content.pl.main_content);assert.ok(f.target.content.en.main_content);assert.equal(f.target.published,null);
});
test('selection checks more than the first queue entry and preserves dismissed choices',async()=>{
 const f=fixture(),dismissed=structuredClone(f.rows.filter(d=>d.state==='dismissed'));
 for(let i=0;i<50;i++)f.rows.unshift({...structuredClone(f.stale),id:uuid(200+i),topic_key:'stale-'+i});
 await f.cron();assert.equal(f.target.state,'draft');assert.equal(f.state.aiCalls,1);assert.deepEqual(f.rows.filter(d=>d.state==='dismissed'),dismissed);
});
test('existing manual draft contents and published pages are never generated automatically',async()=>{
 const f=fixture();f.target.state='draft';f.target.content=structuredClone(seed);const published=f.rows.find(d=>d!==f.target&&d!==f.stale);published.state='published';published.content=structuredClone(seed);published.published={revision:1,content:structuredClone(seed)};
 const before=structuredClone([f.target,published]);const r=await f.cron();assert.equal(r.body.generation_skipped,'no_active_queued_topics');assert.equal(f.state.aiCalls,0);assert.deepEqual([f.target,published],before);
});
test('a live lock is skipped without blocking another active topic',async()=>{
 const f=fixture();f.target.lock_token=uuid(888);f.target.lock_until=new Date(Date.now()+300000).toISOString();const other=f.rows.find(d=>d.source.kind==='country');other.state='queued';const r=await f.cron();
 assert.equal(r.body.generated_id,other.id);assert.equal(f.target.state,'queued');assert.equal(f.target.lock_token,uuid(888));assert.equal(f.state.aiCalls,1);
});
test('an expired lock can be reclaimed for an active queued draft',async()=>{
 const f=fixture();f.target.lock_token=uuid(888);f.target.lock_until='2020-01-01T00:00:00Z';await f.cron();assert.equal(f.target.state,'draft');assert.equal(f.target.lock_token,null);
});
test('daily quota is respected without overwriting an existing error or consuming an AI call',async()=>{
 const f=fixture();f.cfg.ai_count=5;f.target.last_error='Prior provider note';const before=structuredClone(f.target),r=await f.cron();
 assert.equal(r.body.generation_skipped,'daily_limit');assert.equal(r.body.next_draft_id,f.target.id);assert.equal(f.state.aiCalls,0);assert.equal(f.cfg.ai_count,5);assert.deepEqual(f.target,before);
});
test('yesterday quota does not prevent the next day draft under the atomic server counter',async()=>{
 const f=fixture();f.cfg.ai_day='2000-01-01';f.cfg.ai_count=5;await f.cron();assert.equal(f.target.state,'draft');assert.equal(f.cfg.ai_count,1);
});
for(const [setting,value,reason]of [['auto_generate',false,'automation_disabled'],['free_tier_confirmed',false,'free_confirmation_required']])test('disabled '+setting+' never makes an AI request',async()=>{
 const f=fixture();f.cfg[setting]=value;const r=await f.cron();assert.equal(r.body.generation_skipped,reason);assert.equal(f.state.aiCalls,0);
});
test('missing Gemini configuration does not change existing credentials',async()=>{
 const f=fixture();delete f.secrets.gemini;const r=await f.cron();assert.equal(r.body.generation_skipped,'gemini_not_configured');assert.deepEqual(f.secrets,{cron:'fixture-cron'});assert.equal(f.state.aiCalls,0);
});
test('one failed active topic is moved behind other pending topics, with one AI attempt per run',async()=>{
 const f=fixture(),other=f.rows.find(d=>d.source.kind==='country');other.state='queued';other.updated_at='2020-01-03T00:00:00Z';f.state.providerStatus=503;
 const failure=await f.cron();assert.ok(failure.body.generation_error.includes('przeciążenie'));assert.equal(f.target.state,'queued');assert.equal(f.target.content,null);assert.equal(f.target.lock_token,null);assert.equal(f.state.aiCalls,1);assert.ok(Date.parse(f.target.updated_at)>Date.parse(other.updated_at));
 f.state.providerStatus=200;const next=await f.cron();assert.equal(next.body.generated_id,other.id);assert.equal(other.state,'draft');assert.equal(f.state.aiCalls,2);
});
test('invalid provider output does not save an incomplete PL/EN draft',async()=>{
 const f=fixture();f.state.invalidJson=true;const r=await f.cron();assert.ok(r.body.generation_error);assert.equal(f.target.content,null);assert.equal(f.target.revision,1);assert.equal(f.target.lock_token,null);assert.equal(f.state.aiCalls,1);
});
test('source read failure stops safely before AI or SEO writes',async()=>{
 const f=fixture();f.state.readFailure=true;const r=await f.cron();assert.equal(r.status,502);assert.equal(f.state.aiCalls,0);assert.equal(f.writes.length,0);
});
test('concurrent workers still claim and generate the same draft only once',async()=>{
 const f=fixture();await Promise.all([f.cron(),f.cron()]);assert.equal(f.state.aiCalls,1);assert.equal(f.target.state,'draft');assert.equal(f.target.revision,2);assert.equal(f.cfg.ai_count,1);
});
