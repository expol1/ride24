import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import ts from 'typescript';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const panel = read('partner-dashboard.html');
const catalogCode = read('assets/i18n/partner-panel.js');
const runtimeCode = read('assets/helper/partnerI18n.js');
const parsed = new JSDOM(panel);
const script = [...parsed.window.document.querySelectorAll('script:not([src])')]
    .find(node => node.textContent.includes('function getPartnerLang()')).textContent;
const ast = ts.createSourceFile('partner.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = name => {
    for (const node of ast.statements) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node.getText(ast);
        if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
            node.expression.left.getText(ast) === 'window.' + name) return node.getText(ast);
        if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
            if (item.name.getText(ast) === name) return 'const ' + item.getText(ast) + ';';
        }
    }
    throw new Error('Missing panel function: ' + name);
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const languages = ['en', 'pl', 'es', 'el', 'it', 'de', 'ru', 'fr'];

function setup({stored, preferred = ['en-GB'], storageBlocked = false} = {}) {
    const dom = new JSDOM(panel, {url: 'https://ride24.pl/partner-dashboard.html', runScripts: 'outside-only'});
    const w = dom.window;
    Object.defineProperty(w.navigator, 'languages', {value: preferred, configurable: true});
    if (stored) w.localStorage.setItem('partner_lang', stored);
    w.localStorage.setItem('sb-test-auth-token', 'AUTH-UNCHANGED');
    if (storageBlocked) Object.defineProperty(w, 'localStorage', {get() {throw new Error('Storage denied');}});
    const writes = [], reads = [];
    const records = {
        partner_extras: [{id:'seat',code:'child_seat',name_en:'Child seat',name_pl:'Fotelik dziecięcy',amount:3,billing:'day',max_quantity:2,active:true}],
        partner_locations: [{id:'airport',location_name:'Tirana Airport (TIA)',city:'Tirana',extra_fee:true,extra_fee_amount:50,return_fee_amount:50,active:true}],
        partner_time_fees: [{id:'night',applies_to:'either',starts_at:'22:00',ends_at:'07:00',amount:25,once_per_booking:true,active:true}],
        partner_time_blocks: [{id:'closed',applies_to:'pickup',starts_at:'23:45',ends_at:'07:00',active:true}],
        partner_conditional_fees: [{id:'route',kind:'cross_city',name_en:'One-way service',name_pl:'Zwrot w innym mieście',city_scope:['Tirana','Durres'],amount:40,active:true}]
    };
    w.__testDB = {
        auth: {getSession: async () => ({data:{session:{user:{id:'test-user'}}}})},
        from(table) {
            reads.push(table);
            let pending = null;
            const query = {
                select() {return query;}, eq() {return query;},
                order: async () => ({data: structuredClone(records[table] || []),error:null}),
                single: async () => ({data:{id:'test-partner',currency:'EUR'},error:null}),
                insert(data) {pending=structuredClone(data);writes.push({table,data:pending});return query;},
                update(data) {pending=structuredClone(data);writes.push({table,data:pending});return query;},
                then(resolve,reject) {return Promise.resolve({data:pending?[{id:'saved'}]:records[table]||[],error:null}).then(resolve,reject);}
            };
            return query;
        }
    };
    w.HTMLDialogElement.prototype.showModal = function () {this.open=true;};
    w.HTMLDialogElement.prototype.close = function () {this.open=false;this.dispatchEvent(new w.Event('close'));};
    w.__toasts = [];
    w.showToast = (message,type) => w.__toasts.push({message,type});
    for (const name of ['loadFleet','loadLocations','initPartnerAndroidPromo']) w[name] = async () => {};
    for (const name of ['closeModal','closeLocationModal']) w[name] = () => {};
    w.sanitizeAgreementHtml = value => value;
    w.eval(catalogCode); w.eval(runtimeCode); w.eval(read('assets/helper/partnerExtras.js')); w.eval(read('assets/js/location-names.js'));
    const functions = ['getPartnerLang','partnerText','partnerLabel','applyPartnerLanguage','setLang',
        'collectFeatures','saveVehicle','normalizeLocationInput','saveLocation','renderAgreement','toggleSignButton',
        'showSignedAgreement','openPartnerBookingItems','deactivatePartnerAccount'];
    w.eval(`const db=window.__testDB;let currentSeasonalCarId=null;let currentPartnerCurrency='EUR';
        let partnerData={id:'test-partner',company_name:'Airport Office',country:'Albania',address:'Test address',discount_percent:10};
        ${declaration('agreementTexts')}
        ${functions.map(declaration).join('\n')}
        window.__setPartnerData=value=>{partnerData=value;};`);
    w.Ride24PartnerI18n.initialize();
    return {dom,w,d:w.document,i18n:w.Ride24PartnerI18n,writes,reads,records};
}

