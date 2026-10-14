import {SeoError,renderPage,updateSitemap,blobSha,decode64,hash,SITE,type Pair} from './core.ts';
const API='https://api.github.com/repos/expol1/ride24';
export function githubClient(fetcher:typeof fetch,token:string){
 return async(path:string,method='GET',body?:unknown)=>{
  const r=await fetcher(API+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.status===404&&method==='GET')return null;
  if(!r.ok)throw new SeoError(r.status===401||r.status===403?'GitHub odrzucił dostęp. Sprawdź połączenie w Autoprzewodnikach.':r.status===409||r.status===422?'W GitHub pojawiła się równoległa zmiana. Odśwież i spróbuj ponownie; żaden plik nie został nadpisany.':'Nie udało się zakończyć publikacji w GitHub. Spróbuj ponownie tej samej wersji.',502);
  return await r.json();
 };
}
export async function publishPair(fetcher:typeof fetch,token:string,doc:any,pair:Pair){
 const git=githubClient(fetcher,token);const head=await git('/git/ref/heads/main');if(!head?.object?.sha)throw new SeoError('Nie udało się odczytać gałęzi GitHub.',502);
 const base=head.object.sha;const commit=await git('/git/commits/'+base);
 const marker=doc.id+':'+doc.revision+':'+(await hash(JSON.stringify(pair))).slice(0,16);
 const files:Record<string,string>={};for(const lang of ['pl','en'] as const)files[pair[lang].slug.slice(1)+'.html']=renderPage(pair,lang,marker);
 const current=await Promise.all(Object.keys(files).map(path=>git('/contents/'+path+'?ref='+base)));
 const expected=Object.fromEntries(await Promise.all(Object.entries(files).map(async([path,content])=>[path,await blobSha(content)])));
 let identical=true;
 for(let i=0;i<current.length;i++){
  const path=Object.keys(files)[i],actual=current[i];
  if(actual?.sha!==expected[path])identical=false;
  if(actual&&actual.type!=='file')throw new SeoError('Adres SEO jest zajęty w GitHub.',409);
 }
 const sitemap=await git('/contents/sitemap.xml?ref='+base);
 if(!sitemap?.content||sitemap.encoding!=='base64')throw new SeoError('Brak dostępnej mapy witryny. Publikacja zatrzymana.',409);
 const originalXml=decode64(sitemap.content);
 if(identical){
  const hasBoth=Object.values(pair).every(p=>originalXml.includes('<loc>'+SITE+p.slug+'</loc>'));
  if(hasBoth)return {commit:base,revision:doc.revision,marker,manifest:expected,content:pair,recovered:true};
 }
 for(let i=0;i<current.length;i++){
  const path=Object.keys(files)[i],actual=current[i],previous=doc.published?.manifest?.[path];
  if(actual?.sha===expected[path])continue;
  if(previous){if(!actual||actual.sha!==previous)throw new SeoError('Ta strona została zmieniona poza panelem SEO. Nie nadpisano zmian; najpierw uzgodnij aktualną wersję.',409);}
  else if(actual)throw new SeoError('Strona o tym adresie już istnieje. Zmień adres nowego szkicu; istniejąca strona pozostaje bez zmian.',409);
 }
 files['sitemap.xml']=updateSitemap(originalXml,pair,new Date().toISOString().slice(0,10));
 const tree=await git('/git/trees','POST',{base_tree:commit.tree.sha,tree:Object.entries(files).map(([path,content])=>({path,mode:'100644',type:'blob',content}))});
 const saved=await git('/git/commits','POST',{message:'Publish SEO PL/EN: '+doc.label.slice(0,100)+' (revision '+doc.revision+')',tree:tree.sha,parents:[base]});
 await git('/git/refs/heads/main','PATCH',{sha:saved.sha,force:false});
 return {commit:saved.sha,previous_commit:base,revision:doc.revision,marker,manifest:expected,content:pair,published_at:new Date().toISOString()};
}
export async function verifyPublic(fetcher:typeof fetch,published:any){
 if(!published?.content)throw new SeoError('Najpierw opublikuj strony SEO.');
 const results=[];
 for(const lang of ['pl','en'] as const){const url=SITE+published.content[lang].slug;
  try{const r=await fetcher(url+'?seo-check='+encodeURIComponent(published.marker||'legacy'),{redirect:'follow',signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
   const text=await r.text();const ok=r.ok&&text.length<150000&&text.includes('<html lang="'+lang+'"')&&(published.marker?text.includes('data-ride24-seo-revision="'+published.marker+'"'):text.includes(published.content[lang].h1));results.push({lang,url,ok});
  }catch{results.push({lang,url,ok:false});}
 }
 return {ready:results.every(r=>r.ok),pages:results,checked_at:new Date().toISOString()};
}
