import {SeoError,SITE,hash,LANGS,type Pair} from './core.ts';
export const CALLBACK='https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/seo-google-callback';
export const SCOPES={search:'https://www.googleapis.com/auth/webmasters',business:'https://www.googleapis.com/auth/business.manage'};
export type Provider=keyof typeof SCOPES;
export function credentials(settings:any,secret:string|null,env:(name:string)=>string|undefined){return {id:settings.google_client_id||env('GOOGLE_ADS_CLIENT_ID')||'',secret:secret||env('GOOGLE_ADS_CLIENT_SECRET')||''};}
export async function googleAccess(fetcher:typeof fetch,refresh:string|null,client:{id:string;secret:string},timeout=15000){
 if(!refresh)throw new SeoError('Najpierw połącz odpowiednie konto Google w ustawieniach SEO.',409);
 if(!client.id||!client.secret)throw new SeoError('Brak konfiguracji połączenia Google.',409);
 const r=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.id,client_secret:client.secret,refresh_token:refresh,grant_type:'refresh_token'})});
 if(!r.ok)throw Object.assign(new SeoError('Połączenie Google wymaga ponownego autoryzowania. Użyj Połącz Google.',409),{google_category:r.status===429||r.status>=500?'temporary':'authorization'});
 const body=await r.json();if(typeof body.access_token!=='string')throw new SeoError('Google nie zwrócił dostępu.',502);return body.access_token;
}
export function googleApi(fetcher:typeof fetch,access:string,timeout=20000){return async(url:string,method='GET',body?:unknown)=>{
 if(!/^https:\/\/(www\.googleapis\.com|searchconsole\.googleapis\.com|mybusiness\.googleapis\.com|mybusinessaccountmanagement\.googleapis\.com|mybusinessbusinessinformation\.googleapis\.com)\//.test(url))throw new SeoError('Nieprawidłowy adres integracji Google.');
 const r=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(!r.ok)throw Object.assign(new SeoError(r.status===403?'Google odmówił dostępu. Sprawdź uprawnienia konta i włączenie odpowiedniego API.':r.status===429?'Google ograniczył liczbę żądań. Ponów później.':'Google nie przyjął operacji. Sprawdź połączenie i ponów.',r.status===429?429:502),{google_category:r.status===401||r.status===403?'authorization':r.status===429||r.status>=500?'temporary':'configuration'});
 return r.status===204||method==='PUT'?{}:await r.json();
};}
export async function submitSitemap(api:ReturnType<typeof googleApi>){await api('https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent('sc-domain:ride24.pl')+'/sitemaps/'+encodeURIComponent(SITE+'/sitemap.xml'),'PUT');return {state:'submitted',submitted_at:new Date().toISOString(),note:'Zgłoszono mapę witryny. Google decyduje o indeksowaniu stron.'};}
export async function inspectPair(api:ReturnType<typeof googleApi>,pair:Pair){const results=await Promise.all(LANGS.map(async lang=>{const r=await api('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect','POST',{inspectionUrl:SITE+pair[lang].slug,siteUrl:'sc-domain:ride24.pl',languageCode:'pl-PL'});const s=r.inspectionResult?.indexStatusResult||{};return [lang,{verdict:s.verdict||'UNKNOWN',coverage:s.coverageState||'Brak danych Google',last_crawl:s.lastCrawlTime||null,robots:s.robotsTxtState||null,indexing:s.indexingState||null,page_fetch:s.pageFetchState||null,google_canonical:s.googleCanonical||null,user_canonical:s.userCanonical||null}];}));return {state:'checked',checked_at:new Date().toISOString(),results:Object.fromEntries(results)};}
export async function businessTargets(api:ReturnType<typeof googleApi>){
 const accounts=await api('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20');const out=[];
 for(const a of (accounts.accounts||[]).slice(0,20)){
  if(!/^accounts\/\d+$/.test(a.name))continue;
  const r=await api('https://mybusinessbusinessinformation.googleapis.com/v1/'+a.name+'/locations?readMask=name,title&pageSize=100');
  for(const l of r.locations||[])if(/^locations\/\d+$/.test(l.name))out.push({name:a.name+'/'+l.name,title:l.title||l.name});
 }
 return out;
}
export function postSummary(pair:Pair,lang:'pl'|'en'){const p=pair[lang];return (p.h1+'\n\n'+p.intro_text).slice(0,1400);}
export async function existingPosts(api:ReturnType<typeof googleApi>,target:string){if(!/^accounts\/\d+\/locations\/\d+$/.test(target))throw new SeoError('Wybierz wizytówkę Ride24 w ustawieniach SEO.');const r=await api('https://mybusiness.googleapis.com/v4/'+target+'/localPosts?pageSize=100');return r.localPosts||[];}
export async function createPost(api:ReturnType<typeof googleApi>,target:string,pair:Pair,lang:'pl'|'en'){
 return api('https://mybusiness.googleapis.com/v4/'+target+'/localPosts','POST',{languageCode:lang,summary:postSummary(pair,lang),topicType:'STANDARD',callToAction:{actionType:'LEARN_MORE',url:SITE+pair[lang].slug}});
}
export async function oauthStart(fetcher:typeof fetch,admin:any,userId:string,provider:Provider,client:any){
 if(!client.id||!client.secret)throw new SeoError('Uzupełnij konfigurację Google w ustawieniach SEO.');
 const random=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');};
 const state=random(),verifier=random(),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
 const challenge=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 const state_hash=await hash(state);
 const {error}=await admin.from('seo_oauth_states').insert({state_hash,provider,user_id:userId,verifier,expires_at:new Date(Date.now()+10*60000).toISOString()});if(error)throw new SeoError('Nie udało się rozpocząć połączenia Google.',502);
 await admin.from('seo_oauth_states').delete().lt('expires_at',new Date().toISOString());
 const p=new URLSearchParams({client_id:client.id,redirect_uri:CALLBACK,response_type:'code',access_type:'offline',prompt:'consent',scope:SCOPES[provider],state,code_challenge:challenge,code_challenge_method:'S256'});
 return 'https://accounts.google.com/o/oauth2/v2/auth?'+p;
}