test('eight languages: browser preference, explicit override, fallback and denied storage', () => {
    for (const [stored,preferred,expected] of [
        [undefined,['el-GR'],'el'],[undefined,['it-IT'],'it'],['es',['de-DE'],'es'],
        [undefined,['ja-JP'],'en'],['__proto__',['ru-RU'],'ru'],['pl',['en-US'],'pl'],[undefined,['fr-FR'],'fr'],[undefined,['fr-CA'],'fr'],[undefined,['fr-BE'],'fr'],['de',['fr-FR'],'de']
    ]) {
        const s=setup({stored,preferred});
        try {assert.equal(s.i18n.getLanguage(),expected);assert.equal(s.d.documentElement.lang,expected);}
        finally {s.dom.window.close();}
    }
    const s=setup({storageBlocked:true,preferred:['de-DE']});
    try {assert.equal(s.i18n.getLanguage(),'de');assert.equal(s.i18n.setLanguage('it'),true);assert.equal(s.i18n.getLanguage(),'it');}
    finally {s.dom.window.close();}
});

test('catalogue completeness, placeholders, safe plain text and local flags', () => {
    const s=setup();
    try {
        const catalog=s.w.Ride24PartnerLocales;
        assert.ok(Object.keys(catalog.source).length>=490);
        const tokens=value=>(value.match(/\{\w+\}/g)||[]).sort();
        for (const code of ['es','el','it','de','ru','fr']) {
            assert.deepEqual(Object.keys(catalog.languages[code]).sort(),Object.keys(catalog.source).sort());
            for (const [key,value] of Object.entries(catalog.languages[code])) {
                assert.ok(value.trim(),code+': '+key);
                assert.deepEqual(tokens(value),tokens(key),code+': '+key);
                assert.doesNotMatch(value,/<\/?[a-z][^>]*>/i);
            }
        }
        for (const img of s.d.querySelectorAll('#partnerLanguageMenu img')) assert.ok(existsSync(new URL('../../'+img.getAttribute('src'),import.meta.url)));
        assert.deepEqual(Array.from(s.i18n.supported),languages);
    } finally {s.dom.window.close();}
});

test('static panel labels, placeholders and helper messages have catalogue entries', () => {
    const s=setup();
    try {
        const keys=new Set(Object.keys(s.w.Ride24PartnerLocales.source));
        for (const node of parsed.window.document.querySelectorAll('[data-pl][data-en]')) {
            if (!node.closest('#guideModal')) assert.ok(keys.has(node.dataset.en),'Missing HTML label: '+node.dataset.en);
        }
        for (const [file,code] of [
            ['panel',script],...['partnerExtras.js','partnerTimeFees.js','partnerMandatoryRules.js','partnerI18n.js'].map(file=>[file,read('assets/helper/'+file)])
        ]) {
            const source=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
            const string=node=>node&&ts.isStringLiteralLike(node)?node.text:null;
            function walk(node) {
                if (ts.isCallExpression(node)) {
                    const name=node.expression.getText(source);
                    const pair=['partnerText','text','tr','label'].includes(name)?[0,1]:
                        ['partnerLabel','node','el','field','fld','setLabel'].includes(name)?[1,2]:null;
                    if (pair) {
                        const pl=string(node.arguments[pair[0]]),en=string(node.arguments[pair[1]]);
                        if (pl&&en) assert.ok(keys.has(en),file+': missing '+en);
                    }
                }
                ts.forEachChild(node,walk);
            }
            walk(source);
        }
    } finally {s.dom.window.close();}
});

