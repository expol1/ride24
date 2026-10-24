// Actual admin markup and UI module, isolated from external services and Auth.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {JSDOM,VirtualConsole} from 'jsdom';
import * as core from '../../assets/js/seo-content.js';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const seed=JSON.parse(read('supabase/functions/admin-seo/legacy-seed.json'))[0];
async function fixture(){
 const dom=new JSDOM(read('admin/index.html'),{url:'https://ride24.invalid/admin/',runScripts:'outside-only',virtualConsole:new VirtualConsole()});
 const w=dom.window,d=w.document,calls=[],history=[],clipboard=[];
 const doc={...structuredClone(seed),id:'11111111-1111-4111-8111-111111111111',state:'published',revision:1,review_note:'',last_error:'',google:{inspection:{results:{pl:{verdict:'NEUTRAL',coverage:'Wykryto — obecnie niezindeksowana'}}},business:{state:'needs_correction',posts:{pl:{state:'REJECTED'},en:{state:'LIVE'}}}}};
 const published=structuredClone(doc.published),original=structuredClone(doc.content);
 function save(pair,note){history.push({id:'22222222-2222-4222-8222-222222222222',revision:doc.revision,content:structuredClone(doc.content),created_at:'2026-10-24T10:00:00Z'});doc.content=structuredClone(pair);doc.review_note=note;doc.revision++;doc.state='changed';}
 w.testSeoCore=core;w.confirm=()=>true;
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>clipboard.push(value)}});
 w.db={functions:{async invoke(name,{body}){
  assert.equal(name,'admin-seo');calls.push(structuredClone(body));
  if(body.action==='list')return {data:{documents:[structuredClone(doc)],settings:{enabled:true,auto_generate:true,free_tier_confirmed:true,daily_limit:5,used_today:5,business_target:'accounts/1/locations/2'},connections:{github:true,gemini:true,search:true,business:true}}};
  if(body.action==='save'){save(body.content,body.note);return {data:{document:structuredClone(doc)}};}
  if(body.action==='generate'){const pair=structuredClone(doc.content);pair.pl.h1='Poprawiony nagłówek';pair.en.h1='Corrected heading';save(pair,body.note);return {data:{document:structuredClone(doc),warnings:[]}};}
  if(body.action==='publish'){assert.equal(body.approved,true);doc.published={...doc.published,revision:doc.revision,content:structuredClone(doc.content)};doc.state='published';doc.google.search={state:'pending',note:'Oczekiwanie na wdrożenie'};return {data:{published:structuredClone(doc.published),google:structuredClone(doc.google)}};}
  if(body.action==='history')return {data:{revisions:structuredClone(history)}};
  if(body.action==='restore'){save(history[0].content,'Przywrócony szkic');return {data:{document:structuredClone(doc)}};}
  if(body.action==='submit'){doc.google.search={state:'submitted',note:'Mapa zgłoszona. Google decyduje o indeksowaniu.'};return {data:{google:structuredClone(doc.google)}};}
  if(body.action==='inspect'||body.action==='business_check')return {data:{google:structuredClone(doc.google)}};
  throw Error('Unexpected UI request '+body.action);
 }}};
 w.eval(read('assets/js/admin-seo.js').replace(/^import[^\n]*\n/,'const {esc,validatePair,renderPage,makePrompt}=window.testSeoCore;\n'));
 await w.loadSeo();d.querySelector('.seo-entry').click();
 return {dom,w,d,doc,calls,history,clipboard,published,original};
}
test('admin displays automation settings, quota, non-indexed URLs and rejected Google posts accurately',async()=>{
 const f=await fixture();try{
  assert.equal(f.d.getElementById('seo-auto').checked,true);assert.match(f.d.getElementById('seo-ai-usage').textContent,/5 \/ 5/);
  const status=f.d.getElementById('seo-google-status').textContent;assert.match(status,/niezindeksowana/);assert.match(status,/odrzucony/);
  assert.equal(f.d.getElementById('seo-publish').disabled,true);assert.equal(f.d.getElementById('seo-business-publish').disabled,true);
 }finally{f.dom.window.close();}
});
test('Google feedback clears approval, saves a draft and is forwarded to PL/EN regeneration',async()=>{
 const f=await fixture();try{
  const approval=f.d.getElementById('seo-approved');approval.checked=true;f.w.seoButtons();
  const note=f.d.getElementById('seo-note');note.value='Google: popraw nagłówek i wstęp.';note.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  assert.equal(approval.checked,false);assert.equal(f.d.getElementById('seo-business-publish').disabled,true);
  await f.w.seoGenerate();const actions=f.calls.filter(c=>['save','generate'].includes(c.action));assert.deepEqual(actions.map(c=>c.action),['save','generate']);assert.equal(actions[1].note,note.value);
  assert.equal(f.d.getElementById('seo-pl-h1').value,'Poprawiony nagłówek');assert.equal(f.d.getElementById('seo-en-h1').value,'Corrected heading');
  for(const lang of ['pl','en'])assert.equal(f.d.getElementById('seo-'+lang+'-slug').value,f.original[lang].slug);
  assert.deepEqual(f.doc.published,f.published);assert.equal(f.doc.state,'changed');assert.ok(!f.calls.some(c=>c.action==='publish'));
 }finally{f.dom.window.close();}
});
test('a correction is published only after renewed approval, then can be resubmitted to Google',async()=>{
 const f=await fixture();try{
  await f.w.seoGenerate();await f.w.seoPublish();assert.equal(f.calls.filter(c=>c.action==='publish').length,0);
  f.d.getElementById('seo-approved').checked=true;f.w.seoButtons();await f.w.seoPublish();
  assert.equal(f.doc.state,'published');assert.equal(f.doc.published.revision,f.doc.revision);
  for(const lang of ['pl','en'])assert.equal(f.doc.published.content[lang].slug,f.original[lang].slug);
  assert.match(f.d.getElementById('seo-google-status').textContent,/Oczekiwanie na wdrożenie/);
  await f.w.seoGoogle('submit');assert.equal(f.doc.google.search.state,'submitted');assert.match(f.d.getElementById('seo-google-status').textContent,/Google decyduje o indeksowaniu/);
 }finally{f.dom.window.close();}
});
test('history restoration remains a draft and preserves the public version',async()=>{
 const f=await fixture();try{
  f.d.getElementById('seo-en-h1').value='Manual correction';await f.w.seoSave();await f.w.seoHistory();
  assert.equal(f.d.querySelectorAll('#seo-history button').length,1);await f.w.seoRestore(f.history[0].id);
  assert.equal(f.doc.state,'changed');assert.deepEqual(f.doc.published,f.published);assert.deepEqual(f.doc.content,f.original);assert.ok(!f.calls.some(c=>c.action==='publish'));
 }finally{f.dom.window.close();}
});
test('copied browser prompt includes current offer-fact and refundable-cash safeguards',async()=>{
 const f=await fixture();try{
  await f.w.seoCopyPrompt();assert.equal(f.clipboard.length,1);assert.match(f.clipboard[0],/rental_offer_facts/);assert.match(f.clipboard[0],/all_three_confirmed_classes = 0/);assert.match(f.clipboard[0],/NIE blokadę na karcie/);
  assert.deepEqual(f.doc.published,f.published);assert.ok(!f.calls.some(c=>c.action==='generate'));
 }finally{f.dom.window.close();}
});
