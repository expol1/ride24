import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../../assets/helper/turnstileWidget.js',import.meta.url),'utf8');
function page(){
 const dom=new JSDOM('<div id="m" style="display:none"><div data-ride24-turnstile></div></div>',{url:'https://ride24.pl/',runScripts:'outside-only'});
 const w=dom.window,calls={render:[],reset:[]};
 w.turnstile={render(el,opts){calls.render.push(opts);return 'w'+calls.render.length;},reset(id){calls.reset.push(id);},
  getResponse(){return calls.token??null;},isExpired(){return false;}};
 w.localStorage.setItem('lang','en');
 w.setTimeout=fn=>{fn();return 0;};
 w.eval(source);
 return {w,calls,el:w.document.querySelector('[data-ride24-turnstile]')};
}

test('renders one explicit widget per container, unscaled and in the page language',async()=>{
 const {w,calls,el}=page();
 await w.Ride24Turnstile.mount(el);await w.Ride24Turnstile.mount(el);
 assert.equal(calls.render.length,1);
 const o=calls.render[0];
 assert.equal(o.sitekey,'0x4AAAAAACu2gUuoR8cE8lAv');assert.equal(o.size,'flexible');assert.equal(o.language,'en');
 assert.equal(o['refresh-expired'],'auto');assert.equal(o['response-field'],false);
});

test('recovers from transient Turnstile errors, then hands over after repeated failures',async()=>{
 const {w,calls,el}=page();await w.Ride24Turnstile.mount(el);
 const o=calls.render[0];
 assert.equal(o['error-callback']('600010'),true);assert.deepEqual(calls.reset,['w1']);
 o['error-callback']('600010');o['error-callback']('600010');
 assert.equal(o['error-callback']('600010'),false);
 assert.equal(el.getAttribute('data-error'),'600010');
});

test('returns the token of this widget only and resets exactly that widget after use',async()=>{
 const {w,calls,el}=page();
 assert.equal(w.Ride24Turnstile.token(el),null);
 await w.Ride24Turnstile.mount(el);
 calls.render[0].callback('tok-1');calls.token='tok-1';
 assert.equal(w.Ride24Turnstile.token(el),'tok-1');
 w.Ride24Turnstile.reset(el);assert.deepEqual(calls.reset,['w1']);
});