test('Android promotion translates every visible message and accessible label in all eight languages', () => {
    const s=setup();
    try {
        const area=s.d.getElementById('view-android');
        const nodes=Array.from(area.querySelectorAll('[data-pl][data-en]'));
        const accessible=Array.from(area.querySelectorAll('[data-aria-pl][data-aria-en]'));
        const source=s.w.Ride24PartnerLocales.source;
        const dictionaries=s.w.Ride24PartnerLocales.languages;
        assert.ok(nodes.length >= 16, 'Android promotion should retain all marketing messages');
        assert.ok(accessible.length >= 2, 'Android preview and Google Play download need translated labels');
        assert.match(panel, /assets\\/i18n\\/partner-panel\\.js\\?v=20261029android2/, 'Fresh i18n cache version must be used');
        for (const language of languages) {
            assert.equal(s.w.setLang(language), undefined);
            assert.equal(s.d.documentElement.lang,language);
            for (const node of nodes) {
                const key=node.dataset.en;
                const expected=language==='en'?key:language==='pl'?node.dataset.pl:dictionaries[language][key];
                assert.ok(expected && expected.trim(), language+' missing Android text: '+key);
                assert.equal(node.textContent,expected,language+' Android text: '+key);
                if (language!=='en' && language!=='pl' && key!== 'Android') {
                    assert.notEqual(expected,key,language+' not localized: '+key);
                }
            }
            for (const node of accessible) {
                const key=node.dataset.ariaEn;
                const expected=language==='en'?key:language==='pl'?node.dataset.ariaPl:dictionaries[language][key];
                assert.ok(expected,language+' missing Android accessible text: '+key);
                assert.equal(node.getAttribute('aria-label'),expected,language+' Android accessible text: '+key);
            }
        }
        assert.ok(area.querySelector('.r24-android-phone-screen img[src$="partner-dashboard-preview.svg"]'));
        assert.match(area.querySelector('.r24-android-play-button').getAttribute('onclick'),/openPartnerAndroidPlay/);
        assert.equal(s.writes.length,0,'Language switching must not write data');
    } finally {s.dom.window.close();}
});

