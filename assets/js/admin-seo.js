import {esc,validatePair,renderPage,makePrompt} from './seo-content.js?v=20261024a';
let documents=[],selected=null,connections={},settings={},catalog={state:'unavailable',keys:[]},busy=false,dirty=false,language='pl';
const $=id=>document.getElementById(id);
const reviewLabels={awaiting_check:'oczekuje na kontrolę',healthy:'Google potwierdza indeksowanie',waiting_indexing:'oczekuje na indeksowanie',needs_correction:'poprawka w kolejce',draft_ready:'poprawka gotowa do zatwierdzenia',technical_issue:'sprawdź dostępność strony',google_attention:'sprawdź raport Google',connection_issue:'sprawdź połączenie Google',manual_attention:'wymaga ręcznej kontroli',temporary_error:'chwilowy błąd kontroli',quota_paused:'poprawka czeka na limit AI',preparing_correction:'przygotowywanie poprawki',correction_failed:'poprawka wymaga kontroli'};
function renderPerformance(p){
 const root=$('seo-performance');if(!root)return;
 root.replaceChildren();
 if(!p?.checked_at){root.textContent='Brak wyników. Automatyczny odczyt działa raz dziennie, możesz także pobrać dane teraz.';return;}
 const fmt=(n)=>Number(n||0).toLocaleString('pl-PL',{maximumFractionDigits:1});
 const t=p.totals||{};
 const intro=document.createElement('p');
 intro.textContent='Okres '+p.start_date+' – '+p.end_date+
   ' | kliknięcia: '+fmt(t.clicks)+' | wyświetlenia: '+fmt(t.impressions)+
   ' | CTR: '+(Number(t.ctr||0)*100).toFixed(2)+'% | średnia pozycja: '+fmt(t.position)+
   ' | zbadane podstrony SEO: '+fmt(p.seo_pages)+'.';
 root.append(intro);
 const checked=document.createElement('p');checked.textContent='Ostatni odczyt: '+new Date(p.checked_at).toLocaleString('pl-PL');root.append(checked);
 if(p.opportunities?.length){
  const title=document.createElement('strong');title.textContent='Strony z wyświetleniami, ale słabym CTR — sprawdź tytuły i opisy:';root.append(title);
  const list=document.createElement('ul');
  for(const item of p.opportunities.slice(0,8)){
   const li=document.createElement('li');li.textContent=String(item.url).replace('https://ride24.pl','')+
    ' — '+fmt(item.impressions)+' wyświetleń, CTR '+(Number(item.ctr)*100).toFixed(2)+'%, pozycja '+fmt(item.position);
   list.append(li);
  }
  root.append(list);
 }else {const p2=document.createElement('p');p2.textContent='Na razie brak wystarczająco uzasadnionych sugestii zmian na podstawie CTR.';root.append(p2);}
}
async function seoPerformance(){
 return run(async()=>{
   message('Pobieram bezpłatny raport Search Console…');
   const r=await invoke({action:'performance'});
   settings.search_performance=r.performance||{};
   renderPerformance(settings.search_performance);
   message('Odczytano rzeczywiste statystyki Search Console. Zmiany treści wymagają Twojego zatwierdzenia.');
 });
}
function reviewSummary(){const pages=documents.filter(d=>d.published),checked=pages.filter(d=>d.google?.review?.checked_at),ready=pages.filter(d=>d.state==='changed'&&d.google?.review?.state==='draft_ready');$('seo-review-summary').textContent=settings.auto_review_enabled?'Automatyczna kontrola włączona. Sprawdzone: '+checked.length+' / '+pages.length+'; Google potwierdza indeksowanie PL i EN: '+pages.filter(d=>d.google?.review?.state==='healthy').length+'; gotowe poprawki: '+ready.length+'; poprawki dziś: '+(settings.correction_used_today?1:0)+' / 1. System sprawdza kolejne strony co 15 minut, standardowo ponawiając kontrolę po 24 godzinach.':'Automatyczna kontrola Google jest wyłączona. Możesz ją włączyć w ustawieniach lub sprawdzić wybraną stronę ręcznie.';}

