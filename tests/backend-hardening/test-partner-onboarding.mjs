// Runs the actual onboarding functions with isolated Auth/SQL/Storage mocks.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../partner-dashboard.html',import.meta.url),'utf8');
const slice=(start,end)=>{const a=html.indexOf(start);assert(a>=0);const b=html.indexOf(end,a);assert(b>a);return html.slice(a,b);};
const code=[slice('async function savePartnerSettings(){','// --- ZAPISYWANIE WIDOCZNOŚCI'),slice('window.updatePartnerPassword = async function()','// --- DEZAKTYWACJA KONTA'),slice('async function signAgreement()','// Funkcja otwierająca podgląd'),slice('async function uploadPartnerDocument(file, type)','function bindVehicleUpload()')].join('\n');
function fixture(options={}){
 const els=new Map(),writes=[],alerts=[],toasts=[],uploads=[];let passwordCalls=0,rpcCalls=0,reloads=0;
 const element=id=>{if(!els.has(id))els.set(id,{value:'',checked:false,disabled:false,style:{},innerHTML:''});return els.get(id);};
 const partner={id:'fixture-partner',company_name:'Fixture',country:'Cyprus',discount_percent:10,agreement_accepted:false};
 const session={user:{id:'fixture-user'}};
 const docs=options.noDocs?{}:{rental_terms_url:'https://fixture.test/terms.pdf',rental_rules_url:'https://fixture.test/rules.pdf'};
 const db={auth:{getSession:async()=>({data:{session}}),updateUser:async()=>{passwordCalls++;return {error:options.authError?new Error('Auth failure'):null};}},
 from(table){let payload;const q={select(){return this;},update(p){payload=p;return this;},eq(field,id){assert.equal(id,session.user.id);return this;},single:async()=>({data:options.emptyDocs?{}:docs}),then(resolve){if(payload)writes.push({table,payload});return Promise.resolve({data:payload?[{id:partner.id}]:docs,error:options.saveError?new Error('Database unavailable'):null}).then(resolve);}};return q;},
 rpc:async(name,args)=>{rpcCalls++;assert.equal(name,'partner_accept_agreement');assert.equal(args.p_version,'v1.1');assert.equal(JSON.parse(args.p_snapshot).company,'Fixture');return {data:!options.rpcError,error:options.rpcError?new Error('Agreement unavailable'):null};},
 storage:{from(bucket){assert.equal(bucket,'partner-documents');return {upload:async(path,file)=>{uploads.push(path);return {error:null};},getPublicUrl:path=>({data:{publicUrl:'https://fixture.test/'+path}})};}}};
 const location={reload(){reloads++;}};const window={showToast:(...x)=>toasts.push(x),location};
 // Presentation bindings are exercised in test-partner-languages.mjs. This fixture checks Auth/SQL/Storage ordering.
 const partnerText=(pl,en)=>options.lang==='pl'?pl:en;
 const partnerLabel=(el,pl,en)=>{el.innerText=partnerText(pl,en);return el;};
 const c=vm.createContext({window,document:{getElementById:element,querySelector:()=>element('settings-button'),body:{style:{}}},db,localStorage:{getItem:()=>options.lang||'en'},setTimeout:fn=>fn(),location,console:{log(){},error(){},warn(){}},alert:x=>alerts.push(x),fetch:async()=>({json:async()=>({ip:'192.0.2.1'})}),navigator:{userAgent:'isolated-test'},partnerData:partner,currentAgLang:'en',agreementTexts:{en:{alertError:'Accept first',btnLoading:'Saving',btnDefault:'Sign'},pl:{alertError:'Zaakceptuj najpierw',btnLoading:'Zapisywanie',btnDefault:'Podpisz'}},getPartnerLang:()=>options.lang||'en',partnerText,partnerLabel,loadPartnerSettings:async()=>{}});
 vm.runInContext(code,c);
 for(const [id,value] of Object.entries({partnerCompany:'Fixture',partnerAddress:'Fixture street',partnerCountry:'Cyprus',partnerRegion:'Paphos',partnerPhone:'123456789',partnerEmergency:'', 'partner-min-age':'21','new-partner-pwd':'FixturePass123!','confirm-partner-pwd':'FixturePass123!'}))element(id).value=value;
 element('force-terms-group').style.display='block';element('force-terms-checkbox').checked=true;
 element('accept-cb').checked=true;element('ag-content').innerHTML='<p>'+('Fixture agreement content. '.repeat(5))+'</p>';
 return {c,window,element,writes,alerts,toasts,uploads,partner,get counts(){return {passwordCalls,rpcCalls,reloads};}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
await test('password changes before clearing the forced-change flag',async()=>{const f=fixture();await f.window.updatePartnerPassword();assert.equal(f.counts.passwordCalls,1);assert.equal(f.writes[0].payload.must_change_password,false);});
await test('mismatched passwords never call Auth',async()=>{const f=fixture();f.element('confirm-partner-pwd').value='other';await f.window.updatePartnerPassword();assert.equal(f.counts.passwordCalls,0);});
await test('first-login checkbox is required',async()=>{const f=fixture();f.element('force-terms-checkbox').checked=false;await f.window.updatePartnerPassword();assert.equal(f.counts.passwordCalls,0);});
await test('Auth failure preserves password flag and enables retry',async()=>{const f=fixture({authError:true});await f.window.updatePartnerPassword();assert.equal(f.writes.length,0);assert.equal(f.element('savePwdBtn').disabled,false);});
await test('incomplete profile is not saved',async()=>{const f=fixture();f.element('partnerAddress').value='';await f.c.savePartnerSettings();assert.equal(f.writes.length,0);});
await test('both rental PDFs are required before profile completion',async()=>{const f=fixture({noDocs:true});await f.c.savePartnerSettings();assert.equal(f.writes.length,0);});
await test('complete profile is saved without accepting agreement',async()=>{const f=fixture();await f.c.savePartnerSettings();assert.equal(f.writes[0].payload.profile_completed,true);assert.equal(f.writes[0].payload.agreement_accepted,undefined);assert.equal(f.counts.rpcCalls,0);});
for(const lang of ['pl','en'])await test('save failure displays actual error and restores retry in '+lang,async()=>{const f=fixture({saveError:true,lang});await f.c.savePartnerSettings();assert.ok(f.alerts[0].includes('Database unavailable'));assert.equal(f.element('settings-button').disabled,false);assert.equal(f.counts.reloads,0);});
await test('agreement cannot be submitted without explicit checkbox',async()=>{const f=fixture();f.element('accept-cb').checked=false;await f.c.signAgreement();assert.equal(f.counts.rpcCalls,0);});
await test('agreement submits snapshot once and updates UI after success',async()=>{const f=fixture();await f.c.signAgreement();await f.c.signAgreement();assert.equal(f.counts.rpcCalls,1);assert.equal(f.partner.agreement_accepted,true);});
await test('agreement error preserves unsigned state and enables retry',async()=>{const f=fixture({rpcError:true});await f.c.signAgreement();assert.equal(f.partner.agreement_accepted,false);assert.equal(f.element('sign-btn').disabled,false);});
await test('PDF upload writes only the signed-in partner path',async()=>{const f=fixture({emptyDocs:true});await f.c.uploadPartnerDocument({type:'application/pdf',size:100},'terms');assert.deepEqual(f.uploads,['fixture-user/terms.pdf']);assert.equal(f.writes[0].payload.rental_terms_url,'https://fixture.test/fixture-user/terms.pdf');});
await test('invalid and oversized documents are rejected',async()=>{const f=fixture({emptyDocs:true});await f.c.uploadPartnerDocument({type:'text/html',size:100},'terms');await f.c.uploadPartnerDocument({type:'application/pdf',size:6*1024*1024},'rules');assert.equal(f.uploads.length,0);});
console.log(JSON.stringify({passed,scope:'isolated onboarding functions; no production accounts, signatures, files or emails changed'}));