test('language switching preserves form controls, typed data, money, auth and original records', async () => {
    const s=setup();
    try {
        const input=s.d.getElementById('carModel');input.value='Airport Office <not markup>';
        const price=s.d.getElementById('carPrice');price.value='123.45';
        const country=s.d.getElementById('locCountry');country.value='Albania';
        const transmission=s.d.getElementById('carTransmission');transmission.value='A';
        const deposit=s.d.getElementById('carDeposit');deposit.value='100';
        const inputs=[...s.d.querySelectorAll('input,textarea,select')];
        const signed=s.d.getElementById('signed-agreement-content');signed.innerHTML='<p data-pl="Pulpit" data-en="Dashboard">Original signed text</p>';
        const original=signed.innerHTML;
        const entered=s.d.createElement('p');entered.textContent='Airport Office';s.d.body.append(entered);
        for (const lang of languages) {
            s.w.setLang(lang);await tick();
            assert.equal(s.d.getElementById('carModel'),input);assert.equal(input.value,'Airport Office <not markup>');
            assert.equal(price.value,'123.45');assert.equal(country.value,'Albania');assert.equal(transmission.value,'A');assert.equal(deposit.value,'100');
            assert.deepEqual([...s.d.querySelectorAll('input,textarea,select')],inputs);
            assert.equal(entered.textContent,'Airport Office');assert.equal(signed.innerHTML,original);
            assert.equal(s.w.localStorage.getItem('sb-test-auth-token'),'AUTH-UNCHANGED');
            assert.equal(s.w.localStorage.getItem('partner_lang'),lang);
        }
        assert.equal(s.writes.length,0);assert.equal(s.reads.length,0);
        assert.doesNotMatch(runtimeCode,/fetch\s*\(|ipify|ipapi|geolocation|auth\./);
    } finally {s.dom.window.close();}
});

test('late booking rows are translated and vehicle names cannot become HTML', async () => {
    const s=setup({stored:'el'});
    try {
        const row=s.d.createElement('span');row.dataset.pl='✅ Potwierdzona';row.dataset.en='✅ Confirmed';row.textContent='✅ Confirmed';s.d.body.append(row);
        await tick();assert.equal(row.textContent,'✅ Επιβεβαιώθηκε');
        const title=s.d.createElement('h3');s.d.body.append(title);
        s.i18n.bind(title,'Ceny: <img src=x onerror=alert(1)>','Pricing: <img src=x onerror=alert(1)>');
        assert.equal(title.querySelector('img'),null);assert.match(title.textContent,/Τιμές:/);assert.match(title.textContent,/<img/);
        assert.equal(s.i18n.text('Odbiór: 50.00 EUR · Zwrot: 0.00 EUR','Pickup: 50.00 EUR · Return: 0.00 EUR'),'Παραλαβή: 50.00 EUR · Επιστροφή: 0.00 EUR');
        s.w.setLang('de');await tick();assert.equal(row.textContent,'✅ Bestätigt');assert.match(title.textContent,/Preise:/);
    } finally {s.dom.window.close();}
});

test('dropdown works outside the mobile topbar with keyboard navigation and remembers selection', () => {
    const s=setup();
    try {
        const button=s.d.getElementById('partnerLanguageButton'),menu=s.d.getElementById('partnerLanguageMenu');
        assert.equal(menu.parentElement,s.d.body);
        button.click();assert.equal(menu.hidden,false);assert.equal(button.getAttribute('aria-expanded'),'true');
        menu.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'End',bubbles:true}));
        assert.equal(s.d.activeElement.dataset.partnerLanguage,'fr');
        s.d.activeElement.click();assert.equal(s.i18n.getLanguage(),'fr');assert.equal(menu.hidden,true);
        assert.equal(s.d.activeElement,button);assert.equal(s.w.localStorage.getItem('partner_lang'),'fr');
        button.click();menu.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(menu.hidden,true);
        const reloaded=setup({stored:s.w.localStorage.getItem('partner_lang'),preferred:['el-GR']});
        try {assert.equal(reloaded.i18n.getLanguage(),'fr');} finally {reloaded.dom.window.close();}
    } finally {s.dom.window.close();}
});

test('eight-option language menu stays inside a narrow, short viewport', () => {
    const s=setup({stored:'fr'});
    try {
        Object.defineProperty(s.w,'innerWidth',{value:320,configurable:true});
        Object.defineProperty(s.w,'innerHeight',{value:320,configurable:true});
        const button=s.d.getElementById('partnerLanguageButton'),menu=s.d.getElementById('partnerLanguageMenu');
        button.getBoundingClientRect=()=>({left:302,bottom:60});
        Object.defineProperty(menu,'offsetWidth',{value:132});
        Object.defineProperty(menu,'offsetHeight',{value:304});
        button.click();
        assert.equal(menu.hidden,false);
        assert.equal(menu.querySelectorAll('[data-partner-language]').length,8);
        assert.ok(parseFloat(menu.style.left)>=8);
        assert.ok(parseFloat(menu.style.left)+menu.offsetWidth<=s.w.innerWidth-8);
        assert.ok(parseFloat(menu.style.top)>=8);
        assert.ok(parseFloat(menu.style.top)+menu.offsetHeight<=s.w.innerHeight-8);
    } finally {s.dom.window.close();}
});

