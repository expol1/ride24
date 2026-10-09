import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createGuideHandler } from '../../supabase/functions/admin-travel-guides/handler.ts';

const original = readFileSync(new URL('../../admin/index.html',import.meta.url),'utf8');
// Run the production form and upload script, with isolated server/Auth/GitHub fixtures.
// Other admin sections and their unrelated startup requests are outside this test.
const page = original.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const dom = new JSDOM(page,{ url:'https://ride24.pl/admin/',runScripts:'outside-only' });
const w = dom.window;
w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
const state = { token:null,files:new Map(),guides:[],requests:[],locationsRefreshes:0 };
const blob = html => createHash('sha1').update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest('hex');
const store = {
  getToken: async()=>state.token,
  setToken: async token=>{state.token=token;},
  findGuides: async slug=>state.guides.filter(g=>g.slug===slug||g.folder_name===slug),
  insertGuide: async(title,slug)=>{
    const guide={id:'guide-'+slug,title,slug,folder_name:slug,active:true};state.guides.push(guide);return guide;
  },
};
const handler = createGuideHandler({authorize:async()=>store,fetch:async(url,options)=>{
  if(url==='https://api.github.com/repos/expol1/ride24')return Response.json({full_name:'expol1/ride24',permissions:{push:true}});
  const path=new URL(url).pathname;
  if(options.method==='PUT'){
    const body=JSON.parse(options.body);assert.equal('sha' in body,false);
    const html=Buffer.from(body.content,'base64').toString('utf8');state.files.set(path,html);
    return Response.json({commit:{sha:'fixture-commit'}},{status:201});
  }
  const html=state.files.get(path);
  return html?Response.json({type:'file',sha:blob(html)}):Response.json({}, {status:404});
}});
const locations=[{guide_id:'guide-varna'},{guide_id:'guide-varna'}];
w.db={
  functions:{invoke:async(name,{body})=>{
    assert.equal(name,'admin-travel-guides');state.requests.push(body);
    const response=await handler(new Request('https://fixture.test',{method:'POST',headers:{'content-type':'application/json',origin:'https://ride24.pl'},body:JSON.stringify(body)}));
    if(!response.ok)return{data:null,error:{context:response}};
    return{data:await response.json(),error:null};
  }},
  from:table=>({select:()=>{
    if(table==='partner_locations')return Promise.resolve({data:locations,error:null});
    return{order:()=>Promise.resolve({data:state.guides,error:null})};
  }}),
};
w.loadGuideLocations=async()=>{state.locationsRefreshes++;};
w.eval(original.slice(original.indexOf('async function loadGuides()'),original.indexOf('async function loadGuideLocations()')));
w.eval(readFileSync(new URL('../../assets/js/admin-travel-guides.js',import.meta.url),'utf8'));
const $=id=>w.document.getElementById(id);
const event={preventDefault(){}};
const checks=[];
async function test(name,fn){await fn();checks.push(name);}
function file(name,bytes){Object.defineProperty($('guide-html-file'),'files',{configurable:true,value:[{name,size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}]});w.onGuideFileSelected();}

await test('all guide form IDs are unique after replacing the old modal',async()=>{
  for(const id of ['guide-title','guide-slug','guide-html-file','guide-upload-form'])assert.equal(w.document.querySelectorAll('#'+id).length,1);
  assert.equal($('guide-modal'),null);assert.equal(original.includes('Jak dodać nowy Autoprzewodnik?'),false);
});
await test('missing connection opens setup and disables publishing',async()=>{
  await w.loadGuideUploadStatus();assert.equal($('guide-github-setup').open,true);assert.equal($('guide-upload-button').disabled,true);
});
await test('one-time token setup clears the field and enables publishing',async()=>{
  $('guide-github-token').value='github_pat_'+'fixture'.repeat(5);await w.configureGuideGithub(event);
  assert.equal($('guide-github-token').value,'');assert.equal($('guide-upload-button').disabled,false);assert.equal($('guide-github-setup').open,false);
});
const html='\uFEFF<!doctype html><html lang="pl"><body>Żółć — trasy<button onclick="alert(1)">Mapa</button></body></html>';
await test('filename autofills title and a safe lowercase destination',async()=>{
  file('Varna.html',Buffer.from(html));assert.equal($('guide-title').value,'Varna');assert.equal($('guide-slug').value,'varna');
  assert.equal($('guide-destination').textContent,'/travel-guides/varna.html');
});
await test('full form submission publishes unchanged UTF-8 including BOM, registers and refreshes',async()=>{
  await w.saveGuide(event);assert.equal(state.files.get('/repos/expol1/ride24/contents/travel-guides/varna.html'),html);
  assert.equal(state.guides.length,1);assert.equal(state.locationsRefreshes,1);assert.equal($('guide-title').value,'');
  assert.match($('guide-upload-message').textContent,/zapisany w GitHub/);assert.equal($('guide-upload-button').disabled,false);
});
await test('guide list shows five columns and correct assignment count',async()=>{
  const cells=$('guides-tbody').querySelectorAll('tr:first-child td');assert.equal(cells.length,5);assert.equal(cells[3].textContent,'2');
  assert.equal(cells[4].querySelector('a').getAttribute('href'),'/travel-guides/varna.html');
});
await test('guide titles render as text, never executable markup',async()=>{
  state.guides[0].title='<img src=x onerror=alert(1)>';await w.loadGuides();
  assert.equal($('guides-tbody').querySelector('img'),null);assert.equal($('guides-tbody').querySelector('td').textContent,state.guides[0].title);
  state.guides[0].title='Varna';
});
await test('existing file collision keeps original HTML and displays a safe error',async()=>{
  file('Varna.html',Buffer.from('<html><body>Different content</body></html>'));await w.saveGuide(event);
  assert.match($('guide-upload-message').textContent,/już istnieje/);assert.equal(state.guides.length,1);
  assert.equal(state.files.get('/repos/expol1/ride24/contents/travel-guides/varna.html'),html);
});
await test('invalid UTF-8 is rejected before calling the server',async()=>{
  file('Bad.html',Buffer.from([0xff,0xfe,0xff]));const requests=state.requests.length;await w.saveGuide(event);
  assert.match($('guide-upload-message').textContent,/UTF-8/);assert.equal(state.requests.length,requests);
});
await test('double-click while reading the file results in one server request',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});
  const bytes=Buffer.from('<html><body>Burgas</body></html>');
  file('Burgas.html',bytes);
  const f=$('guide-html-file').files[0];f.arrayBuffer=async()=>{await waiting;return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);};
  const before=state.requests.length;const first=w.saveGuide(event);await w.saveGuide(event);release();await first;
  assert.equal(state.requests.length-before,1);assert.equal(state.guides.length,2);
});
console.log(JSON.stringify({passed:checks.length,checks,scope:'production HTML form and scripts in DOM; simulated server/GitHub; no real payment or repository writes'}));
dom.window.close();