function message(text,error=false){const el=$('seo-message');el.textContent=text;el.className='seo-status '+(error?'error':'success');}
async function invoke(body){const {data,error}=await db.functions.invoke('admin-seo',{body});if(error){let text='Nie udało się połączyć z modułem SEO.';try{const result=await error.context?.clone().json();if(typeof result?.error==='string')text=result.error;}catch{}throw new Error(text);}if(data?.error)throw new Error(data.error);return data;}
async function run(fn){if(busy)return;busy=true;seoButtons();try{return await fn();}catch(e){message(e.message,true);}finally{busy=false;seoButtons();}}
function seoButtons(){document.querySelectorAll('#view-seo button').forEach(b=>b.disabled=busy);const doc=current(),dismissed=doc?.state==='dismissed';$('seo-dismiss').hidden=!doc||!!doc.published||dismissed;$('seo-undismiss').hidden=!dismissed;$('seo-save').disabled=busy||dismissed;$('seo-approved').disabled=busy||dismissed;$('seo-publish').disabled=busy||dismissed||!doc||!connections.github||dirty||!$('seo-approved').checked||!doc.content||!settings.enabled||obsolete(doc);$('seo-business-publish').disabled=busy||!doc?.published||doc.state!=='published'||doc.published.revision!==doc.revision||dirty||!$('seo-approved').checked||!connections.business||!settings.business_target||!settings.enabled;$('seo-generate').disabled=busy||dismissed||obsolete(doc)||!connections.gemini||!settings.free_tier_confirmed||!settings.enabled;$('seo-review-now').disabled=busy||dirty||!doc?.published||doc.state!=='published'||doc.published.revision!==doc.revision||!settings.enabled;}
function current(){return documents.find(d=>d.id===selected);}
// A queued topic is historical only when the backend successfully verified live locations.
function obsolete(doc){return catalog.state==='ready'&&doc?.state==='queued'&&!catalog.keys.includes(doc.topic_key);}
function updateDoc(d){const i=documents.findIndex(x=>x.id===d.id);if(i>=0)documents[i]=d;else documents.unshift(d);selected=d.id;dirty=false;renderEditor();seoRenderList();}
async function refresh(){const data=await invoke({action:'list'});documents=data.documents||[];settings=data.settings||{};connections=data.connections||{};catalog=data.catalog||{state:'unavailable',keys:[]};
 $('seo-connections').replaceChildren(...[['github','GitHub'],['gemini','Gemini'],['search','Search Console'],['business','Wizytówka Google']].map(([key,label])=>{const el=document.createElement('span');el.className='seo-badge'+(connections[key]?' ready':'');el.textContent=label+': '+(connections[key]?'skonfigurowane':'do połączenia');return el;}));
 $('seo-enabled').checked=settings.enabled;$('seo-auto').checked=settings.auto_generate;$('seo-review-auto').checked=settings.auto_review_enabled===true;$('seo-business-auto').checked=settings.auto_business_post===true;renderPerformance(settings.search_performance);$('seo-free').checked=settings.free_tier_confirmed;$('seo-limit').value=settings.daily_limit||3;$('seo-oauth-id').value=settings.google_client_id||'';$('seo-callback').value=connections.callback||'';$('seo-ai-usage').textContent='Próby AI dziś: '+settings.used_today+' / '+settings.daily_limit+'. Limit odnawia się o 00:00 UTC.';
 if(settings.business_target){const option=document.createElement('option');option.value=settings.business_target;option.textContent='Zapisana wizytówka Ride24';$('seo-business-target').replaceChildren(option);}
 seoRenderList();renderEditor();seoButtons();return data;
}
async function loadSeo(){if(dirty&&!confirm('Masz niezapisane zmiany. Odświeżyć i odrzucić je?'))return;return run(async()=>{dirty=false;await refresh();message(settings.enabled?'SEO gotowe. Wybierz stronę lub odśwież lokalizacje.':'SEO wyłączone. Szkice i historia pozostają zapisane.');});}
function seoRenderList(){
 reviewSummary();
 const outdated=documents.filter(obsolete),waiting=documents.filter(d=>d.state==='queued'&&!obsolete(d));
 const summary=$('seo-queue-summary');
 if(summary)summary.textContent=catalog.state==='ready'
  ?'Nowe propozycje do przygotowania: '+waiting.length+'. Historyczne wpisy z nieaktualnym identyfikatorem: '+outdated.length+'. '+(settings.auto_generate?'Automat tworzy nowe szkice do Twojej akceptacji, bez automatycznej publikacji.':'Automatyczne przygotowywanie jest wyłączone.')
  :'Nie można obecnie potwierdzić aktualności kierunków. Historyczne wpisy nie są automatycznie usuwane.';
 const filter=$('seo-filter').value,q=$('seo-find').value.trim().toLocaleLowerCase('pl');
 const attention=['needs_correction','technical_issue','google_attention','connection_issue','manual_attention','temporary_error','correction_failed','quota_paused'];
 const visible=documents.filter(d=>{
  const old=obsolete(d);
  const matches=filter==='all'&&d.state!=='dismissed'&&!old
   ||filter==='queued'&&d.state==='queued'&&!old
   ||filter==='outdated'&&old
   ||filter==='draft'&&['draft','changed'].includes(d.state)
   ||filter==='attention'&&attention.includes(d.google?.review?.state)
   ||filter!=='queued'&&filter!=='outdated'&&d.state===filter;
  return matches&&d.label.toLocaleLowerCase('pl').includes(q);
 });
 const box=$('seo-list');box.replaceChildren();
 for(const doc of visible){
  const old=obsolete(doc),button=document.createElement('button');
  button.type='button';button.className='seo-entry'+(selected===doc.id?' active':'');
  button.disabled=busy;
  const title=document.createElement('strong');title.textContent=doc.label;
  const info=document.createElement('small');
  info.textContent=(old?'Historyczna propozycja — nazwa/identyfikator nieaktualny':({queued:'Do przygotowania',draft:'Szkic do sprawdzenia',published:'Opublikowane',changed:'Poprawki do opublikowania',dismissed:'Usunięta propozycja'}[doc.state]||doc.state))
   +(doc.google?.review?' • '+(reviewLabels[doc.google.review.state]||'wynik kontroli dostępny'):'')
   +(doc.last_error&&!old?' • ostatnia operacja wymaga sprawdzenia':'');
  button.append(title,info);button.onclick=()=>seoOpen(doc.id);box.append(button);
 }
 if(!visible.length){
  const p=document.createElement('p');p.className='seo-muted';
  p.textContent=filter==='queued'&&catalog.state==='ready'
   ?'Brak nowych kierunków do wygenerowania. Istniejące strony SEO są zachowane, a automat wykryje nowe aktywne lokalizacje.'
   :filter==='outdated'&&catalog.state==='ready'?'Brak historycznych wpisów w kolejce.':'Brak stron w tym widoku.';
  box.append(p);
 }
}
function seoOpen(id){if(busy)return;if(dirty&&!confirm('Odrzucić niezapisane zmiany tego szkicu?'))return;selected=id;dirty=false;renderEditor();seoRenderList();}
const fields=[['meta_title','Tytuł w Google',90,'input'],['meta_description','Opis w Google',220,'textarea'],['h1','Nagłówek strony',150,'input'],['intro_text','Wprowadzenie',2500,'textarea'],['main_content','Treść — akapity oddziel pustą linią',30000,'textarea'],['cta_text','Tekst przycisku do wyszukiwarki',100,'input']];
function blank(doc,lang){return {slug:doc.source?.slugs?.[lang]||'',meta_title:'',meta_description:'',h1:'',intro_text:'',main_content:'',cta_text:lang==='pl'?'Porównaj oferty wynajmu':'Compare rental offers',cta_url:'/'};}
function renderEditor(){const doc=current();$('seo-empty').hidden=!!doc;$('seo-work').hidden=!doc;if(!doc)return;
 $('seo-editor-title').textContent=doc.label;$('seo-source').textContent='Rodzaj: '+({country:'kraj',region:'region',city:'miasto',airport:'lotnisko'}[doc.source.kind]||doc.source.kind)+' • wersja '+doc.revision+' • punkty odbioru: '+(doc.source.locations?.map(l=>l.name).join(', ')||'istniejąca strona SEO')+(obsolete(doc)?' • Historyczny wpis: lokalizacja mogła zmienić nazwę, a aktualna strona jest już dostępna. Nie generuj duplikatu.':'');
 const container=$('seo-fields');container.replaceChildren();for(const lang of ['pl','en']){const page=doc.content?.[lang]||blank(doc,lang);const box=document.createElement('div');box.id='seo-fields-'+lang;box.className='seo-editor-language';for(const [key,label,max,type] of fields){const wrap=document.createElement('div');wrap.className='seo-field';const lab=document.createElement('label');lab.htmlFor='seo-'+lang+'-'+key;lab.textContent=label;const input=document.createElement(type);input.id=lab.htmlFor;input.maxLength=max;input.value=page[key];if(key==='main_content')input.className='seo-main-text';input.addEventListener('input',()=>{dirty=true;$('seo-approved').checked=false;seoButtons();preview();});wrap.append(lab,input);box.append(wrap);}const details=document.createElement('details');details.innerHTML='<summary>Adres strony</summary>';const wrap=document.createElement('div');wrap.className='seo-field';const label=document.createElement('label');label.htmlFor='seo-'+lang+'-slug';label.textContent='Adres '+lang.toUpperCase()+' — po publikacji pozostaje stały';const input=document.createElement('input');input.id=label.htmlFor;input.value=page.slug;input.readOnly=!!doc.published;input.maxLength=160;input.oninput=()=>{dirty=true;$('seo-approved').checked=false;seoButtons();preview();};wrap.append(label,input);details.append(wrap);box.append(details);container.append(box);}
 $('seo-note').value=doc.review_note||'';$('seo-note').oninput=()=>{dirty=true;$('seo-approved').checked=false;seoButtons();};$('seo-approved').checked=false;$('seo-history').replaceChildren();$('seo-json').value='';$('seo-generate').textContent=doc.content?'Przygotuj poprawioną wersję PL i EN':'Przygotuj PL i EN';seoLanguage(language);renderStatus(doc);const dismissed=doc.state==='dismissed';document.querySelectorAll('#seo-fields input, #seo-fields textarea').forEach(el=>el.disabled=dismissed);$('seo-note').disabled=dismissed;seoButtons();}