test('French applies to panel, price templates, agreement controls and the illustrated guide', async () => {
    const s=setup({preferred:['fr-CA']});
    try {
        assert.equal(s.i18n.getLanguage(),'fr');
        assert.equal(s.i18n.locale(),'fr-FR');
        assert.equal(s.d.documentElement.lang,'fr');
        assert.equal(s.d.getElementById('partnerLanguageCode').textContent,'FR');
        assert.equal(s.d.querySelector('#view-dashboard .page-title').textContent,'Tableau de bord');
        assert.equal(s.d.getElementById('locCountry').placeholder,'ex. Portugal (anglais uniquement)');
        assert.equal(s.i18n.text('Odbiór: 50.00 EUR · Zwrot: 0.00 EUR','Pickup: 50.00 EUR · Return: 0.00 EUR'),
            'Prise en charge : 50.00 EUR · Retour : 0.00 EUR');
        s.w.renderAgreement('fr');
        assert.match(s.d.getElementById('ag-content').textContent,/PARTNER AGREEMENT/);
        assert.equal(s.d.getElementById('ag-title').textContent,'Acceptation du contrat');
        const manual=JSON.parse(read('assets/partner-guide/manual.json'));
        s.w.fetch=async()=>({ok:true,json:async()=>structuredClone(manual)});
        s.w.eval(read('assets/helper/partnerGuide.js'));
        await s.w.Ride24PartnerGuide.open({panelLanguage:s.i18n.getLanguage()});
        assert.equal(s.d.getElementById('guideLanguage').value,'fr');
        assert.equal(s.d.getElementById('guideTitle').textContent,manual.languages.fr.ui.title);
        assert.equal(s.d.getElementById('guideModal').lang,'fr');
        assert.equal(s.writes.length,0);
    } finally {s.dom.window.close();}
});

test('actual vehicle and location form handlers produce identical data in all eight languages', async () => {
    const s=setup();
    try {
        let expectedVehicle,expectedLocation;
        for (const lang of languages) {
            s.w.setLang(lang);
            for (const [id,value] of Object.entries({carModel:'Toyota Yaris',carClass:'B',carSeats:'5',carTransmission:'A',carBags:'2',mileageInput:'200',carDeposit:'100',carFuel:'B',carPrice:'123.45',driverHours:'8'})) s.d.getElementById(id).value=value;
            s.d.getElementById('partnerDiscount').textContent='10%';
            s.d.getElementById('featureFullInsurance').checked=true;
            // Simulate selecting the cash deposit option before entering the amount.
            s.d.getElementById('lowDeposit').checked=true;
            s.d.getElementById('featureNoDeposit').checked=false;
            s.d.getElementById('unlimitedMileage').checked=false;
            await s.w.saveVehicle();
            const vehicle=s.writes.at(-1);assert.equal(vehicle.table,'car_classes');
            if (!expectedVehicle) expectedVehicle=vehicle;else assert.deepEqual(vehicle,expectedVehicle);
            assert.equal(vehicle.data[0].public_price,123.45);assert.equal(vehicle.data[0].features.fullInsurance,true);
            assert.equal(vehicle.data[0].features.cashDepositRefundable,true);assert.equal(vehicle.data[0].features.noCreditCard,true);
            for (const [id,value] of Object.entries({locName:'Tirana Airport (TIA)',locCountry:'Albania',locRegion:'Tirana',locCity:'Tirana',locType:'airport',locExtraFeeAmount:'50.00',locReturnFeeAmount:'50.00'})) s.d.getElementById(id).value=value;
            s.d.getElementById('locActive').checked=true;
            await s.w.saveLocation();
            const location=s.writes.at(-1);assert.equal(location.table,'partner_locations');
            if (!expectedLocation) expectedLocation=location;else assert.deepEqual(location,expectedLocation);
            assert.equal(location.data[0].extra_fee_amount,50);assert.equal(location.data[0].return_fee_amount,50);
            assert.equal(location.data[0].country,'Albania');assert.equal(location.data[0].type,'airport');
        }
        assert.equal(s.writes.length,2*languages.length);
    } finally {s.dom.window.close();}
});

