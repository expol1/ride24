import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import ts from 'typescript';

const read = name => readFileSync(new URL('../../'+name,import.meta.url),'utf8');
const html=read('admin/index.html');
const css=read('assets/css/admin-partner-create-result.css');
const modalHtml=html.slice(
    html.indexOf('<!-- Wynik tworzenia konta B2B.'),
    html.indexOf('<div id="addPartnerModal"')
);
const helper=html.slice(
    html.indexOf('window.showAdminPartnerCreateResult = function('),
    html.indexOf('window.processAddPartner = async function()')
);
const create=html.slice(
    html.indexOf('window.processAddPartner = async function()'),
    html.indexOf('window.togglePartnerType = function')
);
function setup(){
    const dom=new JSDOM('<!doctype html><html><body>'+modalHtml+'</body></html>',{
        runScripts:'outside-only',
        url:'https://ride24.pl/admin/'
    });
    dom.window.eval(helper);
    return dom;
}

test('new B2B result modal is isolated, accessible, responsive and hidden initially',()=>{
    const mainHead = html.slice(0,html.indexOf('</head>'));
    assert.match(mainHead,/<link rel="stylesheet" href="\.\.\/assets\/css\/admin-partner-create-result\.css\?v=[^"]+">/);
    assert.equal((html.match(/admin-partner-create-result\.css/g)||[]).length,1);
    assert.ok(modalHtml.includes('role="dialog" aria-modal="true"'));
    assert.equal((html.match(/id="adminPartnerResultModal"/g)||[]).length,1);
    assert.match(css,/#adminPartnerResultModal\[hidden\]\s*\{display:none!important;/);
    assert.match(css,/#adminPartnerResultModal\.is-error \.admin-partner-result-header/);
    assert.match(css,/@media\(max-width:540px\)/);
    const dom=setup();
    assert.equal(dom.window.document.getElementById('adminPartnerResultModal').hidden,true);
    dom.window.close();
});
test('success result is green and preserves notices without allowing HTML injection',()=>{
    const dom=setup(),w=dom.window,d=w.document;
    w.showAdminPartnerCreateResult({
        type:'success',
        partnerName:'Rental <b>Car2hire</b>',
        notices:['Nie dołączono PDF-ów (partner może je wgrać samodzielnie).']
    });
    const m=d.getElementById('adminPartnerResultModal');
    assert.equal(m.hidden,false);
    assert.equal(m.classList.contains('is-error'),false);
    assert.equal(d.getElementById('adminPartnerResultIcon').textContent,'✅');
    assert.match(d.getElementById('adminPartnerResultMessage').textContent,/Rental <b>Car2hire<\/b>/);
    assert.equal(d.getElementById('adminPartnerResultMessage').querySelector('b'),null);
    assert.equal(d.getElementById('adminPartnerResultNotices').children.length,1);
    assert.equal(d.getElementById('adminPartnerResultNotices').children[0].classList.contains('is-warning'),false);
    w.closeAdminPartnerCreateResult();
    assert.equal(m.hidden,true);
    dom.window.close();
});
test('partial PDF or welcome-email failure remains green with an amber warning',()=>{
    const dom=setup(),w=dom.window,d=w.document;
    w.showAdminPartnerCreateResult({
        type:'success',partnerName:'Demo',
        notices:['UWAGA: Konto zostało utworzone, ale upload PDF nie powiódł się.',
                 'UWAGA: Nie udało się wysłać e-maila powitalnego.']
    });
    const m=d.getElementById('adminPartnerResultModal');
    assert.equal(m.classList.contains('is-error'),false);
    const notes=[...d.getElementById('adminPartnerResultNotices').children];
    assert.equal(notes.length,2);
    assert.ok(notes.every(el=>el.classList.contains('is-warning')));
    dom.window.close();
});
test('validation and server errors use the red result without claiming creation succeeded',()=>{
    const dom=setup(),w=dom.window,d=w.document;
    w.showAdminPartnerCreateResult({type:'error',message:'Email już istnieje.'});
    const m=d.getElementById('adminPartnerResultModal');
    assert.equal(m.classList.contains('is-error'),true);
    assert.equal(d.getElementById('adminPartnerResultIcon').textContent,'❌');
    assert.match(d.getElementById('adminPartnerResultTitle').textContent,/Nie udało się/);
    assert.equal(d.getElementById('adminPartnerResultMessage').textContent,'Email już istnieje.');
    assert.match(create,/if \(!response\.ok\)\s*\{\s*throw new Error/);
    assert.match(create,/type: "error"/);
    assert.ok(!create.includes('alert("Partner " + data.company_name'));
    assert.match(create,/type: "success"/);
    assert.match(create,/redirectOnClose: true/);
    w.closeAdminPartnerCreateResult();
    assert.equal(m.hidden,true);
    dom.window.close();
});
test('B2B account, document upload, refresh and button reset keep their original paths',()=>{
    const required=[
        'const data = {','const response = await fetch(',
        'functions/v1/admin-create-partner','const result = await response.json()',
        'await uploadAdminPartnerPdfs(result.partner_id, selectedTermsPdf, selectedRulesPdf)',
        'closeAddPartnerModal();','loadPartnersData();',
        'btn.disabled = false;','btn.innerText = "Utwórz Partnera";'
    ];
    for(const term of required)assert.ok(create.includes(term), 'Missing original B2B behavior: '+term);
    assert.ok(create.indexOf('closeAddPartnerModal();')<create.lastIndexOf('type: "success"'),
        'Creation form should close before success modal opens');
    assert.ok(!create.includes('window.location.href = "../index.html";'),
        'Expired-session redirect must wait until error dialog is acknowledged');
    assert.ok(html.includes('window.location.href = "../index.html";'),
        'Authentication redirect must remain available after acknowledgement');
});
test('existing admin JavaScript parses without syntax errors',()=>{
    const start=html.indexOf('    <script>\n',html.indexOf('<script src="../assets/js/admin-smart-search'));
    const end=html.indexOf('    </script>',start);
    assert.ok(start!==-1 && end>start,'Admin inline JS not found');
    const source=html.slice(start+'    <script>\n'.length,end);
    const parsed=ts.createSourceFile('admin.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    assert.deepEqual(parsed.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText,'\n')),[]);
});
