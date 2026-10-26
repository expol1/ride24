import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, {url: 'https://ride24.pl/', runScripts: 'outside-only'});
const doc = dom.window.document;

test('mobile partner login disables expensive backdrop blur only inside a mobile media rule', () => {
    const style = doc.querySelector('#ride24-partner-login-mobile-performance');
    assert.ok(style, 'Mobile performance stylesheet missing');
    assert.match(style.textContent, /@media\s*\(max-width:\s*768px\)/);
    assert.match(style.textContent, /#partnerModal\s*\{[^}]*-webkit-backdrop-filter:\s*none\s*!important/s);
    assert.match(style.textContent, /#partnerModal\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
    assert.ok(doc.querySelector('#partnerModal .cf-turnstile'), 'Captcha must remain in the form');
});

test('mobile browser receives proper login field hints without per-keystroke handlers', () => {
    const email = doc.getElementById('partner-email');
    const pass = doc.getElementById('partner-password');
    assert.equal(email.getAttribute('autocomplete'), 'username');
    assert.equal(email.getAttribute('autocapitalize'), 'none');
    assert.equal(email.getAttribute('inputmode'), 'email');
    assert.equal(pass.getAttribute('autocomplete'), 'current-password');
    for (const field of [email, pass]) {
        assert.equal(field.getAttribute('oninput'), null);
        assert.equal(field.getAttribute('onkeyup'), null);
    }
});

const start = html.indexOf('function openPartnerAuth()');
const end = html.indexOf('document.addEventListener("keydown", function(e)', start);
assert.ok(start >= 0 && end > start, 'Partner login functions missing');
const partnerLoginSource = html.slice(start, end);

function fixture({token='test-captcha-token', password='  exact password!  ', error=null} = {}) {
    const sent = [], alerts = [];
    let redirects=0, resets=0;
    const emailField = {value:'  PARTNER@EXAMPLE.COM  '};
    const passwordField = {value:password};
    const button = {disabled:false,innerText:'Zaloguj do panelu partnera'};
    const modal = {style:{display:'none'}};
    const elements = {'partner-email':emailField,'partner-password':passwordField,partnerAuthBtn:button,partnerModal:modal};
    const window = {
        supabaseClient: {auth:{signInWithPassword:async args=>{sent.push(args);return {error};}}},
        turnstile:{reset(){resets++;}}
    };
    const document = {getElementById(id){return elements[id];},body:{style:{overflow:''}},
        querySelector(){return {value:token};}};
    const ctx = vm.createContext({
        window,document,localStorage:{getItem:()=> 'pl'}, alert:message=>alerts.push(message),
        smartRedirect:async()=>{redirects++;}
    });
    vm.runInContext(partnerLoginSource,ctx);
    return {ctx,sent,alerts,button,get redirects(){return redirects;},get resets(){return resets;}};
}

test('partner login sends exact password to Supabase only on submit and retains captcha', async () => {
    const f=fixture();
    assert.equal(f.sent.length,0);
    await f.ctx.partnerLogin();
    assert.equal(f.sent.length,1);
    assert.equal(f.sent[0].email,'partner@example.com');
    assert.equal(f.sent[0].password,'  exact password!  ');
    assert.equal(f.sent[0].options.captchaToken,'test-captcha-token');
    assert.equal(f.redirects,1);
    assert.equal(f.resets,1);
});

test('partner login rejects missing CAPTCHA and restores retry on authentication failure', async () => {
    const missing=fixture({token:''});
    await missing.ctx.partnerLogin();
    assert.equal(missing.sent.length,0);
    const failed=fixture({error:new Error('Invalid login credentials')});
    await failed.ctx.partnerLogin();
    assert.equal(failed.sent.length,1);
    assert.equal(failed.redirects,0);
    assert.equal(failed.button.disabled,false);
    assert.equal(failed.button.innerText,'Zaloguj do panelu partnera');
    assert.equal(failed.resets,1);
});

dom.window.close();
