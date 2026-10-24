import {SeoError,LANGS,SITE,validPath,normal,esc,hash,type Lang,type Pair} from './core.ts';
import {credentials,googleAccess,googleApi,inspectPair,existingPosts,postSummary} from './google.ts';

type Issue={code:string;message:string;lang?:Lang};
type Deps={fetch:typeof fetch;env:(name:string)=>string|undefined;secret:(admin:any,name:string)=>Promise<any>;rpc:(admin:any,name:string,args?:any)=>Promise<any>};
const DAY=86400000;
export function dueReview(doc:any,now=Date.now()){
 return doc.state==='published'&&doc.published?.revision===doc.revision&&(!doc.lock_until||Date.parse(doc.lock_until)<=now)&&(!doc.google?.review?.next_check_at||Date.parse(doc.google.review.next_check_at)<=now);
}
function decode(value:string){return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#34);/g,s=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&#39;':"'",'&#34;':'"','&lt;':'<','&gt;':'>'}[s]||s));}
function attrs(tag:string){const out:Record<string,string>={};for(const m of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))out[m[1].toLowerCase()]=decode(m[2]??m[3]??m[4]??'');return out;}
function cleanPath(url:string){try{const u=new URL(url,SITE);return u.origin===SITE?u.origin+u.pathname.replace(/\.html$/,'').replace(/\/$/,''):'';}catch{return '';}}
export function inspectHtml(lang:Lang,published:any,html:string,robotsHeader=''){
 const page=published.content[lang],url=SITE+page.slug,issues:Issue[]=[];
 const document=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
 const root=attrs(document.match(/<html\b[^>]*>/i)?.[0]||'');
 const marker=attrs(document.match(/<body\b[^>]*>/i)?.[0]||'')['data-ride24-seo-revision'];
 const identity=published.marker?marker===published.marker:document.includes(esc(page.h1))||document.includes(page.h1);
 if(root.lang!==lang||!identity)return {lang,url,ready:false,issues:[{lang,code:'stale_or_wrong_page',message:'Publiczna strona nie odpowiada zatwierdzonej wersji '+lang.toUpperCase()+'.'}]};
 const head=document.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1]||'';
 const metas=[...head.matchAll(/<meta\b[^>]*>/gi)].map(m=>attrs(m[0]));
 const links=[...head.matchAll(/<link\b[^>]*>/gi)].map(m=>attrs(m[0]));
 const add=(code:string,message:string)=>issues.push({lang,code,message});
 if(!head.match(/<title\b[^>]*>\s*[^<\s][\s\S]*?<\/title>/i))add('missing_title','Brak tytułu strony '+lang.toUpperCase()+'.');
 if(!metas.some(m=>m.name?.toLowerCase()==='description'&&m.content?.trim()))add('missing_description','Brak opisu strony '+lang.toUpperCase()+'.');
 if(!links.some(l=>l.rel?.split(/\s+/).includes('canonical')&&cleanPath(l.href)===url))add('wrong_canonical','Brak poprawnego adresu kanonicznego '+lang.toUpperCase()+'.');
 for(const other of LANGS)if(!links.some(l=>l.rel==='alternate'&&l.hreflang===other&&cleanPath(l.href)===SITE+published.content[other].slug))add('missing_hreflang','Brak poprawnego powiązania wersji '+lang.toUpperCase()+' z '+other.toUpperCase()+'.');
 const metaRobots=metas.filter(m=>['robots','googlebot'].includes(m.name?.toLowerCase())).map(m=>m.content).join(',');
 if(/\b(noindex|none)\b/i.test(metaRobots))add('noindex','Strona '+lang.toUpperCase()+' zawiera blokadę indeksowania w metadanych.');
 if(/\b(noindex|none)\b/i.test(robotsHeader))add('header_noindex','Nagłówek HTTP blokuje indeksowanie '+lang.toUpperCase()+'. Sprawdź konfigurację hostingu.');
 return {lang,url,ready:true,issues};
}
async function boundedText(response:Response,limit:number){
 if(!response.body)return '';const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error('Response too large');}chunks.push(value);}
 const buffer=new Uint8Array(size);let at=0;for(const chunk of chunks){buffer.set(chunk,at);at+=chunk.length;}return new TextDecoder().decode(buffer);
}
async function fetchSite(fetcher:typeof fetch,path:string,limit:number){
 let url=new URL(path,SITE);if(url.origin!==SITE)throw new Error('Untrusted site');
 const signal=AbortSignal.timeout(8000);
 for(let hop=0;hop<3;hop++){
  const r=await fetcher(url.href,{redirect:'manual',signal,headers:{'Cache-Control':'no-cache'}});
  if([301,302,303,307,308].includes(r.status)){const next=new URL(r.headers.get('location')||'',url);if(next.origin!==SITE||next.protocol!=='https:')throw new Error('Untrusted redirect');url=next;continue;}
  if(!r.ok)throw new Error('Unavailable page');return {text:await boundedText(r,limit),robots:r.headers.get('x-robots-tag')||''};
 }throw new Error('Redirect loop');
}
export async function inspectPublic(fetcher:typeof fetch,published:any){
 if(!published?.content||LANGS.some(lang=>!validPath(published.content[lang]?.slug)))return {ready:false,pages:[],issues:[{code:'invalid_path',message:'Nieprawidłowe adresy zapisanej strony SEO. Wymagana ręczna kontrola.'}],checked_at:new Date().toISOString()};
 const [pages,sitemap]=await Promise.all([
  Promise.all(LANGS.map(async lang=>{const url=SITE+published.content[lang].slug;try{const r=await fetchSite(fetcher,published.content[lang].slug+'?seo-check='+encodeURIComponent(published.marker||'legacy'),150000);return inspectHtml(lang,published,r.text,r.robots);}catch{return {lang,url,ready:false,issues:[{lang,code:'page_unavailable',message:'Nie udało się pobrać publicznej strony '+lang.toUpperCase()+'.'}]};}})),
  (async()=>{try{const xml=(await fetchSite(fetcher,'/sitemap.xml',2000000)).text;if(/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<urlset\b/.test(xml)||!/<\/urlset>\s*$/.test(xml))throw Error();return {available:true,ready:LANGS.every(lang=>xml.includes('<loc>'+SITE+published.content[lang].slug+'</loc>')||xml.includes('<loc>'+SITE+published.content[lang].slug+'.html</loc>'))};}catch{return {available:false,ready:false};}})()
 ]);
 const sitemapReady=sitemap.ready,sitemapAvailable=sitemap.available;
 const issues:Issue[]=pages.flatMap(p=>p.issues);if(!sitemapReady)issues.push({code:sitemapAvailable?'sitemap_missing':'sitemap_unavailable',message:sitemapAvailable?'Nie potwierdzono obu adresów w mapie witryny; ponowna publikacja odtworzy wpisy mapy.':'Nie udało się odczytać poprawnej mapy witryny. Sprawdź wdrożenie.'});
 return {ready:pages.every(p=>p.ready),pages:pages.map(p=>({lang:p.lang,url:p.url,ok:p.ready})),issues,checked_at:new Date().toISOString()};
}
export async function duplicateIssues(doc:any,documents:any[]){
 const out:Issue[]=[];
 for(const lang of LANGS){const text=normal(doc.published?.content?.[lang]?.main_content);if(text.length<500)continue;const fingerprint=await hash(text);
  for(const other of documents){if(other.id===doc.id||other.topic_key===doc.topic_key||!other.published?.content?.[lang])continue;if(await hash(normal(other.published.content[lang].main_content))===fingerprint){out.push({lang,code:'duplicate_content',message:'Treść '+lang.toUpperCase()+' jest identyczna z innym opublikowanym kierunkiem. Potrzebny jest odrębny, rzeczowy opis.'});break;}}
 }return out;
}
function safeError(error:any){return {category:error?.google_category||(error instanceof SeoError&&error.status===409?'configuration':'temporary'),message:error instanceof SeoError?error.message:'Nie udało się zakończyć kontroli połączenia Google. Sprawdzę ponownie.'};}
export function classifyReview(live:any,inspection:any,business:any,duplicates:Issue[],errors:any[]){
 const issues:Issue[]=[...live.issues,...duplicates];
 const rejected=Object.entries(business?.posts||{}).filter(([,p]:any)=>p.state==='REJECTED').map(([lang])=>lang as Lang);
 for(const lang of rejected)issues.push({lang,code:'google_post_rejected',message:'Google odrzuciło wpis '+lang.toUpperCase()+'. Przygotuj rzeczowy nagłówek i wstęp; API nie podało szczegółowego uzasadnienia.'});
 const canonicalMismatch=LANGS.some(lang=>{const actual=inspection?.results?.[lang]?.google_canonical,expected=live.pages?.find((p:any)=>p.lang===lang)?.url;return actual&&expected&&cleanPath(actual)!==cleanPath(expected);});
 let state='waiting_indexing',kind:string|null=null,summary='Google nie potwierdził jeszcze indeksowania obu wersji. Samo oczekiwanie nie wymaga zmiany tekstu.';
 if(errors.length){state=errors.some(e=>['authorization','configuration'].includes(e.category))?'connection_issue':'temporary_error';summary=errors.map(e=>(e.service==='business'?'Wizytówka Google: ':'Search Console: ')+e.message).join(' ');}
 else if(!live.ready||issues.some(i=>['header_noindex','sitemap_unavailable'].includes(i.code))){state='technical_issue';summary='Sprawdź dostępność, nagłówki hostingu lub wdrożenie strony. Zmiana tekstu nie naprawi błędu serwera.';}
 else if(LANGS.some(lang=>inspection?.results?.[lang]?.robots==='DISALLOWED')){state='google_attention';summary='Google zgłasza blokadę w robots.txt. Sprawdź raport i aktualne reguły indeksowania; tekst nie został przepisany.';}
 else if(issues.length){state='needs_correction';kind=rejected.length||duplicates.length?'content':'metadata';summary=kind==='content'?'Wykryto uzasadnienie do przygotowania nowego szkicu PL/EN.':'Potrzebna jest ponowna publikacja z poprawnymi metadanymi lub mapą witryny.';}
 else if(canonicalMismatch){state='google_attention';summary='Google wskazuje inny adres kanoniczny. Sprawdź raport; przyczyną może być duplikat lub starsza wersja w indeksie. Tekst nie został automatycznie przepisany.';}
 else if(LANGS.every(lang=>inspection?.results?.[lang]?.verdict==='PASS')){state='healthy';summary='Obie wersje są dostępne, a Google potwierdza ich obecność w indeksie.';}
 return {state,summary,issues,correction_kind:kind};
}
export function correctionAllowed(doc:any,now=Date.now()){
 const r=doc.google?.review,c=r?.correction;
 return doc.state==='published'&&doc.published?.revision===doc.revision&&r?.revision===doc.revision&&!!r.correction_kind&&['needs_correction','quota_paused'].includes(r.state)&&Date.parse(r.checked_at)>now-2*DAY&&(!c?.attempted_at||Date.parse(c.attempted_at)<=now-7*DAY)&&(!(c?.base_revision===doc.revision)||Number(c.attempts||0)<2);
}
export function correctionChanged(pair:Pair,doc:any){
 for(const issue of doc.google?.review?.issues||[]){if(!LANGS.includes(issue.lang))continue;
  if(issue.code==='google_post_rejected'&&postSummary(pair,issue.lang)===postSummary(doc.published.content,issue.lang))return false;
  if(issue.code==='duplicate_content'&&normal(pair[issue.lang as Lang].main_content)===normal(doc.published.content[issue.lang].main_content))return false;
 }return true;
}
export async function reviewDocument(deps:Deps,admin:any,input:any,cfg:any,comparisons:any[]){
 const doc=await deps.rpc(admin,'admin_seo_claim',{p_id:input.id,p_revision:input.revision});
 try{
  if(doc.state!=='published'||doc.published?.revision!==doc.revision)throw new SeoError('Ta strona ma już szkic zmian. Kontrola nie zastępuje istniejących poprawek.',409);
  const google={...(doc.google||{})};const errors:any[]=[];
  const pathsValid=!!doc.published.content&&LANGS.every(lang=>validPath(doc.published.content[lang]?.slug));
  const [live,search,business]=await Promise.all([
   inspectPublic(deps.fetch,doc.published),
   (async()=>{if(!pathsValid)return null;try{const client=credentials(cfg,await deps.secret(admin,'google_client_secret'),deps.env);const access=await googleAccess(deps.fetch,await deps.secret(admin,'search_refresh'),client,10000);return await inspectPair(googleApi(deps.fetch,access,8000),doc.published.content);}catch(e){errors.push({...safeError(e),service:'search'});return null;}})(),
   (async()=>{const previous=google.business;if(!pathsValid||previous?.revision!==doc.published.revision||previous?.target!==cfg.business_target||!Object.keys(previous.posts||{}).length)return null;
    try{const client=credentials(cfg,await deps.secret(admin,'google_client_secret'),deps.env);const access=await googleAccess(deps.fetch,await deps.secret(admin,'business_refresh'),client,10000);const posts=await existingPosts(googleApi(deps.fetch,access,8000),cfg.business_target);const result=structuredClone(previous);
     for(const lang of LANGS)if(result.posts[lang]?.name){const p=posts.find((p:any)=>p.name===result.posts[lang].name);result.posts[lang].state=p?.state||'UNKNOWN';}
     result.state=Object.values(result.posts).some((p:any)=>p.state==='REJECTED')?'needs_correction':Object.values(result.posts).length===2&&Object.values(result.posts).every((p:any)=>p.state==='LIVE')?'live':'processing';return result;
    }catch(e){errors.push({...safeError(e),service:'business'});return null;}
   })()
  ]);
  const duplicates=await duplicateIssues(doc,comparisons);const result=classifyReview(live,search,business,duplicates,errors),now=new Date();
  google.verification={ready:live.ready,pages:live.pages,checked_at:live.checked_at};if(search)google.inspection=search;if(business)google.business=business;
  google.review={...result,revision:doc.revision,checked_at:now.toISOString(),next_check_at:new Date(now.getTime()+(result.state==='temporary_error'?6:24)*3600000).toISOString(),errors,correction:doc.google?.review?.correction||null};
  const saved=await admin.from('seo_documents').update({google}).eq('id',doc.id).eq('revision',doc.revision).eq('lock_token',doc.lock_token).select('*').single();
  if(saved.error||!saved.data)throw new SeoError('Nie udało się zapisać wyniku kontroli SEO.',502);
  return {document:{...saved.data,lock_token:null,lock_until:null},checked:1,id:doc.id,state:result.state,issues:result.issues.length};
 }finally{await admin.from('seo_documents').update({lock_token:null,lock_until:null}).eq('id',doc.id).eq('lock_token',doc.lock_token);}
}
