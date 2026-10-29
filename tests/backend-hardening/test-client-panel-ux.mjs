import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const read = path => readFileSync(new URL('../../' + path,import.meta.url),'utf8');
const html=read('klient.html');
const bookingsCss=read('assets/css/client-panel-ux.css');
const androidCss=read('assets/css/client-android-showcase.css');
const part=(from,to)=>{
    const a=html.indexOf(from);
    const b=html.indexOf(to,a+from.length);
    assert.ok(a>=0 && b>a,'Missing section bounds: '+from);
    return html.slice(a,b);
};
const dashboard=part('<div id="view-dashboard"','<div id="view-android"');
const android=part('<div id="view-android"','<div id="view-bookings"');
const bookings=part('<div id="view-bookings"','<div id="view-payments"');
const payments=part('<div id="view-payments"','<div id="view-profile"');

test('client dashboard, bookings and payments retain all original columns and data containers',()=>{
    for(const [name,section,expected]of [['dashboard',dashboard,8],['bookings',bookings,8],['payments',payments,4]]){
        const head=section.match(/<thead>([\s\S]*?)<\/thead>/)?.[1];
        assert.ok(head,'Missing '+name+' table header');
        assert.equal((head.match(/<th\b/g)||[]).length,expected,name+' table lost a column');
    }
    for(const id of ['dashboard-bookings-tbody','bookings-tbody','payments-tbody'])
        assert.ok(html.includes('id="'+id+'"'),'Missing data container '+id);
    for(let i=1;i<=8;i++)assert.ok(bookingsCss.includes('tbody td:nth-child('+i+')'),'Missing mobile booking cell '+i);
    for(let i=1;i<=4;i++)assert.ok(bookingsCss.includes('#view-payments .table-container tbody td:nth-child('+i+')'),'Missing mobile payment cell '+i);
    assert.match(bookingsCss,/tr:has\(>td\[colspan\]\)/);
    assert.match(bookingsCss,/@media\(max-width:980px\)/);
});
test('all actions still exist for every booking, payment and refund state',()=>{
    for(const fn of ['submitBooking()','window.cancelBooking(','goToPayment(','window.downloadVoucher(','window.openGuide(','window.downloadReceipt(','window.requestReceipt(','openClientPriceBreakdown(','window.openDetailsModal(','handleRefundClick(','cancelWithoutRefund('])
        assert.ok(html.includes(fn),'Existing action missing: '+fn);
    const row=part('const rowHtml = ','dashTbody.innerHTML += rowHtml');
    assert.equal((row.match(/<td\b/g)||[]).length,8,'Generated booking row lost a field');
    assert.match(row,/window\.openDetailsModal/);
    assert.doesNotMatch(row,/r24-client-price-open/,'Extra price dialog trigger should be combined');
    for(const s of ['pending','accepted','awaiting_payment','paid','cancelled','rejected','expired','payment_expired'])
        assert.ok(html.includes(s),'Missing booking status '+s);
    const paymentRenderer=part('window.loadPayments =','window.goToHome =');
    const paymentRow=paymentRenderer.match(/tbody\.innerHTML \+= `\s*<tr>([\s\S]*?)<\/tr>\s*`/)?.[1];
    assert.ok(paymentRow,'Missing payment row template');
    assert.equal((paymentRow.match(/<td\b/g)||[]).length,4,'Generated payment row lost a field');
    assert.match(paymentRenderer,/refund_status === "completed"/);
    assert.match(paymentRenderer,/refund_status === "pending"/);
});
test('unified details retain deposit, mileage, driver, partner documents and saved money snapshots',()=>{
    const details=part('window.openDetailsModal = function(','window.closeDetailsModal = function(');
    for(const s of ['deposit','mileage','driverIncluded','driverHours','partnerTermsSnapshot','partnerRulesSnapshot','bookingId'])
        assert.ok(details.includes(s),'Missing original rental data '+s);
    assert.ok(details.includes('window.openClientPriceBreakdown(bookingId, priceSection)'));
    for(const s of ['snapshot.items','snapshot.loyalty_discount_cents','snapshot.total_cents','snapshot.online_pln_cents','snapshot.partner_cents','booking.deposit_snapshot'])
        assert.ok(details.includes(s),'Missing price component '+s);
    assert.ok(details.includes('inlineTarget.replaceChildren'));
    assert.ok(details.includes('!inlineTarget && !valid'));
    assert.ok(details.includes('Number(booking.online_payment_pln)'),'Older bookings: online amount missing');
    assert.ok(details.includes('Number(booking.pickup_payment_partner_currency)'),'Older bookings: partner amount missing');
    assert.ok(html.includes('id="bookingDetailsModal"'));
    assert.ok(html.includes('id="bookingDetailsBody"'));
    assert.match(bookingsCss,/\.r24-unified-pricing \.r24-client-price-body \{padding:0!important;max-height:none!important;overflow:visible!important\}/);
});
test('Android promotion is bilingual, has the true client screenshot and original Play action',()=>{
    assert.ok(android.includes('class="r24-capp-phone"'));
    assert.equal((android.match(/class="r24-capp-feature"/g)||[]).length,3);
    assert.ok((android.match(/data-pl="/g)||[]).length>=10);
    assert.ok((android.match(/data-en="/g)||[]).length>=10);
    assert.ok(android.includes('onclick="window.openClientAndroidPlay(\'client_tab\')"'));
    assert.match(androidCss,/pl_badge_web_generic.png/);
    assert.match(androidCss,/en_badge_web_generic.png/);
    assert.ok(android.includes('src="assets/app-promo/client-app-screen-20261029.svg"'));
    const svg=read('assets/app-promo/client-app-screen-20261029.svg');
    const data=svg.match(/base64,([^"]+)/)?.[1];
    assert.ok(data?.length>3000);
    const bytes=Buffer.from(data,'base64');
    assert.equal(bytes.subarray(0,4).toString('ascii'),'RIFF');
    assert.equal(bytes.subarray(8,12).toString('ascii'),'WEBP');
});
test('client module scripts remain syntactically valid and changes use separate CSS',()=>{
    const scripts=[...html.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
    assert.ok(scripts.length);
    for(const [i,src]of scripts.entries()){
        const ast=ts.createSourceFile('client-'+i+'.js',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        assert.deepEqual(ast.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
    }
    assert.ok(html.includes('assets/css/client-panel-ux.css'));
    assert.ok(html.includes('assets/css/client-android-showcase.css'));
});

test('mobile menu stays within the viewport and preserves every destination and delete account access',()=>{
    const css=read('assets/css/client-mobile-dashboard-polish.css');
    for(const nav of ['nav-dashboard','nav-bookings','nav-payments','nav-profile','nav-android'])
        assert.ok(html.includes('id="'+nav+'"'),'Navigation item missing: '+nav);
    assert.ok(html.includes('onclick="showReviewModal()"'),'Reviews navigation missing');
    assert.match(css,/body > \.sidebar \{/);
    assert.match(css,/position:fixed!important/);
    assert.match(css,/height:100dvh!important/);
    assert.match(css,/overscroll-behavior-y:contain/);
    assert.match(css,/safe-area-inset-bottom/);
    assert.match(css,/#view-profile \.r24-mobile-account-action/);
    assert.ok(html.includes('class="r24-mobile-account-action"'),'Delete account must remain available in Profile');
    assert.equal((html.match(/onclick="requestDeleteAccount\(\)"/g)||[]).length,2);
});
test('pickup and return remain visible and differentiated on the same booking row',()=>{
    const css=read('assets/css/client-mobile-dashboard-polish.css');
    const row=part('const rowHtml = ','dashTbody.innerHTML += rowHtml');
    for(const marker of ['r24-client-route-pickup','r24-client-route-return','${pickup}','${drop}','data-pl="📍 Odbiór"','data-en="🏁 Return"'])
        assert.ok(row.includes(marker),'Route field missing: '+marker);
    assert.match(css,/\.r24-client-route-pickup/);
    assert.match(css,/\.r24-client-route-return/);
    assert.equal((row.match(/<td\b/g)||[]).length,8,'Route styling may not remove booking columns');
});
test('dashboard APK promotion keeps original eligibility and both handlers',()=>{
    const css=read('assets/css/client-mobile-dashboard-polish.css');
    assert.ok(dashboard.includes('id="clientAndroidPromoBanner"'));
    assert.equal((dashboard.match(/id="clientAndroidPromoBanner"/g)||[]).length,1);
    assert.ok(dashboard.includes('assets/app-promo/client-app-screen-20261029.svg'));
    assert.ok(dashboard.includes("window.openClientAndroidPlay('dashboard_banner')"));
    assert.ok(dashboard.includes('window.dismissClientAndroidPromo()'));
    assert.ok(html.includes("banner.classList.toggle('show', eligible && !dismissed && !clicked)"));
    for(const k of ['pl_badge_web_generic.png','en_badge_web_generic.png'])
        assert.ok(css.includes(k),'Official localized Google Play badge missing');
    assert.ok(css.includes('@media(max-width:820px)'));
});
