import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import ts from 'typescript';

const html=readFileSync(new URL('../../partner-dashboard.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../../docs/standard-partnership-agreement-v2.0.txt',import.meta.url),'utf8');
const parsed=new JSDOM(html);
const script=[...parsed.window.document.scripts].find(s=>s.textContent.includes('function renderAgreement(')).textContent;
const ast=ts.createSourceFile('panel.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function extract(name){
 for(const n of ast.statements){
  if(ts.isFunctionDeclaration(n)&&n.name?.text===name)return n.getText(ast);
  if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name))return n.getText(ast);
 }
 throw Error(name);
}
function fixture(extra={}){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 const partner={id:'test-only',company_name:'Fixture & Company',address:'Fixture street',country:'Poland',region:'Test region',currency:'EUR',email:'fixture@example.test',phone:'123',representative_name:'Test',representative_surname:'Representative',discount_percent:0,...extra};
 const calls=[];
 w.__partner=partner;
 w.__db={auth:{getSession:async()=>({data:{session:{user:{id:'test-user'}}}})},rpc:async(name,args)=>{calls.push({name,args});return {data:true};}};
 w.alert=()=>{};w.fetch=async()=>({json:async()=>({ip:'192.0.2.1'})});w.setTimeout=()=>0;w.showToast=()=>{};
 w.eval(`let partnerData=window.__partner; const db=window.__db; let currentAgLang='en';
 function getPartnerLang(){return 'en'}
 function partnerText(pl,en){return en}
 function partnerLabel(el,pl,en){el.textContent=en}
 ${['agreementTexts','escapeHtmlValue','sanitizeAgreementHtml','renderAgreement','toggleSignButton','signAgreement','showSignedAgreement'].map(extract).join('\n')}`);
 return {dom,w,partner,calls,content:()=>w.document.getElementById('ag-content')};
}
test('new and pending partners see every supplied clause, all 17 sections and 0% with populated details',()=>{
 for(const accepted of [undefined,false]){
  const f=fixture({agreement_accepted:accepted});
  try{
   f.w.renderAgreement('pl');
   const el=f.content();
   assert.equal(el.querySelectorAll('h3').length,17);
   for(const line of source.split('\n').filter(l=>/^\d+\. /.test(l))){
    const clause=line.replace(/^\d+\. /,'').replace('[Discount %]','0%');
    assert.ok(el.textContent.includes(clause),clause);
   }
   for(const value of ['Fixture & Company','Test Representative','fixture@example.test','Fixture street','Poland','Currency: EUR','Agreed Partner Discount: 0%','v2.0'])assert.ok(el.textContent.includes(value),value);
   assert.equal(f.calls.length,0);
  }finally{f.dom.window.close()}
 }
});
test('signing test account submits v2.0 and the exact displayed HTML with electronic evidence',async()=>{
 const f=fixture();
 try{
  f.w.renderAgreement('en');const displayed=f.content().innerHTML;
  await f.w.signAgreement();assert.equal(f.calls.length,0);
  f.w.document.getElementById('accept-cb').checked=true;f.w.toggleSignButton();
  await f.w.signAgreement();
  assert.equal(f.calls.length,1);const {name,args}=f.calls[0];
  assert.equal(name,'partner_accept_agreement');assert.equal(args.p_version,'v2.0');
  const snapshot=JSON.parse(args.p_snapshot);
  assert.equal(snapshot.content,displayed);assert.equal(snapshot.version,'v2.0');assert.equal(snapshot.lang,'en');assert.equal(snapshot.discount,0);assert.equal(snapshot.currency,'EUR');
  assert.ok(Number.isFinite(Date.parse(snapshot.signed_at)));assert.equal(snapshot.ip,'192.0.2.1');assert.ok(snapshot.user_agent);
 }finally{f.dom.window.close()}
});
test('partner values cannot inject or alter agreement markup',()=>{
 const f=fixture({company_name:'<h3>Fake clause</h3><script>alert(1)</script>'});
 try{f.w.renderAgreement('en');assert.equal(f.content().querySelectorAll('h3').length,17);assert.equal(f.content().querySelectorAll('script').length,0);assert.ok(f.content().textContent.includes('<h3>Fake clause</h3>'));}finally{f.dom.window.close()}
});
test('custom agreements bypass standard rendering and signing; pending or failed loads block signing',async()=>{
 for(const flags of [{custom_agreement_document:{sha256:'test'}},{custom_agreement_pending:true},{custom_agreement_load_failed:true}]){
  const f=fixture(flags);let renders=0,signs=0;
  f.w.Ride24CustomAgreement={render:()=>renders++,sign:()=>signs++,isReady:()=>true};
  try{f.w.renderAgreement('en');await f.w.signAgreement();assert.equal(f.calls.length,0);
   if(flags.custom_agreement_document){assert.equal(renders,1);assert.equal(signs,1)}else assert.equal(f.w.document.getElementById('sign-btn').disabled,true);
  }finally{f.dom.window.close()}
 }
});
test('signed v1.3 preview uses its original snapshot unchanged',()=>{
 const snapshot=JSON.stringify({version:'v1.3',lang:'en',content:'<p>Original signed v1.3 terms</p>'});
 const f=fixture({agreement_accepted:true,agreement_snapshot:snapshot});
 try{f.w.showSignedAgreement();assert.equal(f.w.document.getElementById('signed-agreement-content').innerHTML,JSON.parse(snapshot).content);assert.equal(f.partner.agreement_snapshot,snapshot);assert.equal(f.calls.length,0)}finally{f.dom.window.close()}
});
