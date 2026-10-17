import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {JSDOM} from 'jsdom';

const dashboard = readFileSync(new URL('../../partner-dashboard.html', import.meta.url), 'utf8');
const code = readFileSync(new URL('../../assets/helper/partnerGuide.js', import.meta.url), 'utf8');
const manual = JSON.parse(readFileSync(new URL('../../assets/partner-guide/manual.json', import.meta.url), 'utf8'));
const modalHTML = dashboard.slice(dashboard.indexOf('  <div class="guide-overlay"'), dashboard.indexOf('    <div id="toast-container">'));
const hooks = dashboard.slice(dashboard.indexOf('        // --- GUIDE MODAL LOGIC ---'), dashboard.indexOf('        // ==========================================', dashboard.indexOf('        // --- GUIDE MODAL LOGIC ---')));

function setup({lang = 'pl', api = false, fetcher, saved} = {}) {
    const dom = new JSDOM('<!doctype html><html lang="'+lang+'"><body style="overflow:auto"><button id="open">Open</button>'+modalHTML+'</body></html>', {
        url: 'https://ride24.pl/partner-dashboard.html', runScripts: 'outside-only'
    });
    const {window: w} = dom;
    const requests = [];
    w.localStorage.setItem('partner_lang', lang);
    w.localStorage.setItem('sb-test-auth-token', 'unchanged');
    if (saved) w.localStorage.setItem('ride24_partner_guide_language', saved);
    w.fetch = async (url, options) => {
        requests.push({url:String(url), options});
        if (fetcher) return fetcher(url, options);
        return {ok:true, json:async () => structuredClone(manual)};
    };
    // jsdom has no layout. Supply visibility for the keyboard trap, including mobile controls.
    w.HTMLElement.prototype.getClientRects = function () { return [{}]; };
    w.eval(code);
    w.eval('const partnerData = {provider_type:' + JSON.stringify(api ? 'api' : 'local') + '}; function getPartnerLang(){return localStorage.getItem("partner_lang");}' + hooks);
    // outside-only intentionally skips inline HTML handlers; wire the actual close attribute.
    const close = w.document.querySelector('.guide-close');
    close.addEventListener('click', () => w.eval(close.getAttribute('onclick')));
    const open = w.document.getElementById('open');
    open.focus();
    return {dom, w, document:w.document, requests, open, guide:w.Ride24PartnerGuide};
}

test('all PDF languages, chapters and screenshots are complete; content loads only on open', async () => {
    const {dom,w,document:d,requests,guide} = setup();
    try {
        assert.equal(requests.length,0);
        assert.equal(d.querySelectorAll('#guideModal img').length,0);
        await w.openGuide();
        assert.equal(requests.length,1);
        assert.equal(requests[0].options.credentials,'omit');
        assert.match(requests[0].url,/assets\/partner-guide\/manual\.json/);
        assert.equal(Object.keys(manual.languages).length,8);
        assert.equal(Object.keys(manual.images).length,22);
        assert.equal(d.querySelectorAll('#guideNavigation button').length,24);
        const picker = d.getElementById('guideLanguage');
        for (const [lang,locale] of Object.entries(manual.languages)) {
            picker.value=lang; picker.dispatchEvent(new w.Event('change'));
            assert.equal(d.getElementById('guideModal').lang,lang);
            assert.equal(d.getElementById('guideTitle').textContent,locale.ui.title);
            for (const chapter of locale.chapters.filter(ch=>ch.audience!=='api')) {
                guide.goTo(chapter.id);
                assert.equal(d.querySelector('#guideContent h3').textContent,chapter.title);
                for (const paragraph of chapter.paragraphs) assert.ok(d.getElementById('guideContent').textContent.includes(paragraph));
                assert.equal(d.querySelectorAll('#guideContent img').length,chapter.image?1:0);
                if (chapter.image) {
                    const image = manual.images[chapter.image];
                    assert.ok(existsSync(new URL('../../assets/partner-guide/'+image.src,import.meta.url)));
                    assert.equal(Number(d.querySelector('#guideContent img').getAttribute('width')),image.width);
                }
            }
        }
        assert.equal(requests.length,1);
        assert.ok(requests.every(r=>r.options.method===undefined));
    } finally {dom.window.close();}
});

