import {SeoError,validatePair,warnings,buildTopics,makePrompt,hash,LANGS,SITE,type Pair} from './core.ts';
import {publishPair,verifyPublic} from './github.ts';
import {CALLBACK,credentials,googleAccess,googleApi,submitSitemap,inspectPair,businessTargets,existingPosts,createPost,postSummary,oauthStart,type Provider} from './google.ts';
type Deps={fetch:typeof fetch;authorize:(req:Request)=>Promise<{admin:any;user:any}>;service:()=>any;env:(name:string)=>string|undefined};
const origins=new Set(['https://ride24.pl','https://www.ride24.pl','http://localhost:8080','http://127.0.0.1:8080','http://localhost:5500','http://127.0.0.1:5500']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function rpc(admin:any,name:string,args:any={}){const r=await admin.rpc(name,args);if(r.error){if(/SEO_BUSY/.test(r.error.message))throw new SeoError('Ta wersja jest już przetwarzana lub została zmieniona. Odśwież listę.',409);if(/SEO_CONFLICT/.test(r.error.message))throw new SeoError('Ktoś zapisał nowszą wersję. Odśwież listę, aby zachować zmiany.',409);throw new SeoError('Nie udało się zapisać danych SEO. Spróbuj ponownie.',502);}return r.data;}
async function secret(admin:any,name:string,value?:string){return rpc(admin,'admin_seo_secret',{p_name:name,...(value===undefined?{}:{p_value:value})});}
async function settings(admin:any){const r=await admin.from('seo_settings').select('*').eq('id',1).single();if(r.error||!r.data)throw new SeoError('Moduł SEO nie jest dostępny.',503);return r.data;}
async function document(admin:any,id:any){if(typeof id!=='string'||!UUID.test(id))throw new SeoError('Nieprawidłowy identyfikator SEO.');const r=await admin.from('seo_documents').select('*').eq('id',id).single();if(r.error||!r.data)throw new SeoError('Nie znaleziono strony SEO.',404);return r.data;}
function check(r:any){if(r.error)throw new SeoError('Nie udało się zapisać danych SEO.',502);return r.data;}
async function safeBody(req:Request){if(!req.headers.get('content-type')?.startsWith('application/json'))throw new SeoError('Wymagany formularz JSON.',415);const reader=req.body?.getReader();if(!reader)throw new SeoError('Brak danych.');let n=0;const chunks=[];for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>180000){await reader.cancel();throw new SeoError('Formularz jest zbyt duży.',413);}chunks.push(value);}const bytes=new Uint8Array(n);let i=0;for(const chunk of chunks){bytes.set(chunk,i);i+=chunk.length;}try{const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!v||typeof v!=='object'||Array.isArray(v))throw new Error();return v;}catch{throw new SeoError('Nieprawidłowy formularz JSON.');}}
async function getTopics(admin:any){
 const results=await Promise.all([
  admin.from('partner_locations').select('id,partner_id,country,region,city,location_name,type,active,extra_fee,extra_fee_amount,contact_required,partners!inner(active,account_status,api_enabled)').eq('active',true).limit(2000),
  admin.from('car_classes').select('partner_id,active').eq('active',true).limit(5000),
  admin.from('locations_dictionary').select('name_en,name_pl').limit(3000)
 ]);
 if(results.some(r=>r.error))throw new SeoError('Nie udało się pobrać lokalizacji dla SEO.',502);
 return buildTopics(results[0].data||[],results[1].data||[],results[2].data||[]);
}
async function sync(admin:any){
 const topics=await getTopics(admin);const before=check(await admin.from('seo_documents').select('id,topic_key,source').limit(1000))||[];const known=new Map(before.map((d:any)=>[d.topic_key,d]));
 const missing=topics.filter(t=>!known.has(t.topic_key));
 if(missing.length)check(await admin.from('seo_documents').upsert(missing,{onConflict:'topic_key',ignoreDuplicates:true}));
 for(const t of topics){const d:any=known.get(t.topic_key);if(d&&JSON.stringify(d.source)!==JSON.stringify(t.source))check(await admin.from('seo_documents').update({source:t.source}).eq('id',d.id));}
 return {added:missing.length,active:topics.length};
}
async function generate(deps:Deps,admin:any,doc:any,note:string){
 const key=await secret(admin,'gemini');if(!key)throw new SeoError('Dodaj klucz Gemini z darmowego projektu w ustawieniach SEO.',409);
 const topics=await getTopics(admin);const live=topics.find(t=>t.topic_key===doc.topic_key);
 if(!live)throw new SeoError('Ten kierunek nie ma obecnie aktywnych lokalizacji z ofertami. Możesz poprawić tekst ręcznie, bez wymyślania dostępności.',409);
 const claimed=await rpc(admin,'admin_seo_claim',{p_id:doc.id,p_revision:doc.revision});
 try{
  if(!await rpc(admin,'admin_seo_ai_slot'))throw new SeoError('Darmowy limit dzienny został wykorzystany lub nie potwierdzono poziomu Free. Tekst możesz edytować ręcznie.',429);
  const r=await deps.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts:[{text:makePrompt(live.source,doc.content,note)}]}],generationConfig:{responseMimeType:'application/json',temperature:0.5,maxOutputTokens:10000,thinkingConfig:{thinkingLevel:'low'}}})});
  if(!r.ok)throw new SeoError(r.status===429?'Gemini osiągnął limit bezpłatnej usługi. Spróbuj później; nie uruchomiono płatnego zastępstwa.':'Gemini nie wygenerował tekstu. Sprawdź klucz, poziom Free i dostępność modelu.',r.status===429?429:502);
  const json=await r.json();let value:any;try{const text=json.candidates?.[0]?.content?.parts?.filter((p:any)=>typeof p.text==='string'&&!p.thought).map((p:any)=>p.text).join('');if(!text||text.length>130000)throw new Error();value=JSON.parse(text);}catch{throw new SeoError('AI nie zwróciło kompletnego tekstu PL/EN. Poprzednia wersja pozostaje dostępna.',502);}
  const pair=validatePair(value,doc.published?.content||null);
  // AI never chooses paths: existing paths remain stable, new paths come from deterministic source data.
  for(const lang of LANGS)pair[lang].slug=doc.content?.[lang]?.slug||live.source.slugs[lang];
  const saved=await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:pair,p_note:note,p_lock:claimed.lock_token});
  return {document:saved,warnings:warnings(pair)};
 }finally{await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',claimed.lock_token);}
}
export function createSeoHandler(deps:Deps){return async(req:Request)=>{
 const headers={'Access-Control-Allow-Origin':origins.has(req.headers.get('origin')||'')?req.headers.get('origin')!:'https://ride24.pl','Access-Control-Allow-Headers':'authorization,apikey,x-client-info,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
 const reply=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(req.headers.has('origin')&&!origins.has(req.headers.get('origin')!))return reply({error:'Niedozwolona strona wysyłająca.'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return reply({error:'Dozwolony jest formularz POST.'},405);
 try{
  let admin:any,user:any,cron=false;
  const supplied=req.headers.get('x-seo-cron');
  if(supplied){admin=deps.service();const expected=await secret(admin,'cron');if(!expected||await hash(supplied)!==await hash(expected))return reply({error:'Brak dostępu.'},401);cron=true;}
  else ({admin,user}=await deps.authorize(req));
  const body=await safeBody(req);const s=await settings(admin);const action=body.action||'list';
  if(cron){
   if(action!=='cron')throw new SeoError('Scheduler może przygotowywać wyłącznie szkice.',403);
   if(!s.enabled)return reply({skipped:true});const result=await sync(admin);
   if(s.auto_generate&&s.free_tier_confirmed&&await secret(admin,'gemini')){
    const queued=check(await admin.from('seo_documents').select('*').eq('state','queued').order('created_at').limit(1));
    if(queued?.length){try{await generate(deps,admin,queued[0],'');}catch(e){const message=e instanceof SeoError?e.message:'Nie udało się przygotować szkicu.';await admin.from('seo_documents').update({last_error:message}).eq('id',queued[0].id);return reply({...result,generation_error:message});}}
   }return reply(result);
  }
  if(action==='list'){
   const docs=check(await admin.from('seo_documents').select('*').order('created_at',{ascending:false}).limit(1000));
   const [gemini,clientSecret,search,business,github]=await Promise.all([secret(admin,'gemini'),secret(admin,'google_client_secret'),secret(admin,'search_refresh'),secret(admin,'business_refresh'),rpc(admin,'admin_travel_guide_github_token')]);
   const client=credentials(s,clientSecret,deps.env);
   return reply({documents:docs,settings:{enabled:s.enabled,auto_generate:s.auto_generate,free_tier_confirmed:s.free_tier_confirmed,daily_limit:s.daily_limit,used_today:s.ai_day===new Date().toISOString().slice(0,10)?s.ai_count:0,google_client_id:s.google_client_id,business_target:s.business_target},connections:{gemini:!!gemini,github:!!github,google_credentials:!!client.id&&!!client.secret,search:!!search,business:!!business,callback:CALLBACK}});
  }
  if(action==='configure'){
   const updates:any={updated_at:new Date().toISOString()};
   for(const k of ['enabled','auto_generate','free_tier_confirmed'])if(typeof body[k]==='boolean')updates[k]=body[k];
   if(body.daily_limit!==undefined){if(!Number.isInteger(body.daily_limit)||body.daily_limit<1||body.daily_limit>10)throw new SeoError('Limit dzienny musi wynosić od 1 do 10.');updates.daily_limit=body.daily_limit;}
   if(body.google_client_id){if(typeof body.google_client_id!=='string'||!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(body.google_client_id.trim()))throw new SeoError('Nieprawidłowy Google OAuth Client ID.');updates.google_client_id=body.google_client_id.trim();}
   if(body.business_target!==undefined){if(typeof body.business_target!=='string'||body.business_target!==''&&!/^accounts\/\d+\/locations\/\d+$/.test(body.business_target))throw new SeoError('Nieprawidłowa wizytówka Google.');updates.business_target=body.business_target;}
   const secretsToSave:any[]=[];for(const [field,name] of [['gemini_key','gemini'],['google_client_secret','google_client_secret']])if(body[field]){const v=body[field];if(typeof v!=='string'||v.trim().length<15||v.length>8192||/[\s\u0000]/.test(v.trim()))throw new SeoError('Nieprawidłowy klucz połączenia.');secretsToSave.push([name,v.trim()]);}
   for(const [name,value] of secretsToSave)await secret(admin,name,value);
   check(await admin.from('seo_settings').update(updates).eq('id',1));return reply({saved:true});
  }
  if(action==='google_connect'){
   if(!['search','business'].includes(body.provider))throw new SeoError('Nieznane połączenie Google.');
   const client=credentials(s,await secret(admin,'google_client_secret'),deps.env);
   return reply({url:await oauthStart(deps.fetch,admin,user.id,body.provider as Provider,client)});
  }
  if(action==='business_targets'){
   const access=await googleAccess(deps.fetch,await secret(admin,'business_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));return reply({targets:await businessTargets(googleApi(deps.fetch,access))});
  }
  if(!s.enabled)throw new SeoError('Moduł SEO jest wyłączony. Włącz go w ustawieniach.',409);
  if(action==='sync')return reply(await sync(admin));
  const doc=await document(admin,body.id);
  if(action==='history'){return reply({revisions:check(await admin.from('seo_revisions').select('id,revision,note,created_at').eq('document_id',doc.id).order('revision',{ascending:false}).limit(100))});}
  if(!Number.isInteger(body.revision)||body.revision!==doc.revision)throw new SeoError('Odśwież stronę: dostępna jest nowsza wersja tekstu.',409);
  const note=typeof body.note==='string'?body.note.trim().slice(0,2000):doc.review_note;
  if(action==='save')return reply({document:await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:validatePair(body.content,doc.published?.content),p_note:note})});
  if(action==='restore'){
   if(typeof body.history_id!=='string'||!UUID.test(body.history_id))throw new SeoError('Nieprawidłowa wersja historyczna.');
   const old=check(await admin.from('seo_revisions').select('content').eq('document_id',doc.id).eq('id',body.history_id).single());
   return reply({document:await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:validatePair(old.content,doc.published?.content),p_note:'Przywrócona treść historyczna — szkic do zatwierdzenia.'})});
  }
  if(action==='generate')return reply(await generate(deps,admin,doc,note));
  if(!['publish','verify','submit','inspect','business_publish','business_check'].includes(action))throw new SeoError('Nieznana akcja SEO.');
  if(action==='business_publish'&&(doc.state!=='published'||doc.published?.revision!==doc.revision))throw new SeoError('Najpierw opublikuj poprawione strony PL i EN. Wpis Google musi dotyczyć zatwierdzonej publicznej wersji.',409);
  if(['publish','business_publish'].includes(action)&&body.approved!==true)throw new SeoError('Sprawdź treść i zaznacz potwierdzenie przed publikacją.');
  const lock=await rpc(admin,'admin_seo_claim',{p_id:doc.id,p_revision:doc.revision});let google={...doc.google};
  const patch=async(values:any)=>check(await admin.from('seo_documents').update({...values,updated_at:new Date().toISOString()}).eq('id',doc.id).eq('lock_token',lock.lock_token));
  try{
   if(action==='publish'){
    const pair=validatePair(doc.content,doc.published?.content);const token=await rpc(admin,'admin_travel_guide_github_token');if(!token)throw new SeoError('Połącz GitHub w Autoprzewodnikach. Obecnego tokenu nie trzeba zmieniać.',409);
    const published=await publishPair(deps.fetch,token,doc,pair);
    check(await admin.from('seo_revisions').upsert({document_id:doc.id,revision:doc.revision,content:pair,note:note||'Opublikowana wersja'},{onConflict:'document_id,revision',ignoreDuplicates:true}));
    google={...google,search:{state:'pending',note:'Oczekiwanie na dostępność nowej wersji strony.'}};
    await patch({published,state:'published',google,last_error:''});doc.published=published;
    // A deployment may take time. Never describe a Git commit as a finished Google publication.
    const verification=await verifyPublic(deps.fetch,published);google.verification=verification;
    if(verification.ready){try{const access=await googleAccess(deps.fetch,await secret(admin,'search_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));google.search=await submitSitemap(googleApi(deps.fetch,access));}catch(e){google.search={state:'pending',note:e instanceof SeoError?e.message:'Zgłoszenie Google oczekuje na ponowienie.'};}}
    await patch({google});return reply({published,google,warnings:warnings(pair)});
   }
   if(!doc.published)throw new SeoError('Najpierw opublikuj strony PL i EN.');
   const verification=await verifyPublic(deps.fetch,doc.published);google.verification=verification;await patch({google});
   if(action==='verify')return reply({google});
   if(!verification.ready)throw new SeoError('Nowa wersja nie jest jeszcze dostępna na stronie. Poczekaj na wdrożenie i ponów sprawdzenie.',409);
   if(action==='submit'||action==='inspect'){
    const access=await googleAccess(deps.fetch,await secret(admin,'search_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));const api=googleApi(deps.fetch,access);
    if(action==='submit')google.search=await submitSitemap(api);else google.inspection=await inspectPair(api,doc.published.content);
    await patch({google});return reply({google});
   }
   if(action==='business_publish'||action==='business_check'){
    const access=await googleAccess(deps.fetch,await secret(admin,'business_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));const api=googleApi(deps.fetch,access);
    const target=s.business_target;if(!/^accounts\/\d+\/locations\/\d+$/.test(target))throw new SeoError('Wybierz wizytówkę Ride24 w ustawieniach SEO.');
    const posts=await existingPosts(api,target);const result=google.business?.revision===doc.published.revision&&google.business?.target===target?{...google.business}:{revision:doc.published.revision,target,posts:{},state:'pending'};
    for(const lang of LANGS){
     if(result.posts[lang]?.name){const live=posts.find((p:any)=>p.name===result.posts[lang].name);if(live)result.posts[lang].state=live.state||'UNKNOWN';continue;}
     if(action==='business_check')continue;
     const matched=posts.find((p:any)=>p.summary===postSummary(doc.published.content,lang)&&p.callToAction?.url===SITE+doc.published.content[lang].slug&&p.languageCode===lang);
     if(matched){result.posts[lang]={name:matched.name,state:matched.state||'UNKNOWN'};google.business=result;await patch({google});continue;}
     if(result.uncertain===lang)throw new SeoError('Poprzednia wysyłka do Google nie ma potwierdzenia. Sprawdź wizytówkę; system nie wysłał duplikatu.',409);
     result.uncertain=lang;google.business=result;await patch({google});
     let post:any;try{post=await createPost(api,target,doc.published.content,lang);}catch(e){result.state='needs_check';google.business=result;await patch({google});throw e;}
     if(!post?.name)throw new SeoError('Google nie potwierdził wpisu. Sprawdź wizytówkę przed kolejną próbą.',502);
     result.posts[lang]={name:post.name,state:post.state||'PROCESSING'};delete result.uncertain;google.business=result;await patch({google});
    }
    const states=Object.values(result.posts).map((p:any)=>p.state);result.state=states.includes('REJECTED')?'needs_correction':states.length===2&&states.every(s=>s==='LIVE')?'live':'processing';google.business=result;await patch({google});return reply({google});
   }
  }catch(e){await patch({last_error:e instanceof SeoError?e.message:'Operacja przerwana. Ponów tę samą wersję po sprawdzeniu statusu.'});throw e;}
  finally{await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',lock.lock_token);}
  return reply({error:'Nieznana akcja.'},400);
 }catch(e){if(e instanceof SeoError)return reply({error:e.message},e.status);const msg=e instanceof Error?e.message:'';return reply({error:msg==='AUTH_REQUIRED'?'Zaloguj się ponownie.':msg==='ADMIN_REQUIRED'?'Brak uprawnień administratora.':'Operacja SEO nie została zakończona. Odśwież status i spróbuj ponownie.'},msg==='AUTH_REQUIRED'?401:msg==='ADMIN_REQUIRED'?403:500);}
};}
