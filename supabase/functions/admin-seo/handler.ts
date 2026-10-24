import {SeoError,validatePair,warnings,buildTopics,makePrompt,ensureSeoBenefits,hash,LANGS,SITE,type Pair} from './core.ts';
import {publishPair,verifyPublic} from './github.ts';
import {CALLBACK,credentials,googleAccess,googleApi,submitSitemap,inspectPair,businessTargets,existingPosts,createPost,postSummary,oauthStart,type Provider} from './google.ts';
import {reviewDocument,dueReview,correctionAllowed,correctionChanged} from './review.ts';
type Deps={fetch:typeof fetch;authorize:(req:Request)=>Promise<{admin:any;user:any}>;service:()=>any;env:(name:string)=>string|undefined};
const origins=new Set(['https://ride24.pl','https://www.ride24.pl','http://localhost:8080','http://127.0.0.1:8080','http://localhost:5500','http://127.0.0.1:5500']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function rpc(admin:any,name:string,args:any={}){const r=await admin.rpc(name,args);if(r.error){if(/SEO_BUSY/.test(r.error.message))throw new SeoError('Ta wersja jest już przetwarzana lub została zmieniona. Odśwież listę.',409);if(/SEO_CONFLICT/.test(r.error.message))throw new SeoError('Ktoś zapisał nowszą wersję. Odśwież listę, aby zachować zmiany.',409);throw new SeoError('Nie udało się zapisać danych SEO. Spróbuj ponownie.',502);}return r.data;}
async function secret(admin:any,name:string,value?:string){return rpc(admin,'admin_seo_secret',{p_name:name,...(value===undefined?{}:{p_value:value})});}
async function settings(admin:any){const r=await admin.from('seo_settings').select('*').eq('id',1).single();if(r.error||!r.data)throw new SeoError('Moduł SEO nie jest dostępny.',503);return r.data;}
async function document(admin:any,id:any){if(typeof id!=='string'||!UUID.test(id))throw new SeoError('Nieprawidłowy identyfikator SEO.');const r=await admin.from('seo_documents').select('*').eq('id',id).single();if(r.error||!r.data)throw new SeoError('Nie znaleziono strony SEO.',404);return r.data;}
function check(r:any){if(r.error)throw new SeoError('Nie udało się zapisać danych SEO.',502);return r.data;}
async function safeBody(req:Request){if(!req.headers.get('content-type')?.startsWith('application/json'))throw new SeoError('Wymagany formularz JSON.',415);const reader=req.body?.getReader();if(!reader)throw new SeoError('Brak danych.');let n=0;const chunks=[];for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>180000){await reader.cancel();throw new SeoError('Formularz jest zbyt duży.',413);}chunks.push(value);}const bytes=new Uint8Array(n);let i=0;for(const chunk of chunks){bytes.set(chunk,i);i+=chunk.length;}try{const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!v||typeof v!=='object'||Array.isArray(v))throw new Error();return v;}catch{throw new SeoError('Nieprawidłowy formularz JSON.');}}
async function autoBusinessPosts(deps:Deps,admin:any,cfg:any,published:any,revision:number,google:any,patch:(values:any)=>Promise<void>){
 if(cfg.auto_business_post!==true||!cfg.business_target)return;
 if(google.business?.revision===revision&&google.business?.target===cfg.business_target&&
    (google.business?.state==='needs_check'||['pl','en'].every(l=>google.business?.posts?.[l]?.name)))return;
 const pair=published.content;
 try{
  const refresh=await secret(admin,'business_refresh');
  if(!refresh)throw new SeoError('Połącz wizytówkę Google w ustawieniach.',409);
  const access=await googleAccess(deps.fetch,refresh,credentials(cfg,await secret(admin,'google_client_secret'),deps.env));
  const api=googleApi(deps.fetch,access,12000),current=await existingPosts(api,cfg.business_target);
  const result:any={revision,target:cfg.business_target,posts:{},state:'pending'};
  for(const lang of LANGS){
   const prior=current.find((p:any)=>p.summary===postSummary(pair,lang)&&p.callToAction?.url===SITE+pair[lang].slug&&p.languageCode===lang);
   if(prior?.name){result.posts[lang]={name:prior.name,state:prior.state||'UNKNOWN'};continue;}
   result.uncertain=lang;google.business=result;await patch({google});
   const sent=await createPost(api,cfg.business_target,pair,lang);
   if(!sent?.name)throw new SeoError('Google nie potwierdził publikacji; sprawdź wizytówkę.',502);
   result.posts[lang]={name:sent.name,state:sent.state||'PROCESSING'};
   delete result.uncertain;google.business=result;await patch({google});
  }
  const states=Object.values(result.posts).map((p:any)=>p.state);
  result.state=states.includes('REJECTED')?'needs_correction':states.length===2&&states.every(s=>s==='LIVE')?'live':'processing';
  result.checked_at=new Date().toISOString();google.business=result;
 }catch(e){
  google.business={...(google.business||{}),revision,target:cfg.business_target,
   state:'needs_check',note:e instanceof SeoError?e.message:'Automatycznej publikacji nie potwierdzono. Sprawdź połączenie; nie wysyłaj duplikatu.'};
 }
}
// Free Search Console Search Analytics. Store one snapshot per day; no Ads or paid APIs.
async function searchPerformance(deps:Deps,admin:any,cfg:any){
 const today=new Date(),finish=new Date(today.getTime()-3*86400000),start=new Date(finish.getTime()-27*86400000);
 const date=(d:Date)=>d.toISOString().slice(0,10);
 const client=credentials(cfg,await secret(admin,'google_client_secret'),deps.env);
 const access=await googleAccess(deps.fetch,await secret(admin,'search_refresh'),client,10000);
 const api=googleApi(deps.fetch,access,12000);
 const url='https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent('sc-domain:ride24.pl')+'/searchAnalytics/query';
 const range={startDate:date(start),endDate:date(finish),type:'web'};
 const [all,pageResult,queryResult]=await Promise.all([
   api(url,'POST',{...range,rowLimit:1}),
   api(url,'POST',{...range,dimensions:['page'],rowLimit:250}),
   api(url,'POST',{...range,dimensions:['query'],rowLimit:100})
 ]);
 const zero={clicks:0,impressions:0,ctr:0,position:0};
 const row=(all.rows||[])[0]||zero;
 const pages=(pageResult.rows||[]).filter((p:any)=>String(p.keys?.[0]||'').startsWith('https://ride24.pl/seo/'));
 const items=pages.map((p:any)=>({url:p.keys[0],clicks:p.clicks,impressions:p.impressions,ctr:p.ctr,position:p.position}));
 const snapshot={checked_at:new Date().toISOString(),start_date:range.startDate,end_date:range.endDate,
  totals:{clicks:row.clicks||0,impressions:row.impressions||0,ctr:row.ctr||0,position:row.position||0},
  seo_pages:items.length,
  top_pages:items.sort((a:any,b:any)=>b.clicks-a.clicks).slice(0,12),
  opportunities:items.filter((p:any)=>p.impressions>=10&&p.ctr<0.03&&p.position<=20).sort((a:any,b:any)=>b.impressions-a.impressions).slice(0,12),
  top_queries:(queryResult.rows||[]).slice(0,12).map((p:any)=>({query:p.keys?.[0],clicks:p.clicks,impressions:p.impressions,position:p.position}))};
 check(await admin.from('seo_settings').update({search_performance:snapshot}).eq('id',1));
 return {performance:snapshot};
}
async function getTopics(admin:any){
 const results=await Promise.all([
  admin.from('partner_locations').select('id,partner_id,country,region,city,location_name,type,active,extra_fee,extra_fee_amount,contact_required,partners!inner(active,account_status,api_enabled)').eq('active',true).limit(2000),
  admin.from('car_classes').select('partner_id,active,deposit_amount,features').eq('active',true).limit(5000),
  admin.from('locations_dictionary').select('name_en,name_pl').limit(3000)
 ]);
 if(results.some(r=>r.error))throw new SeoError('Nie udało się pobrać lokalizacji dla SEO.',502);
 // Keep Nusa Penida out of SEO discovery without affecting car-rental locations or travel guides.
 return buildTopics(results[0].data||[],results[1].data||[],results[2].data||[]).filter(t=>t.topic_key!=='city|indonesia|nusa penida');
}
async function sync(admin:any,currentTopics?:any[]){
 const topics=currentTopics??await getTopics(admin);const before=check(await admin.from('seo_documents').select('id,topic_key,source').limit(1000))||[];const known=new Map(before.map((d:any)=>[d.topic_key,d]));
 const missing=topics.filter(t=>!known.has(t.topic_key));
 if(missing.length)check(await admin.from('seo_documents').upsert(missing,{onConflict:'topic_key',ignoreDuplicates:true}));
 for(const t of topics){const d:any=known.get(t.topic_key);if(d&&JSON.stringify(d.source)!==JSON.stringify(t.source))check(await admin.from('seo_documents').update({source:t.source}).eq('id',d.id));}
 return {added:missing.length,active:topics.length};
}
async function generate(deps:Deps,admin:any,doc:any,note:string,heldClaim?:any,acceptCorrection?:(pair:Pair)=>boolean){
 const key=await secret(admin,'gemini');if(!key)throw new SeoError('Dodaj klucz Gemini z darmowego projektu w ustawieniach SEO.',409);
 const topics=await getTopics(admin);const live=topics.find(t=>t.topic_key===doc.topic_key);
 if(!live)throw new SeoError('Ten kierunek nie ma obecnie aktywnych lokalizacji z ofertami. Możesz poprawić tekst ręcznie, bez wymyślania dostępności.',409);
 const claimed=heldClaim??await rpc(admin,'admin_seo_claim',{p_id:doc.id,p_revision:doc.revision});
 try{
  if(!await rpc(admin,'admin_seo_ai_slot'))throw new SeoError('Darmowy limit dzienny został wykorzystany lub nie potwierdzono poziomu Free. Tekst możesz edytować ręcznie.',429);
  const r=await deps.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts:[{text:makePrompt(live.source,doc.content,note)+'\nNie wskazuj konkretnego miejsca odbioru w terminalu, strefie obsługi podróżnych ani parkingu: źródło podaje nazwę lokalizacji, nie dokładny punkt spotkania. Nie twierdź, że w wybranej lokalizacji działa wielu partnerów. Pisz neutralnie o dostępnych ofertach i konieczności sprawdzenia instrukcji odbioru. Nie opisuj wielkości lotniska ani liczby podróżnych bez danych źródłowych.'}]}],generationConfig:{responseMimeType:'application/json',temperature:0.5,maxOutputTokens:10000,thinkingConfig:{thinkingLevel:'minimal'}}})});
  if(!r.ok){
   if(r.status===503||r.status===500)throw new SeoError('Google chwilowo nie może wygenerować tekstu (przeciążenie modelu). Klucz i poprzedni szkic pozostają zapisane. Spróbuj później.',503);
   if(r.status===429)throw new SeoError('Gemini osiągnął limit bezpłatnej usługi. Spróbuj później; nie uruchomiono płatnego zastępstwa.',429);
   if(r.status===401||r.status===403)throw new SeoError('Google odmówił dostępu do generowania. Sprawdź uprawnienia klucza oraz poziom Free projektu.',502);
   if(r.status===404)throw new SeoError('Google nie udostępnia wybranego modelu. Szkic zachowano; moduł wymaga aktualizacji modelu.',502);
   throw new SeoError('Google nie przyjął żądania generowania. Szkic zachowano; wymagane sprawdzenie konfiguracji modułu.',502);
  }
  const json=await r.json();let value:any;try{const text=json.candidates?.[0]?.content?.parts?.filter((p:any)=>typeof p.text==='string'&&!p.thought).map((p:any)=>p.text).join('');if(!text||text.length>130000)throw new Error();value=JSON.parse(text);}catch{throw new SeoError('AI nie zwróciło kompletnego tekstu PL/EN. Poprzednia wersja pozostaje dostępna.',502);}
  for(const lang of LANGS)for(const field of ['intro_text','main_content'])if(typeof value?.[lang]?.[field]==='string')value[lang][field]=value[lang][field].replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n');
  const pair=validatePair(value,doc.published?.content||null);
  // AI never chooses paths: existing paths remain stable, new paths come from deterministic source data.
  for(const lang of LANGS)pair[lang].slug=doc.content?.[lang]?.slug||live.source.slugs[lang];
   ensureSeoBenefits(pair,live.source); // Never turn unverified partner terms into a guarantee.
  if(acceptCorrection&&!acceptCorrection(pair))throw new SeoError('AI nie przygotowało zmiany rozwiązującej wykryty problem. Zachowano publiczną wersję; sprawdź tekst ręcznie.',502);
  const saved=await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:pair,p_note:note,p_lock:claimed.lock_token});
  return {document:saved,warnings:warnings(pair)};
 }finally{if(!heldClaim)await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',claimed.lock_token);}
}
async function runReview(deps:Deps,admin:any,cfg:any,id?:string){
 const docs=check(await admin.from('seo_documents').select('*').eq('state','published').limit(1000))||[];
 const next=id?await document(admin,id):docs.filter((d:any)=>dueReview(d)).sort((a:any,b:any)=>Date.parse(a.google?.review?.checked_at||'1970-01-01')-Date.parse(b.google?.review?.checked_at||'1970-01-01'))[0];
 if(!next)return {checked:0,reason:'no_due_pages'};
 try{return await reviewDocument({...deps,secret,rpc},admin,next,cfg,docs);}catch(e){if(e instanceof SeoError&&e.status===409&&!id)return {checked:0,reason:'busy_or_draft'};throw e;}
}
async function scheduledReviews(deps:Deps,admin:any,cfg:any){
 const docs=check(await admin.from('seo_documents').select('*').eq('state','published').limit(1000))||[];
 const due=docs.filter((d:any)=>dueReview(d)).sort((a:any,b:any)=>Date.parse(a.google?.review?.checked_at||'1970-01-01')-Date.parse(b.google?.review?.checked_at||'1970-01-01')).slice(0,2);
 const results=await Promise.all(due.map(async(doc:any)=>{try{const {document:_,...status}=await reviewDocument({...deps,secret,rpc},admin,doc,cfg,docs);return status;}catch(e){return {checked:0,id:doc.id,error:e instanceof SeoError?e.message:'Nie udało się zakończyć kontroli tej strony.'};}}));
 return {checked:results.reduce((n,r)=>n+r.checked,0),results,...(!due.length?{reason:'no_due_pages'}:{})};
}
async function automaticCorrection(deps:Deps,admin:any,cfg:any,topics:any[]){
 if(!cfg.auto_review_enabled||cfg.auto_correction_day===new Date().toISOString().slice(0,10))return null;
 const docs=check(await admin.from('seo_documents').select('*').eq('state','published').limit(1000))||[];
 const candidate=docs.filter((d:any)=>correctionAllowed(d)&&(!d.lock_until||Date.parse(d.lock_until)<=Date.now())).sort((a:any,b:any)=>Date.parse(a.google.review.checked_at)-Date.parse(b.google.review.checked_at))[0];
 if(!candidate)return null;
 const ai=candidate.google.review.correction_kind==='content';
 if(ai&&!topics.some(t=>t.topic_key===candidate.topic_key)){
  const google=structuredClone(candidate.google);google.review.state='manual_attention';google.review.summary='Kierunek nie ma obecnie aktywnego źródła ofert. Sprawdź go ręcznie; automat nie wymyśla nowych warunków.';
  check(await admin.from('seo_documents').update({google}).eq('id',candidate.id).eq('revision',candidate.revision).eq('state','published').is('lock_token',null));return null;
 }
 if(ai&&(!cfg.free_tier_confirmed||!await secret(admin,'gemini')))return null;
 if(ai&&cfg.ai_day===new Date().toISOString().slice(0,10)&&cfg.ai_count>=cfg.daily_limit){
  const google=structuredClone(candidate.google);google.review.state='quota_paused';google.review.summary='Poprawka oczekuje na wolny dzienny limit AI. Publiczna treść pozostaje dostępna.';
  check(await admin.from('seo_documents').update({google}).eq('id',candidate.id).eq('revision',candidate.revision).eq('state','published').is('lock_token',null));return null;
 }
 let doc:any;
 try{doc=await rpc(admin,'admin_seo_claim',{p_id:candidate.id,p_revision:candidate.revision});}catch(e){if(e instanceof SeoError&&e.status===409)return null;throw e;}
 const google=structuredClone(doc.google||{});
 try{
  if(!correctionAllowed(doc))return null;
  if(!await rpc(admin,'admin_seo_correction_slot'))return null;
  const prior=google.review.correction;google.review.correction={base_revision:doc.revision,attempts:prior?.base_revision===doc.revision?Number(prior.attempts||0)+1:1,attempted_at:new Date().toISOString(),kind:google.review.correction_kind};google.review.state='preparing_correction';
  check(await admin.from('seo_documents').update({google}).eq('id',doc.id).eq('revision',doc.revision).eq('lock_token',doc.lock_token));
  const reasons=google.review.issues.slice(0,6).map((i:any)=>i.message).join('\n');
  const note=((doc.review_note?doc.review_note.slice(0,700)+'\n\n':'')+'Automatyczna kontrola SEO — przygotuj szkic do zatwierdzenia:\n'+reasons+'\nDla odrzuconego wpisu Google zmień nagłówek i wstęp zgodnie z rzeczywistą ofertą. Nie wymyślaj powodu odrzucenia ani nowych warunków wynajmu.').slice(0,2000);
  const result=ai?await generate(deps,admin,doc,note,doc,pair=>correctionChanged(pair,doc)):{document:await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:validatePair(doc.content,doc.published.content),p_note:note,p_lock:doc.lock_token})};
  const saved=result.document,updated=structuredClone(saved.google||google);updated.review={...google.review,state:'draft_ready',summary:'Automatyczna poprawka PL/EN jest gotowa. Sprawdź obie wersje i kliknij Opublikuj.',draft_revision:saved.revision};
  const write=await admin.from('seo_documents').update({google:updated}).eq('id',doc.id).eq('revision',saved.revision).eq('state','changed').is('lock_token',null).select('id');
  if(write.error||!write.data?.length)throw new SeoError('Szkic zapisano, ale jego status wymaga odświeżenia.',409);
  return {corrected_id:doc.id,revision:saved.revision,state:'changed',correction_kind:ai?'content':'metadata'};
 }catch(e){
  google.review={...google.review,state:'correction_failed',summary:e instanceof SeoError?e.message:'Nie udało się przygotować poprawki. Publiczna treść jest zachowana.'};
  await admin.from('seo_documents').update({google}).eq('id',doc.id).eq('revision',doc.revision).eq('lock_token',doc.lock_token);
  return {correction_error:google.review.summary};
 }finally{await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',doc.lock_token);}
}
// Retry only published, administrator-approved pages. No Gemini or GitHub writes.
async function retryPendingSearch(deps:Deps,admin:any){
 const rows=check(await admin.from('seo_documents').select('id,revision,google,published').eq('state','published').contains('google',{search:{state:'pending'}}).order('updated_at',{ascending:true}).limit(50))||[];
 const now=Date.now();
 const candidate=rows.find((d:any)=>d.published?.revision===d.revision&&(!d.google?.search?.next_retry_at||Date.parse(d.google.search.next_retry_at)<=now));
 if(!candidate)return {checked:0,reason:'no_due_pages'};
 let doc:any;
 try{doc=await rpc(admin,'admin_seo_claim',{p_id:candidate.id,p_revision:candidate.revision});}
 catch(e){if(e instanceof SeoError&&e.status===409)return {checked:0,reason:'busy'};throw e;}
 try{
  if(doc.state!=='published'||doc.published?.revision!==doc.revision||doc.google?.search?.state!=='pending')return {checked:0,reason:'already_updated'};
  const google:any={...(doc.google||{})};
  const patch=async(values:any)=>{
   const r=await admin.from('seo_documents').update({...values,updated_at:new Date().toISOString()}).eq('id',doc.id).eq('revision',doc.revision).eq('lock_token',doc.lock_token).select('id');
   if(r.error||!r.data?.length)throw new SeoError('Nie udało się zapisać statusu SEO.',502);
  };
  const attempts=Math.max(0,Number(google.search?.attempts)||0)+1;
  const retryAt=new Date(now+Math.min(8,2**Math.min(attempts-1,3))*3600000).toISOString();
  if(!google.verification?.ready){
   google.verification=await verifyPublic(deps.fetch,doc.published);
   if(google.verification.ready){
    google.search={state:'pending',note:'Wersje PL i EN dostępne. Automatyczne zgłoszenie do Google nastąpi w następnym cyklu.',attempts:0};
    await patch({google,last_error:''});return {checked:1,result:'ready_for_google'};
   }
   const stop=attempts>=6;
   google.search={state:stop?'needs_attention':'pending',note:stop?'Strony nie są dostępne po kilku próbach. Sprawdź wdrożenie.':'Oczekiwanie na wdrożenie PL i EN. Sprawdzę ponownie.',attempts,...(stop?{}:{next_retry_at:retryAt})};
   await patch({google});return {checked:1,result:stop?'needs_attention':'waiting_for_site'};
  }
  try{
   const cfg=await settings(admin);
   const access=await googleAccess(deps.fetch,await secret(admin,'search_refresh'),credentials(cfg,await secret(admin,'google_client_secret'),deps.env));
   google.search=await submitSitemap(googleApi(deps.fetch,access));
   await autoBusinessPosts(deps,admin,cfg,doc.published,doc.revision,google,patch);
   await patch({google,last_error:''});return {checked:1,result:'submitted'};
  }catch(e){
   const error=e instanceof SeoError?e.message:'Google nie przyjął zgłoszenia mapy.';
   const stop=attempts>=5;
   google.search={state:stop?'needs_attention':'pending',note:(stop?'Wymaga ręcznej kontroli Search Console: ':'Ponowienie zgłoszenia zaplanowane: ')+error,attempts,...(stop?{}:{next_retry_at:retryAt})};
   await patch({google,last_error:error});return {checked:1,result:stop?'needs_attention':'retry_scheduled'};
  }
 }finally{
  await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',doc.lock_token);
 }
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
   if(action==='performance'){if(!s.enabled)return reply({skipped:true});return reply(await searchPerformance(deps,admin,s));}
   if(action==='recheck'){if(!s.enabled)return reply({skipped:true});return reply(await retryPendingSearch(deps,admin));}
   if(action==='review'){if(!s.enabled||!s.auto_review_enabled)return reply({checked:0,reason:'review_disabled'});if(!body.document_id)return reply(await scheduledReviews(deps,admin,s));const result=await runReview(deps,admin,s,body.document_id);if('document' in result){const {document:_,...status}=result;return reply(status);}return reply(result);}
    if(action!=='cron')throw new SeoError('Scheduler może przygotowywać wyłącznie szkice.',403);
   if(!s.enabled)return reply({skipped:true});
   // Scoped maintenance may generate one explicitly selected queued draft, under the same Free quota.
   // It cannot edit existing drafts or publish anything, and does not enable automatic generation.
   if(body.draft_id){const target=await document(admin,body.draft_id);if(target.state!=='queued'||target.content!==null||target.published!==null)throw new SeoError('Przygotowanie wewnętrzne dotyczy tylko nowych, pustych szkiców.',409);const generated=await generate(deps,admin,target,'');return reply({generated_id:generated.document.id,revision:generated.document.revision,state:generated.document.state});}
   const topics=await getTopics(admin),result=await sync(admin,topics);
   const correction=await automaticCorrection(deps,admin,s,topics);if(correction)return reply({...result,...correction});
   if(!s.auto_generate)return reply({...result,generation_skipped:'automation_disabled'});
   if(!s.free_tier_confirmed)return reply({...result,generation_skipped:'free_confirmation_required'});
   if(!await secret(admin,'gemini'))return reply({...result,generation_skipped:'gemini_not_configured'});
   // Old names remain available for manual editing, but must not block current locations.
   // An unsuccessful attempt goes to the back of the queue; at most one AI call per run.
   const queued=check(await admin.from('seo_documents').select('*').eq('state','queued').is('content',null).is('published',null).order('updated_at').order('created_at').limit(1000))||[];
   const active=new Set(topics.map(t=>t.topic_key)),now=Date.now();
   const next=queued.find((d:any)=>active.has(d.topic_key)&&(!d.lock_until||Date.parse(d.lock_until)<=now));
   if(!next)return reply({...result,generation_skipped:'no_active_queued_topics'});
   if(s.ai_day===new Date().toISOString().slice(0,10)&&s.ai_count>=s.daily_limit)return reply({...result,generation_skipped:'daily_limit',next_draft_id:next.id});
   try{const generated=await generate(deps,admin,next,'');return reply({...result,generated_id:generated.document.id,revision:generated.document.revision,state:generated.document.state});}
   catch(e){const message=e instanceof SeoError?e.message:'Nie udało się przygotować szkicu.';check(await admin.from('seo_documents').update({last_error:message,updated_at:new Date().toISOString()}).eq('id',next.id).eq('state','queued').eq('revision',next.revision));return reply({...result,generation_error:message});}
  }
  if(action==='list'){
   const docs=check(await admin.from('seo_documents').select('*').order('created_at',{ascending:false}).limit(1000));
   const [gemini,clientSecret,search,business,github]=await Promise.all([secret(admin,'gemini'),secret(admin,'google_client_secret'),secret(admin,'search_refresh'),secret(admin,'business_refresh'),rpc(admin,'admin_travel_guide_github_token')]);
   const client=credentials(s,clientSecret,deps.env);
   return reply({documents:docs,settings:{enabled:s.enabled,auto_generate:s.auto_generate,auto_review_enabled:s.auto_review_enabled===true,correction_used_today:s.auto_correction_day===new Date().toISOString().slice(0,10),free_tier_confirmed:s.free_tier_confirmed,daily_limit:s.daily_limit,used_today:s.ai_day===new Date().toISOString().slice(0,10)?s.ai_count:0,google_client_id:s.google_client_id,business_target:s.business_target,auto_business_post:s.auto_business_post===true,search_performance:s.search_performance||{}},connections:{gemini:!!gemini,github:!!github,google_credentials:!!client.id&&!!client.secret,search:!!search,business:!!business,callback:CALLBACK}});
  }
  if(action==='configure'){
   const updates:any={updated_at:new Date().toISOString()};
   for(const k of ['enabled','auto_generate','auto_review_enabled','free_tier_confirmed','auto_business_post'])if(typeof body[k]==='boolean')updates[k]=body[k];
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
  if(action==='performance')return reply(await searchPerformance(deps,admin,s));
  if(action==='sync')return reply(await sync(admin));
  const doc=await document(admin,body.id);
  if(action==='history'){return reply({revisions:check(await admin.from('seo_revisions').select('id,revision,note,created_at').eq('document_id',doc.id).order('revision',{ascending:false}).limit(100))});}
  if(!Number.isInteger(body.revision)||body.revision!==doc.revision)throw new SeoError('Odśwież stronę: dostępna jest nowsza wersja tekstu.',409);
  if(action==='dismiss'||action==='restore_dismissed'){
   if(doc.published!==null)throw new SeoError('Opublikowanej strony SEO nie można usunąć z kolejki szkiców.',409);
   if(action==='dismiss'&&!['queued','draft'].includes(doc.state))throw new SeoError('Można usunąć tylko nieopublikowany szkic.',409);
   if(action==='restore_dismissed'&&doc.state!=='dismissed')throw new SeoError('Ta propozycja nie jest usunięta.',409);
   const state=action==='dismiss'?'dismissed':doc.content?'draft':'queued';
   const result=await admin.from('seo_documents')
    .update({state,revision:doc.revision+1,last_error:'',updated_at:new Date().toISOString()})
    .eq('id',doc.id).eq('revision',doc.revision).eq('state',doc.state)
    .is('published',null).is('lock_token',null).select('*').maybeSingle();
   if(result.error)throw new SeoError('Nie udało się zmienić statusu propozycji SEO.',502);
   if(!result.data)throw new SeoError('Szkic jest przetwarzany lub został zmieniony. Odśwież panel.',409);
   return reply({document:result.data});
  }
  if(doc.state==='dismissed')throw new SeoError('Ten szkic został usunięty z kolejki. Przywróć go przed edycją.',409);
  const note=typeof body.note==='string'?body.note.trim().slice(0,2000):doc.review_note;
  if(action==='save')return reply({document:await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:validatePair(body.content,doc.published?.content),p_note:note})});
  if(action==='restore'){
   if(typeof body.history_id!=='string'||!UUID.test(body.history_id))throw new SeoError('Nieprawidłowa wersja historyczna.');
   const old=check(await admin.from('seo_revisions').select('content').eq('document_id',doc.id).eq('id',body.history_id).single());
   return reply({document:await rpc(admin,'admin_seo_save',{p_id:doc.id,p_revision:doc.revision,p_content:validatePair(old.content,doc.published?.content),p_note:'Przywrócona treść historyczna — szkic do zatwierdzenia.'})});
  }
  if(action==='generate')return reply(await generate(deps,admin,doc,note));
  if(action==='review')return reply(await runReview(deps,admin,s,doc.id));
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
    if(google.review)google.review={...google.review,state:'awaiting_check',summary:'Nowa wersja oczekuje na ponowną kontrolę Google.',revision:doc.revision,correction_kind:null,issues:[],errors:[],next_check_at:'1970-01-01T00:00:00Z'};
    await patch({published,state:'published',google,last_error:''});doc.published=published;
    // A deployment may take time. Never describe a Git commit as a finished Google publication.
    const verification=await verifyPublic(deps.fetch,published);google.verification=verification;
    if(verification.ready){try{const access=await googleAccess(deps.fetch,await secret(admin,'search_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));google.search=await submitSitemap(googleApi(deps.fetch,access));}catch(e){google.search={state:'pending',note:e instanceof SeoError?e.message:'Zgłoszenie Google oczekuje na ponowienie.'};}}
    if(verification.ready)await autoBusinessPosts(deps,admin,s,published,doc.revision,google,patch);
    await patch({google});return reply({published,google,warnings:warnings(pair)});
   }
   if(!doc.published)throw new SeoError('Najpierw opublikuj strony PL i EN.');
   const verification=await verifyPublic(deps.fetch,doc.published);google.verification=verification;await patch({google,last_error:''});
   if(action==='verify')return reply({google});
   if(!verification.ready)throw new SeoError('Nowa wersja nie jest jeszcze dostępna na stronie. Poczekaj na wdrożenie i ponów sprawdzenie.',409);
   if(action==='submit'||action==='inspect'){
    const access=await googleAccess(deps.fetch,await secret(admin,'search_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));const api=googleApi(deps.fetch,access);
    if(action==='submit')google.search=await submitSitemap(api);else google.inspection=await inspectPair(api,doc.published.content);
    await patch({google,last_error:''});return reply({google});
   }
   if(action==='business_publish'||action==='business_check'){
    const access=await googleAccess(deps.fetch,await secret(admin,'business_refresh'),credentials(s,await secret(admin,'google_client_secret'),deps.env));const api=googleApi(deps.fetch,access);
    const target=s.business_target;if(!/^accounts\/\d+\/locations\/\d+$/.test(target))throw new SeoError('Wybierz wizytówkę Ride24 w ustawieniach SEO.');
    const posts=await existingPosts(api,target);const result=google.business?.revision===doc.published.revision&&google.business?.target===target?{...google.business}:{revision:doc.published.revision,target,posts:{},state:'pending'};
    for(const lang of LANGS){
     if(result.posts[lang]?.name){const live=posts.find((p:any)=>p.name===result.posts[lang].name);if(live)result.posts[lang].state=live.state||'UNKNOWN';continue;}
     const matched=posts.find((p:any)=>p.summary===postSummary(doc.published.content,lang)&&p.callToAction?.url===SITE+doc.published.content[lang].slug&&p.languageCode===lang);
     if(matched){result.posts[lang]={name:matched.name,state:matched.state||'UNKNOWN'};google.business=result;await patch({google});continue;}
     if(action==='business_check')continue;
     if(result.uncertain===lang)throw new SeoError('Poprzednia wysyłka do Google nie ma potwierdzenia. Sprawdź wizytówkę; system nie wysłał duplikatu.',409);
     result.uncertain=lang;google.business=result;await patch({google});
     let post:any;try{post=await createPost(api,target,doc.published.content,lang);}catch(e){result.state='needs_check';google.business=result;await patch({google});throw e;}
     if(!post?.name)throw new SeoError('Google nie potwierdził wpisu. Sprawdź wizytówkę przed kolejną próbą.',502);
     result.posts[lang]={name:post.name,state:post.state||'PROCESSING'};delete result.uncertain;google.business=result;await patch({google});
    }
    const states=Object.values(result.posts).map((p:any)=>p.state);result.state=states.includes('REJECTED')?'needs_correction':states.length===2&&states.every(s=>s==='LIVE')?'live':states.length?'processing':'not_published';result.checked_at=new Date().toISOString();google.business=result;await patch({google,last_error:''});return reply({google});
   }
  }catch(e){await patch({last_error:e instanceof SeoError?e.message:'Operacja przerwana. Ponów tę samą wersję po sprawdzeniu statusu.'});throw e;}
  finally{await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',lock.lock_token);}
  return reply({error:'Nieznana akcja.'},400);
 }catch(e){if(e instanceof SeoError)return reply({error:e.message},e.status);const msg=e instanceof Error?e.message:'';return reply({error:msg==='AUTH_REQUIRED'?'Zaloguj się ponownie.':msg==='ADMIN_REQUIRED'?'Brak uprawnień administratora.':'Operacja SEO nie została zakończona. Odśwież status i spróbuj ponownie.'},msg==='AUTH_REQUIRED'?401:msg==='ADMIN_REQUIRED'?403:500);}
};}
