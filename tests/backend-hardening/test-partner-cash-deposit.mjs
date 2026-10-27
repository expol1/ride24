import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../../partner-dashboard.html',import.meta.url),'utf8');
const start=html.indexOf('function syncCashDepositOption(');
const end=html.indexOf('// --- DASHBOARD STATYSTYKI ---',start);
assert.ok(start>=0 && end>start,'Partner deposit functions not found');
const handlers=html.slice(start,end);

function setup() {
    const dom=new JSDOM(html,{url:'https://ride24.pl/partner-dashboard.html',runScripts:'outside-only'});
    const w=dom.window,d=w.document,toasts=[],writes=[];
    w.currentEditingVehicleId=null;
    w.showToast=(text,kind)=>toasts.push({text,kind});
    w.__mockDb={
        auth:{getSession:async()=>({data:{session:{user:{id:'partner-user'}}}})},
        from(table){
            if(table==='partners')return {select(){return this;},eq(){return this;},single:async()=>({data:{id:'partner-id'}})};
            if(table==='car_classes')return {
                insert:async records=>{writes.push(...records);return {error:null};},
                update:()=>{throw new Error('Unexpected update in insert fixture');}
            };
            throw new Error('Unexpected DB table '+table);
        }
    };
    w.eval(`const db=window.__mockDb;
        const partnerText=(pl,en)=>en;
        const partnerLabel=(el,pl,en)=>{el.textContent=en;};
        const getPartnerLang=()=> 'en';
        const closeModal=()=>{};
        const loadFleet=async()=>{};
        const initPartnerAndroidPromo=async()=>{};
        ${handlers}`);
    return {dom,w,d,toasts,writes};
}

test('new vehicle defaults to no deposit and amount input is disabled',()=>{
    const s=setup();
    try{
        const no=s.d.getElementById('featureNoDeposit');
        const cash=s.d.getElementById('lowDeposit');
        const amount=s.d.getElementById('carDeposit');
        assert.equal(no.checked,true);
        assert.equal(cash.checked,false);
        assert.equal(amount.disabled,true);
        s.w.syncCashDepositOption();
        assert.equal(no.checked,true);
        assert.equal(cash.checked,false);
        assert.equal(s.w.collectFeatures().noDeposit,true);
        assert.equal(s.w.collectFeatures().cashDepositRefundable,false);
        assert.equal(s.w.collectFeatures().noCreditCard,true);
        assert.equal(s.w.collectFeatures().noCardHold,true);
    } finally{s.dom.window.close();}
});

test('cash option takes selection from no deposit, and back clears stale amount',()=>{
    const s=setup();
    try{
        const no=s.d.getElementById('featureNoDeposit');
        const cash=s.d.getElementById('lowDeposit');
        const amount=s.d.getElementById('carDeposit');
        cash.checked=true;
        s.w.syncCashDepositOption('cash-deposit');
        assert.equal(no.checked,false);
        assert.equal(amount.disabled,false);
        amount.value='150';
        s.w.syncCashDepositOption('amount');
        assert.equal(s.w.collectFeatures().cashDepositRefundable,true);
        assert.equal(s.w.collectFeatures().cashDepositMethod,'cash');
        assert.equal(s.w.collectFeatures().noDeposit,false);

        no.checked=true;
        s.w.syncCashDepositOption('no-deposit');
        assert.equal(cash.checked,false);
        assert.equal(amount.value,'');
        assert.equal(amount.disabled,true);
        assert.equal(s.w.collectFeatures().noDeposit,true);

        no.checked=false;
        s.w.syncCashDepositOption('no-deposit');
        assert.equal(cash.checked,true);
        assert.equal(amount.disabled,false);

        cash.checked=false;
        s.w.syncCashDepositOption('cash-deposit');
        assert.equal(no.checked,true);
        assert.equal(amount.disabled,true);
    } finally{s.dom.window.close();}
});

test('edit initialization restores saved deposit without changing stored value',()=>{
    const s=setup();
    try{
        const no=s.d.getElementById('featureNoDeposit');
        const cash=s.d.getElementById('lowDeposit');
        const amount=s.d.getElementById('carDeposit');
        amount.value='180';
        s.w.syncCashDepositOption();
        assert.equal(no.checked,false);
        assert.equal(cash.checked,true);
        assert.equal(amount.disabled,false);
        assert.equal(amount.value,'180');
        amount.value='0';
        s.w.syncCashDepositOption();
        assert.equal(no.checked,true);
        assert.equal(cash.checked,false);
        assert.equal(amount.disabled,true);
    } finally{s.dom.window.close();}
});

test('cannot save cash deposit without a positive amount',async()=>{
    const s=setup();
    try{
        s.d.getElementById('lowDeposit').checked=true;
        s.w.syncCashDepositOption('cash-deposit');
        s.d.getElementById('carDeposit').value='';
        await s.w.saveVehicle();
        assert.equal(s.writes.length,0);
        assert.ok(s.toasts.some(t=>t.kind==='error' && /cash deposit amount/.test(t.text)), 'Expected missing amount error');
        assert.equal(s.d.querySelector('#addCarModal .btn-primary').disabled,false);
    } finally{s.dom.window.close();}
});

test('save vehicle with a selected cash deposit preserves exact amount and card rules',async()=>{
    const s=setup();
    try{
        const values={carModel:'Toyota Yaris',carClass:'B',carSeats:'5',carTransmission:'A',carBags:'2',carPrice:'60',carDeposit:'120'};
        for(const [id,v]of Object.entries(values))s.d.getElementById(id).value=v;
        s.d.getElementById('featureFullInsurance').checked=true;
        s.d.getElementById('lowDeposit').checked=true;
        s.w.syncCashDepositOption('cash-deposit');
        await s.w.saveVehicle();
        assert.equal(s.writes.length,1);
        assert.equal(s.writes[0].deposit_amount,120);
        assert.equal(s.writes[0].features.noDeposit,false);
        assert.equal(s.writes[0].features.lowDeposit,true);
        assert.equal(s.writes[0].features.cashDepositRefundable,true);
        assert.equal(s.writes[0].features.noCreditCard,true);
        assert.equal(s.writes[0].features.noCardHold,true);
    } finally{s.dom.window.close();}
});