function readPair(){const pair={};for(const lang of ['pl','en']){const p={cta_url:'/'};for(const [key] of fields)p[key]=$('seo-'+lang+'-'+key).value;p.slug=$('seo-'+lang+'-slug').value.trim();pair[lang]=p;}return pair;}
function seoLanguage(lang){language=lang;for(const l of ['pl','en']){$('seo-fields-'+l)?.toggleAttribute('hidden',l!==lang);$('seo-tab-'+l).classList.toggle('active',l===lang);}preview();}
function preview(){if(!current())return;const p=readPair();$('seo-preview').srcdoc=renderPage(p,language,'preview');}
function renderStatus(doc){$('seo-publish-status').textContent=doc.published?'Wersja '+doc.published.revision+' zapisana w GitHub'+(doc.state==='changed'?'. Masz poprawki w szkicu.':'.')+(doc.last_error?' '+doc.last_error:''):'Szkic nie jest publiczny.';
 const box=$('seo-links');box.replaceChildren();if(doc.published)for(const lang of ['pl','en']){const a=document.createElement('a');a.href='https://ride24.pl'+doc.published.content[lang].slug;a.target='_blank';a.rel='noopener noreferrer';a.textContent=lang.toUpperCase()+': '+a.href;box.append(a);}
 const g=doc.google||{},lines=[];if(g.review){lines.push('Automatyczna kontrola: '+(reviewLabels[g.review.state]||g.review.state));if(g.review.checked_at)lines.push('Sprawdzono: '+new Date(g.review.checked_at).toLocaleString('pl-PL'));lines.push(g.review.summary||'');for(const issue of g.review.issues||[])lines.push('• '+issue.message);}if(g.verification)lines.push('Strona: '+(g.verification.ready?'opublikowana wersja dostępna':'oczekuje na wdrożenie — ponów sprawdzenie'));if(g.search)lines.push('Search Console: '+(g.search.note||({submitted:'mapa zgłoszona do Google',pending:'oczekuje na zgłoszenie'}[g.search.state]||g.search.state)));if(g.inspection?.results)for(const [lang,r] of Object.entries(g.inspection.results))lines.push(lang.toUpperCase()+': '+r.coverage+' ('+r.verdict+')');if(g.business)lines.push('Wizytówka: '+({sent:'wpisy wysłane do Google',pending:'wysyłanie',needs_check:'wymaga sprawdzenia połączenia lub statusu wpisu',needs_correction:'Google odrzuciło wpis — przygotuj poprawkę',live:'wpisy opublikowane',processing:'Google przetwarza wpisy',not_published:'brak potwierdzonych wpisów dla tej wersji'}[g.business.state]||g.business.state));if(g.business?.posts)for(const [lang,p] of Object.entries(g.business.posts))lines.push('Wpis '+lang.toUpperCase()+': '+({LIVE:'opublikowany',PROCESSING:'Google przetwarza',REJECTED:'odrzucony — popraw treść i opublikuj nową wersję'}[p.state]||p.state));$('seo-google-status').textContent=lines.join('\n')||'Brak zgłoszeń Google dla tej strony.';$('seo-google-status').style.whiteSpace='pre-line';}