test('manual choice persists independently of panel language and authentication', async () => {
    const {dom,w,document:d} = setup({saved:'it'});
    try {
        await w.openGuide();
        assert.equal(d.getElementById('guideLanguage').value,'it');
        const picker=d.getElementById('guideLanguage');picker.value='de';picker.dispatchEvent(new w.Event('change'));
        w.closeGuide();await w.openGuide();
        assert.equal(d.getElementById('guideLanguage').value,'de');
        assert.equal(w.localStorage.getItem('ride24_partner_guide_language'),'de');
        assert.equal(w.localStorage.getItem('partner_lang'),'pl');
        assert.equal(w.localStorage.getItem('sb-test-auth-token'),'unchanged');
        assert.equal(d.documentElement.lang,'pl');
    } finally {dom.window.close();}
});

test('API partners keep API guidance and do not receive manual fleet configuration instructions', async () => {
    const {dom,w,document:d,guide} = setup({api:true});
    try {
        await w.openGuide();
        assert.equal(d.querySelectorAll('#guideNavigation button').length,18);
        assert.equal(d.querySelector('[data-chapter="fleet"]'),null);
        assert.equal(d.querySelector('[data-chapter="extras"]'),null);
        assert.ok(d.querySelector('.r24-guide-note').textContent.includes('API'));
        guide.goTo('api');assert.ok(d.querySelector('#guideContent h3').textContent.includes('API'));
        guide.setPartnerType(false);
        assert.equal(d.querySelector('[data-chapter="api"]'),null);
        assert.ok(d.querySelector('[data-chapter="fleet"]'));
        assert.equal(d.querySelector('#guideContent h3').textContent,manual.languages.pl.chapters[0].title);
    } finally {dom.window.close();}
});

test('failed loading can be retried; malformed data is rejected without breaking the modal', async () => {
    let attempt=0;
    const {dom,w,document:d} = setup({fetcher:async()=>{
        attempt++;
        if(attempt===1)throw Error('Offline');
        if(attempt===2)return {ok:true,json:async()=>({languages:{}})};
        return {ok:true,json:async()=>structuredClone(manual)};
    }});
    try {
        await w.openGuide();
        assert.ok(d.querySelector('[role="alert"]'));
        d.querySelector('#guideContent button').click();
        await new Promise(resolve=>setTimeout(resolve,0));
        assert.ok(d.querySelector('[role="alert"]'));
        d.querySelector('#guideContent button').click();
        await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(attempt,3);
        assert.ok(d.querySelector('#guideContent h3'));
        assert.equal(d.getElementById('guideModal').getAttribute('aria-hidden'),'false');
    } finally {dom.window.close();}
});

test('close, Escape and keyboard navigation preserve focus and page scroll', async () => {
    const {dom,w,document:d,open,guide} = setup();
    try {
        await w.openGuide();
        assert.equal(d.body.style.overflow,'hidden');
        assert.equal(d.activeElement.id,'guideLanguage');
        guide.goTo('help');
        const support=d.querySelector('#guideContent a');support.focus();
        d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
        assert.equal(d.activeElement.className,'guide-close');
        d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        assert.equal(d.getElementById('guideModal').getAttribute('aria-hidden'),'true');
        assert.equal(d.getElementById('guideModal').classList.contains('active'),false);
        assert.equal(d.body.style.overflow,'auto');
        assert.equal(d.activeElement,open);
        await w.openGuide();
        d.querySelector('.guide-close').click();
        assert.equal(d.body.style.overflow,'auto');
    } finally {dom.window.close();}
});

test('screenshots enlarge inside the same modal and a failed image can be retried', async () => {
    const {dom,w,document:d,guide} = setup();
    try {
        await w.openGuide();guide.goTo('dashboard');
        const image=d.querySelector('#guideContent img');
        const button=d.querySelector('.r24-guide-caption button');button.click();
        assert.equal(button.getAttribute('aria-pressed'),'true');
        assert.ok(d.querySelector('.r24-guide-zoomed'));
        button.click();assert.equal(button.getAttribute('aria-pressed'),'false');
        image.dispatchEvent(new w.Event('error'));
        assert.equal(image.hidden,true);
        const retry=d.querySelector('.r24-guide-image-viewport button');retry.click();
        assert.equal(image.hidden,false);
        assert.match(image.src,/retry=/);
        assert.equal(d.getElementById('guideModal').classList.contains('active'),true);
    } finally {dom.window.close();}
});

test('dashboard inline scripts remain syntactically valid', () => {
    for (const match of dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if(match[1].trim()) new vm.Script(match[1]);
    }
});
