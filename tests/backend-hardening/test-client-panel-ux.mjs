import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import ts from 'typescript';

const read = path => readFileSync(new URL('../../' + path,import.meta.url),'utf8');
const html=read('klient.html');
const dom=new JSDOM(html);
const doc=dom.window.document;
const bookingsCss=read('assets/css/client-panel-ux.css');
const androidCss=read('assets/css/client-android-showcase.css');

test('client booking, dashboard and payment sections still have all original columns',()=>{
    const cols=['view-dashboard','view-bookings','view-payments'].map(id=>{
        const section=doc.getElementById(id);
        assert.ok(section,'Missing client section: '+id);
        assert.ok(section.querySelector('table tbody'));
        return section.querySelectorAll('table thead th').length;
    });
    assert.deepEqual(cols,[8,8,4]);
    assert.ok(doc.getElementById('dashboard-bookings-tbody'));
    assert.ok(doc.getElementById('bookings-tbody'));
    assert.ok(doc.getElementById('payments-tbody'));
    for(let i=1;i<=8;i++)assert.ok(bookingsCss.includes('tbody td:nth-child('+i+')'),'Missing mobile booking field '+i);
    for(let i=1;i<=4;i++)assert.ok(bookingsCss.includes('#view-payments .table-container tbody td:nth-child('+i+')'),'Missing mobile payment field '+i);
    assert.match(bookingsCss,/tr:has\(>td\[colspan\]\)/);
    assert.match(bookingsCss,/@media\(max-width:980px\)/);
});
test('unchanged actions remain available for every booking and refund state',()=>{
    for(const fn of ['submitBooking()','window.cancelBooking(','goToPayment(','window.downloadVoucher(','window.openGuide(','window.downloadReceipt(','window.requestReceipt(','openClientPriceBreakdown(','window.openDetailsModal(','handleRefundClick(','cancelWithoutRefund('])
        assert.ok(html.includes(fn),'Missing existing action: '+fn);
    const r=html.slice(html.indexOf('const rowHtml = '),html.indexOf('dashTbody.innerHTML += rowHtml'));
    assert.equal((r.match(/<td\b/g)||[]).length,8,'Booking row lost a field');
    assert.match(r,/window\.openDetailsModal/);
    assert.doesNotMatch(r,/r24-client-price-open/,'Redundant second modal trigger still appears');
    for(const status of ['pending','accepted','awaiting_payment','paid','cancelled','rejected','expired','payment_expired'])
        assert.ok(html.includes(status),'Missing state '+status);
    const payments=html.slice(html.indexOf('window.loadPayments ='),html.indexOf('window.goToHome ='));
    const row=payments.slice(payments.indexOf('tbody.innerHTML += `'),payments.indexOf('`;\n        });',payments.indexOf('tbody.innerHTML += `')));
    assert.equal((row.match(/<td\b/g)||[]).length,4,'Payment row lost a field');
    assert.match(payments,/refund_status === "completed"/);
    assert.match(payments,/refund_status === "pending"/);
});
test('one rental detail window preserves partner documents and original itemised price items',()=>{
    const code=html.slice(html.indexOf('window.openDetailsModal = function('),html.indexOf('window.closeDetailsModal = function('));
    for(const s of ['deposit','mileage','driverIncluded','driverHours','partnerTermsSnapshot','partnerRulesSnapshot','bookingId'])
        assert.ok(code.includes(s),'Missing original rental info '+s);
    assert.match(code,/window\.openClientPriceBreakdown\(bookingId, priceSection\)/);
    assert.match(code,/pricing_items_snapshot/);
    for(const s of ['snapshot.items','snapshot.loyalty_discount_cents','snapshot.total_cents','snapshot.online_pln_cents','snapshot.partner_cents','booking.deposit_snapshot'])
        assert.ok(code.includes(s),'Missing cost component: '+s);
    assert.match(code,/inlineTarget\.replaceChildren/);
    assert.match(code,/!inlineTarget && !valid/);
    assert.match(code,/Number\(booking\.online_payment_pln\)/,'Legacy bookings must show recorded online amount');
    assert.match(code,/Number\(booking\.pickup_payment_partner_currency\)/,'Legacy bookings must show partner amount');
    assert.ok(doc.getElementById('bookingDetailsModal'));
    assert.ok(doc.getElementById('bookingDetailsBody'));
    assert.match(bookingsCss,/\.r24-unified-pricing \.r24-client-price-body \{padding:0!important;max-height:none!important;overflow:visible!important\}/);
});
test('client Android marketing is bilingual and the Play Store action remains unchanged',()=>{
    const section=doc.getElementById('view-android');
    assert.ok(section.querySelector('.r24-capp-phone'));
    assert.equal(section.querySelectorAll('.r24-capp-feature').length,3);
    for(const el of section.querySelectorAll('[data-pl][data-en]')){
        assert.ok(el.getAttribute('data-pl')?.trim());
        assert.ok(el.getAttribute('data-en')?.trim());
    }
    const button=section.querySelector('.r24-capp-play');
    assert.equal(button?.getAttribute('onclick'),"window.openClientAndroidPlay('client_tab')");
    assert.ok(html.includes('window.openClientAndroidPlay'));
    assert.match(androidCss,/pl_badge_web_generic.png/);
    assert.match(androidCss,/en_badge_web_generic.png/);
    const img=section.querySelector('.r24-capp-screen img');
    assert.equal(img?.getAttribute('src'),'assets/app-promo/client-app-screen-20261029.svg');
    const svg=read('assets/app-promo/client-app-screen-20261029.svg');
    const data=svg.match(/base64,([^"]+)/)?.[1];
    assert.ok(data?.length>3000,'Embedded user screenshot missing');
    const bytes=Buffer.from(data,'base64');
    assert.equal(bytes.subarray(0,4).toString('ascii'),'RIFF');
    assert.equal(bytes.subarray(8,12).toString('ascii'),'WEBP');
});
test('client JavaScript syntax parses and selectors are limited to requested sections',()=>{
    const modules=[...doc.querySelectorAll('script[type="module"]')].map(el=>el.textContent).filter(Boolean);
    assert.ok(modules.length>0);
    for(const [i,src]of modules.entries()){
        const parsed=ts.createSourceFile('client-'+i+'.js',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        assert.deepEqual(parsed.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[],'Client module JS syntax error');
    }
    assert.match(bookingsCss,/#bookingDetailsModal/);
    assert.match(androidCss,/#view-android/);
    assert.ok(doc.querySelector('link[href*="client-panel-ux.css"]'));
    assert.ok(doc.querySelector('link[href*="client-android-showcase.css"]'));
});
dom.window.close();