test('extras and mandatory-fee forms retain catalogue values and retranslate without database writes', async () => {
    const s=setup({stored:'es'});
    try {
        for (const file of ['partnerExtras.js','partnerTimeFees.js','partnerMandatoryRules.js']) s.w.eval(read('assets/helper/'+file));
        const partner={id:'test-partner',currency:'EUR',provider_type:'local'};
        await s.w.ride24PartnerExtras.mount(s.w.__testDB,partner,async()=>{});
        await s.w.ride24PartnerTimeFees.mount(s.w.__testDB,partner);
        await s.w.ride24PartnerMandatoryRules.mount(s.w.__testDB,partner);
        await tick();
        assert.match(s.d.getElementById('partnerExtrasCatalog').textContent,/Silla infantil/);
        assert.match(s.d.getElementById('partnerTimeFeesCatalog').textContent,/Suplementos nocturnos/);
        assert.match(s.d.getElementById('partnerMandatoryRules').textContent,/One-way service/);
        s.d.querySelector('#partnerExtrasCatalog .btn-primary').click();
        const dialog=s.d.querySelector('dialog.r24-extras-dialog');assert.ok(dialog);
        const number=dialog.querySelector('input[inputmode="decimal"]');number.value='7,50';
        const code=dialog.querySelector('select');code.value='gps';code.dispatchEvent(new s.w.Event('change'));
        const reads=s.reads.length;
        s.w.setLang('ru');await tick();
        assert.match(s.d.getElementById('partnerExtrasCatalog').textContent,/Детское кресло/);
        assert.match(s.d.getElementById('partnerTimeFeesCatalog').textContent,/Ночные доплаты/);
        assert.match(s.d.getElementById('partnerMandatoryRules').textContent,/One-way service/);
        assert.equal(number.value,'7,50');assert.equal(code.value,'gps');assert.equal(s.reads.length,reads);assert.equal(s.writes.length,0);
    } finally {s.dom.window.close();}
});

test('partner breakdown uses unchanged snapshot amounts and original custom names', () => {
    const s=setup({stored:'it'});
    try {
        const snapshot={currency:'EUR',partner_cents:34000,items:[
            {kind:'rental',name_pl:'Wynajem',name_en:'Rental',partner_cents:20000},
            {kind:'pickup',name_pl:'Odbiór',name_en:'Airport service',location_name:'Tirana Airport (TIA)',partner_cents:5000},
            {kind:'extra',name_pl:'Dodatkowa usługa',name_en:'Custom GPS package',quantity:2,days:5,billing:'day',partner_cents:9000}
        ]};
        const original=JSON.stringify(snapshot);s.w.ride24PartnerBookingItems=new Map([['booking',snapshot]]);s.w.ride24PartnerBookingDeposits=new Map([['booking',100]]);
        s.w.openPartnerBookingItems('booking');const dialog=s.d.querySelector('.r24-partner-items-dialog');
        assert.match(dialog.textContent,/Noleggio/);assert.match(dialog.textContent,/Custom GPS package/);
        assert.match(dialog.textContent,/340.00 EUR/);assert.match(dialog.textContent,/100.00 EUR/);
        assert.equal(JSON.stringify(snapshot),original);assert.equal(s.writes.length,0);
    } finally {s.dom.window.close();}
});

test('saving an extra preserves original PL/EN catalogue names and exact amount in every panel language', async () => {
    const s=setup();
    try {
        const partner={id:'test-partner',currency:'EUR',provider_type:'local'};
        for (const lang of languages) {
            s.w.setLang(lang);await s.w.ride24PartnerExtras.mount(s.w.__testDB,partner,async()=>{});
            s.d.querySelector('#partnerExtrasCatalog .btn-primary').click();
            const form=s.d.querySelector('dialog.r24-extras-dialog form');
            const code=form.querySelector('select');code.value='gps';code.dispatchEvent(new s.w.Event('change'));
            form.querySelector('input[inputmode="decimal"]').value='7,50';
            form.querySelector('input[type="number"]').value='2';
            await form.onsubmit({preventDefault(){}});
            const write=s.writes.at(-1);assert.equal(write.table,'partner_extras');
            assert.equal(write.data.code,'gps');assert.equal(write.data.name_en,'GPS navigation');
            assert.equal(write.data.name_pl,'Nawigacja GPS');assert.equal(write.data.amount,7.5);assert.equal(write.data.max_quantity,2);
        }
        assert.equal(s.writes.length,languages.length);
    } finally {s.dom.window.close();}
});