async function saveCurrent(){const doc=current();if(!doc)throw new Error('Wybierz stronę.');const content=validatePair(readPair(),doc.published?.content);const r=await invoke({action:'save',id:doc.id,revision:doc.revision,content,note:$('seo-note').value});updateDoc(r.document);return r.document;}
async function seoSave(){return run(async()=>{await saveCurrent();message('Szkic zapisany. Publiczna strona zmieni się dopiero po publikacji.');});}
async function seoDismiss(){const doc=current();if(!doc||doc.published||doc.state==='dismissed')return;if(!confirm('Usunąć propozycję SEO „'+doc.label+'” z kolejki? Opublikowanych stron nie zmienimy. Propozycję będzie można przywrócić w filtrze „Usunięte propozycje”.'))return;return run(async()=>{await invoke({action:'dismiss',id:doc.id,revision:doc.revision});selected=null;dirty=false;await refresh();message('Propozycja SEO została usunięta z kolejki. Nie pojawi się ponownie po synchronizacji lokalizacji.');});}
async function seoRestoreDismissed(){const doc=current();if(!doc||doc.state!=='dismissed')return;return run(async()=>{await invoke({action:'restore_dismissed',id:doc.id,revision:doc.revision});$('seo-filter').value='all';dirty=false;await refresh();message('Przywrócono propozycję SEO do kolejki.');});}
async function seoSync(){if(dirty&&!confirm('Odświeżenie zastąpi niezapisane zmiany. Kontynuować?'))return;return run(async()=>{const r=await invoke({action:'sync'});dirty=false;await refresh();message('Dodano propozycje nowych stron: '+r.added+'. Obecne strony zachowano.');});}
async function seoGenerate(){return run(async()=>{let doc=current();if(!doc)throw new Error('Wybierz stronę.');if(obsolete(doc))throw new Error('To historyczny wariant kierunku. Wybierz aktualną stronę SEO lub sprawdź filtr Nieaktualne; nie twórz duplikatu.');const note=$('seo-note').value;if(dirty&&doc.content)doc=await saveCurrent();message('Przygotowuję PL i EN…');const r=await invoke({action:'generate',id:doc.id,revision:doc.revision,note});updateDoc(r.document);message('Szkic PL i EN gotowy. Sprawdź treść przed publikacją.'+(r.warnings?.length?' '+r.warnings.join(' '):''));});}
async function seoPublish(){return run(async()=>{const doc=current();if(dirty)throw new Error('Najpierw zapisz szkic.');if(!$('seo-approved').checked)throw new Error('Sprawdź i zatwierdź obie wersje.');message('Publikuję obie wersje i mapę witryny…');const r=await invoke({action:'publish',id:doc.id,revision:doc.revision,approved:true});await refresh();message('PL i EN zapisane w GitHub. Status dostępności strony oraz Google znajdziesz poniżej.'+(r.warnings?.length?' '+r.warnings.join(' '):''));});}
async function seoGoogle(action){return run(async()=>{const doc=current();if(!doc?.published)throw new Error('Najpierw opublikuj stronę.');if(dirty)throw new Error('Najpierw zapisz szkic.');const r=await invoke({action,id:doc.id,revision:doc.revision});doc.google=r.google;renderStatus(doc);message(action==='inspect'||action==='business_check'?'Pobrano informacje Google.':action==='submit'?'Mapa zgłoszona. Google decyduje o indeksowaniu.':'Sprawdzono dostępność stron.');});}
async function seoReview(){return run(async()=>{const doc=current();if(!doc?.published||dirty)throw new Error('Wybierz opublikowaną stronę bez niezapisanych zmian.');message('Sprawdzam strony PL/EN i status Google…');const result=await invoke({action:'review',id:doc.id,revision:doc.revision});updateDoc(result.document);message('Kontrola zakończona. Wynik i ewentualną poprawkę znajdziesz w statusie poniżej.');});}
async function seoBusinessPublish(){return run(async()=>{const doc=current();if(!doc?.published||!$('seo-approved').checked||dirty)throw new Error('Zapisz zmiany i zatwierdź treści przed publikacją wpisów.');const r=await invoke({action:'business_publish',id:doc.id,revision:doc.revision,approved:true});doc.google=r.google;renderStatus(doc);message('Wpisy PL i EN wysłane do wizytówki Google. Sprawdź ich status.');});}
async function seoHistory(){return run(async()=>{const doc=current();const r=await invoke({action:'history',id:doc.id});const box=$('seo-history');box.replaceChildren();for(const h of r.revisions){const b=document.createElement('button');b.type='button';b.textContent='Wersja '+h.revision+' • '+new Date(h.created_at).toLocaleString('pl-PL')+' — przywróć jako szkic';b.onclick=()=>seoRestore(h.id);box.append(b);}if(!r.revisions.length)box.textContent='Brak wcześniejszych zapisanych wersji.';});}
async function seoRestore(history_id){if(dirty&&!confirm('Odrzucić niezapisane zmiany i przywrócić treść historyczną jako szkic?'))return;return run(async()=>{const doc=current();const r=await invoke({action:'restore',id:doc.id,revision:doc.revision,history_id});updateDoc(r.document);message('Przywrócono treść jako szkic. Sprawdź ją przed publikacją.');});}
async function seoSaveSettings(event){event.preventDefault();if(dirty&&!confirm('Zapis ustawień odświeży panel i odrzuci niezapisane zmiany tekstu. Kontynuować?'))return;return run(async()=>{const payload={action:'configure',enabled:$('seo-enabled').checked,auto_generate:$('seo-auto').checked,auto_review_enabled:$('seo-review-auto').checked,auto_business_post:$('seo-business-auto').checked,free_tier_confirmed:$('seo-free').checked,daily_limit:Number($('seo-limit').value),google_client_id:$('seo-oauth-id').value.trim(),gemini_key:$('seo-gemini-key').value.trim(),google_client_secret:$('seo-oauth-secret').value.trim()};try{await invoke(payload);}finally{$('seo-gemini-key').value='';$('seo-oauth-secret').value='';}await refresh();message('Ustawienia zapisane. Puste pola kluczy zachowują dotychczasową konfigurację.');});}
async function seoConnect(provider){return run(async()=>{const r=await invoke({action:'google_connect',provider});if(!r.url?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'))throw new Error('Nieprawidłowy adres logowania Google.');location.assign(r.url);});}
async function seoLoadTargets(){return run(async()=>{const r=await invoke({action:'business_targets'});const select=$('seo-business-target');select.replaceChildren();const first=document.createElement('option');first.value='';first.textContent='Wybierz wizytówkę Ride24';select.append(first);for(const target of r.targets){const option=document.createElement('option');option.value=target.name;option.textContent=target.title;select.append(option);}select.value=settings.business_target||'';message(r.targets.length?'Wybierz wizytówkę Ride24 z listy.':'Google nie zwrócił wizytówek dla tego konta.');});}
async function seoSelectTarget(){return run(async()=>{const target=$('seo-business-target').value;await invoke({action:'configure',business_target:target});settings.business_target=target;message('Zapisano wybraną wizytówkę.');});}
async function seoCopyPrompt(){return run(async()=>{const d=current();await navigator.clipboard.writeText(makePrompt(d.source,d.content,$('seo-note').value));message('Instrukcja skopiowana. Możesz przygotować tekst we własnym generatorze i wkleić JSON.');});}
async function seoImportJson(){return run(async()=>{const doc=current();let value;try{value=JSON.parse($('seo-json').value);}catch{throw new Error('Wklej poprawny JSON z sekcjami pl i en.');}const pair=validatePair(value,doc.published?.content);const r=await invoke({action:'save',id:doc.id,revision:doc.revision,content:pair,note:$('seo-note').value});updateDoc(r.document);message('Treść wczytana jako szkic. Sprawdź obie wersje przed publikacją.');});}
Object.assign(window,{seoPerformance,loadSeo,seoButtons,seoDismiss,seoRestoreDismissed,seoRenderList,seoLanguage,seoSave,seoSync,seoGenerate,seoPublish,seoGoogle,seoReview,seoBusinessPublish,seoHistory,seoSaveSettings,seoConnect,seoLoadTargets,seoSelectTarget,seoCopyPrompt,seoImportJson});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
document.addEventListener('DOMContentLoaded',()=>{const params=new URLSearchParams(location.search);if(location.hash==='#seo'||params.has('seo_google')){window.switchTab('seo');const result=params.get('seo_google');if(result){const success=result.endsWith('_connected');setTimeout(()=>message(success?'Konto Google połączone. Odśwież status i wybierz stronę.':'Google nie zostało połączone: '+({expired_state:'połączenie wygasło — rozpocznij ponownie',cancelled:'anulowano zgodę',missing_permission:'brak wymaganych uprawnień',connection_failed:'sprawdź konfigurację OAuth i adres powrotu'}[result]||'rozpocznij połączenie ponownie'),!success),1200);history.replaceState(null,'','/admin/#seo');}}});