test('guide follows the panel language unless its own language was explicitly chosen', async () => {
    const s=setup({stored:'el'});
    try {
        const manual=JSON.parse(read('assets/partner-guide/manual.json'));
        s.w.fetch=async()=>({ok:true,json:async()=>structuredClone(manual)});
        s.w.eval(read('assets/helper/partnerGuide.js'));
        await s.w.Ride24PartnerGuide.open({panelLanguage:s.i18n.getLanguage()});
        assert.equal(s.d.getElementById('guideLanguage').value,'el');
        assert.equal(s.d.getElementById('guideModal').lang,'el');
        s.w.setLang('es');assert.equal(s.d.getElementById('guideModal').lang,'es');
        const picker=s.d.getElementById('guideLanguage');picker.value='it';picker.dispatchEvent(new s.w.Event('change'));
        s.w.setLang('de');assert.equal(s.d.getElementById('guideModal').lang,'it');
        assert.equal(s.w.localStorage.getItem('partner_lang'),'de');assert.equal(s.w.localStorage.getItem('ride24_partner_guide_language'),'it');
        assert.equal(s.writes.length,0);
    } finally {s.dom.window.close();}
});

test('legal templates remain original PL/EN while agreement chrome follows panel language', () => {
    const s=setup({stored:'el'});
    try {
        const agreement=ast.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(x=>x.name.getText(ast)==='agreementTexts'))
            .declarationList.declarations.find(x=>x.name.getText(ast)==='agreementTexts').initializer;
        const hashes={en:'abef543247ebff9eb13509141351be08fdaa8347faf906b6431a78f53a7c77f7',pl:'b7a2160aba0e8c659d67e412cf0540a9cba6f1bbeb9c6f0b36e526cbbd2cb11d'};
        for (const prop of agreement.properties) {
            const content=prop.initializer.properties.find(x=>x.name.getText(ast)==='content');
            assert.equal(createHash('sha256').update(content.initializer.getText(ast)).digest('hex'),hashes[prop.name.getText(ast)]);
        }
        s.w.renderAgreement('el');assert.match(s.d.getElementById('ag-content').textContent,/PARTNER AGREEMENT/);
        assert.match(s.d.getElementById('ag-title').textContent,/Αποδοχή/);
        const signedHTML='<h2>Original signed agreement</h2><p>Terms in English.</p>';
        s.w.__setPartnerData({agreement_snapshot:JSON.stringify({lang:'en',content:signedHTML})});s.w.showSignedAgreement();
        assert.equal(s.d.getElementById('signed-agreement-content').innerHTML,signedHTML);
        assert.match(s.d.getElementById('view-ag-title').textContent,/υπογεγραμμένη/);
        assert.equal(s.writes.length,0);
    } finally {s.dom.window.close();}
});

test('all partner scripts parse and localization is loaded by the partner panel only', () => {
    for (const file of ['assets/i18n/partner-panel.js','assets/helper/partnerI18n.js','assets/helper/partnerExtras.js','assets/helper/partnerTimeFees.js','assets/helper/partnerMandatoryRules.js','assets/helper/partnerGuide.js']) {
        assert.equal(spawnSync(process.execPath,['--check'],{input:read(file),encoding:'utf8'}).status,0,file);
    }
    for (const node of parsed.window.document.querySelectorAll('script:not([src])')) {
        if (node.type && !['text/javascript','module'].includes(node.type)) continue;
        const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:node.textContent,encoding:'utf8'});
        assert.equal(result.status,0,result.stderr);
    }
    for (const file of ['index.html','klient.html','results.html','admin/index.html']) assert.doesNotMatch(read(file),/partnerI18n\.js|partner-panel\.js/);
});
