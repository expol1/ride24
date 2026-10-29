(function () {
    const setLabel = (n,pl,en) => {if(window.Ride24PartnerI18n)return window.Ride24PartnerI18n.bind(n,pl,en);n.textContent=text(pl,en);return n;};
    const names = {child_seat:['Fotelik dziecięcy','Child seat'],booster_seat:['Podstawka dla dziecka','Booster seat'],gps:['Nawigacja GPS','GPS navigation'],additional_driver:['Dodatkowy kierowca','Additional driver'],custom:['Własny dodatek','Custom extra']};
    const en = () => { if (window.Ride24PartnerI18n) return window.Ride24PartnerI18n.getLanguage() !== 'pl'; try { return localStorage.getItem('partner_lang') !== 'pl'; } catch (_) { return true; } };
    const text = (pl,eng) => window.Ride24PartnerI18n ? window.Ride24PartnerI18n.text(pl,eng) : en() ? eng : pl;
    const node = (tag,pl,eng) => {const n=document.createElement(tag);if(pl!=null){if(eng!==undefined){n.dataset.pl=pl;n.dataset.en=eng;setLabel(n, pl, eng);}else n.textContent=pl;}return n;};
    const live = (n,render) => {if(window.Ride24PartnerI18n)return window.Ride24PartnerI18n.live(n,render);n.textContent=render();return n;};
    const amount = value => {
        const raw=String(value).trim().replace(',','.');
        if(!raw) return 0;
        if(!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw)>1000000) throw new Error(text('Wpisz poprawną kwotę, maksymalnie dwa miejsca po przecinku.','Enter a valid amount with up to two decimal places.'));
        return Number(raw);
    };
    // The native dialog stays in the browser's top layer, including on mobile.
    // Unlike a fixed sidebar, it is centred and its validation is visible inside.
    function ensureStyles(){
        if(document.getElementById('r24-extras-modal-css'))return;
        const s=document.createElement('style');s.id='r24-extras-modal-css';
        s.textContent=`
        .r24-extras-dialog{position:fixed!important;inset:auto!important;top:50%!important;left:50%!important;right:auto!important;bottom:auto!important;transform:translate(-50%,-50%);margin:0!important;border:0!important;padding:0!important;width:min(620px,calc(100vw - 28px))!important;max-width:none!important;max-height:calc(100dvh - 28px)!important;overflow:hidden!important;border-radius:20px!important;background:white;color:#14213d;box-shadow:0 25px 80px rgba(15,23,42,.34);font:inherit;}
        .r24-extras-dialog::backdrop{background:rgba(9,20,42,.63);backdrop-filter:blur(6px);}
        .r24-extras-dialog__head{display:flex;align-items:center;justify-content:space-between;gap:12px;background:linear-gradient(105deg,#193d93,#2563eb);color:white;padding:20px 24px;border-bottom:4px solid #87cc05;}
        .r24-extras-dialog__head h3{color:white!important;font-size:19px!important;font-weight:800;margin:0!important;line-height:1.3;}
        .r24-extras-dialog__close{border:0;background:rgba(255,255,255,.15);color:white;border-radius:10px;font-size:24px;width:36px;height:36px;cursor:pointer;}
        .r24-extras-dialog__form{display:grid;gap:17px;padding:23px 24px 25px;overflow-y:auto;max-height:calc(100dvh - 112px);background:#fbfdff;}
        .r24-extras-dialog__form label{display:grid;gap:7px;text-align:left;font-size:13px;font-weight:700;color:#334155;}
        .r24-extras-dialog__form label>span{line-height:1.35;}
        .r24-extras-dialog__form input:not([type=checkbox]),.r24-extras-dialog__form select{box-sizing:border-box;width:100%;min-width:0;padding:12px 13px;border:1px solid #cbd5e1;border-radius:11px;background:white;color:#0f172a;font-size:15px;line-height:1.35;}
        .r24-extras-dialog__form input:focus-visible,.r24-extras-dialog__form select:focus-visible{outline:3px solid #bfdbfe;border-color:#2563eb;}
        .r24-extras-dialog__form label:has(input[type=checkbox]){display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #dbeafe;background:#eff6ff;border-radius:11px;}
        .r24-extras-dialog__form input[type=checkbox]{width:19px!important;height:19px;accent-color:#65a30d;flex-shrink:0;}
        .r24-extras-dialog__status{display:none;margin:0;padding:12px 14px;background:#fff1f2;color:#991b1b;border:1px solid #fda4af;border-radius:10px;line-height:1.5;font-size:13px;font-weight:700;}
        .r24-extras-dialog__status:not(:empty){display:block;}
        .r24-extras-dialog__actions{display:flex;justify-content:flex-end;gap:12px;position:sticky;bottom:-25px;background:#fbfdff;padding:14px 0 0;border-top:1px solid #e2e8f0;}
        .r24-extras-dialog__actions button{min-height:43px;padding:10px 20px;border-radius:10px;font-weight:700;}
        .r24-extras-dialog__form p{margin:0;color:#64748b;font-size:13px;line-height:1.5;}
        #partnerExtrasCatalog .r24-extras-row,#partnerTimeFeesCatalog .r24-extras-row,#partnerMandatoryRules .r24-extras-row{display:grid;grid-template-columns:minmax(125px,1fr) minmax(120px,1fr) auto;gap:16px;align-items:center;padding:15px 16px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin-top:10px;}
        #partnerExtrasCatalog .r24-extras-row .btn-secondary,#partnerTimeFeesCatalog .r24-extras-row .btn-secondary,#partnerMandatoryRules .r24-extras-row .btn-secondary{white-space:nowrap;}
        @media(max-width:560px){.r24-extras-dialog__head{padding:16px}.r24-extras-dialog__form{padding:16px;gap:14px}.r24-extras-dialog__actions{bottom:-16px}.r24-extras-dialog__actions button{flex:1}#partnerExtrasCatalog .r24-extras-row,#partnerTimeFeesCatalog .r24-extras-row,#partnerMandatoryRules .r24-extras-row{grid-template-columns:1fr auto;gap:8px}#partnerExtrasCatalog .r24-extras-row span,#partnerTimeFeesCatalog .r24-extras-row span,#partnerMandatoryRules .r24-extras-row span{grid-row:2;grid-column:1/-1}}
        `;
        document.head.append(s);
    }
    function input(type='text',value=''){const n=node('input');n.type=type;n.value=value;return n;}
    function field(form,pl,eng,control){const l=node('label');l.append(node('span',pl,eng),control);form.append(l);return control;}
    function dialog(titlePl,titleEn){
        ensureStyles();
        const d=node('dialog');d.className='r24-extras-dialog';d.setAttribute('aria-modal','true');
        const head=node('div');head.className='r24-extras-dialog__head';const title=node('h3',titlePl,titleEn);
        const close=node('button','×');close.type='button';close.className='r24-extras-dialog__close';close.setAttribute('aria-label',text('Zamknij','Close'));close.onclick=()=>d.close();head.append(title,close);d.append(head);d.setAttribute('aria-label',text(titlePl,titleEn));
        const f=node('form');f.className='r24-extras-dialog__form';d.append(f);
        const status=node('p');status.className='r24-extras-dialog__status';status.setAttribute('role','alert');status.setAttribute('aria-live','assertive');f.append(status);
        document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return {d,f,status};
    }
    function actions(f,d){const row=node('div');row.className='r24-extras-dialog__actions';const cancel=node('button','Anuluj','Cancel');cancel.type='button';cancel.className='btn-secondary';cancel.onclick=()=>d.close();const save=node('button','Zapisz','Save');save.type='submit';save.className='btn-primary';row.append(cancel,save);f.append(row);return save;}
    window.ride24PartnerExtras = {amount,
        async mount(db,partner,refreshLocations){
            ensureStyles();const host=document.getElementById('partnerExtrasCatalog');if(!host)return;
            host.replaceChildren();host.hidden=partner.provider_type==='api';if(host.hidden)return;
            host.append(node('h3','Dodatki do wynajmu','Rental extras'));
            host.append(node('p',`Podaj kwoty dla Twojej firmy w ${partner.currency || 'EUR'}. Ride24 doliczy swoją opłatę do ceny klienta. Puste pole oznacza 0.`,`Enter amounts payable to your company in ${partner.currency || 'EUR'}. Ride24 adds its fee to the customer price. A blank amount means 0.`));
            const status=node('p');status.setAttribute('role','status');host.append(status);
            const add=node('button','Dodaj dodatek','Add extra');add.className='btn-primary';add.type='button';host.append(add);
            const {data,error}=await db.from('partner_extras').select('*').eq('partner_id',partner.id).order('created_at');
            if(error){setLabel(status, 'Nie udało się pobrać dodatków. Odśwież stronę.', 'Could not load extras. Refresh the page.');add.disabled=true;return;}
            const edit=(extra={})=>{
                const {d,f,status}=dialog(extra.id?'Edytuj dodatek':'Dodaj dodatek',extra.id?'Edit extra':'Add extra');
                const code=node('select');code.style.cssText='padding:10px;border-radius:8px';for(const [key,n] of Object.entries(names)){const o=node('option',...n);o.value=key;code.append(o);}code.value=extra.code||'child_seat';field(f,'Dodatek','Extra',code);
                const nameEn=field(f,'Nazwa po angielsku (własny dodatek)','English name (custom extra)',input('text',extra.name_en||''));nameEn.maxLength=120;
                const namePl=field(f,'Nazwa po polsku (opcjonalnie)','Polish name (optional)',input('text',extra.name_pl||''));namePl.maxLength=120;
                const update=()=>{nameEn.parentElement.hidden=namePl.parentElement.hidden=code.value!=='custom';nameEn.required=code.value==='custom';max.disabled=code.value==='additional_driver';if(max.disabled)max.value='1';};
                const price=field(f,`Kwota dla partnera (${partner.currency||'EUR'})`,`Amount payable to partner (${partner.currency||'EUR'})`,input('text',extra.amount??''));price.inputMode='decimal';
                const billing=node('select');for(const [value,pl,eng] of [['rental','Jednorazowo za wynajem','Once per rental'],['day','Za każdy dzień wynajmu','Per rental day']]){const o=node('option',pl,eng);o.value=value;billing.append(o);}billing.value=extra.billing||'rental';field(f,'Sposób naliczania','Charge basis',billing);
                const max=field(f,'Maksymalna liczba sztuk (1–10)','Maximum quantity (1–10)',input('number',extra.max_quantity||1));max.min=1;max.max=10;max.step=1;
                const active=input('checkbox');active.checked=extra.active!==false;active.style.width='auto';field(f,'Dostępny do wyboru','Available to select',active);
                code.onchange=update;update();const save=actions(f,d);
                f.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{
                    const quantity=Number(max.value);if(!Number.isInteger(quantity)||quantity<1||quantity>10)throw new Error(text('Nieprawidłowa liczba sztuk.','Invalid quantity.'));
                    const custom=code.value==='custom';const english=custom?nameEn.value.trim():names[code.value][1],polish=custom?(namePl.value.trim()||null):names[code.value][0];
                    if(!english || /[<>\x00-\x1f]/.test(english+(polish||'')))throw new Error(text('Wpisz poprawną nazwę.','Enter a valid name.'));
                    const value={partner_id:partner.id,code:code.value,name_en:english,name_pl:polish,amount:amount(price.value),billing:billing.value,max_quantity:quantity,active:active.checked};
                    const query=extra.id?db.from('partner_extras').update(value).eq('id',extra.id).eq('partner_id',partner.id):db.from('partner_extras').insert(value);
                    const {data:saved,error}=await query.select('id').single();if(error||!saved)throw new Error(text('Nie udało się zapisać. Sprawdź, czy taki aktywny dodatek już istnieje.','Could not save. Check whether this active extra already exists.'));
                    d.close();await window.ride24PartnerExtras.mount(db,partner,refreshLocations);
                }catch(error){status.textContent=error.message;}finally{save.disabled=false;}};
            };
            add.onclick=()=>edit();
            for(const extra of data||[]){const row=node('div');row.className='r24-extras-row';const n=names[extra.code]&&extra.code!=='custom'?names[extra.code]:[extra.name_pl||extra.name_en,extra.name_en];const name=extra.code==='custom'?live(node('strong'),()=>en()?extra.name_en:(extra.name_pl||extra.name_en)):node('strong',...n);row.append(name,live(node('span'),()=>`${Number(extra.amount).toFixed(2)} ${partner.currency||'EUR'} / ${extra.billing==='day'?text('dzień','day'):text('wynajem','rental')}${extra.active?'':' • '+text('wyłączony','disabled')}`));const b=node('button','Edytuj','Edit');b.className='btn-secondary';b.type='button';b.onclick=()=>edit(extra);row.append(b);host.append(row);}
        },
        editFees(db,partner,location,refresh){
            const {d,f,status}=dialog('Opłaty za odbiór i zwrot samochodu','Vehicle pickup and return fees');f.append(node('p',location.location_name));
            const pickup=field(f,`Odbiór (${partner.currency||'EUR'})`,`Pickup (${partner.currency||'EUR'})`,input('text',location.extra_fee?location.extra_fee_amount??'':''));
            const dropoff=field(f,`Zwrot (${partner.currency||'EUR'})`,`Return (${partner.currency||'EUR'})`,input('text',location.return_fee_amount||''));pickup.inputMode=dropoff.inputMode='decimal';
            f.append(node('p','Tutaj ustalasz standardową opłatę za podstawienie samochodu do tej lokalizacji przy odbiorze oraz odebranie go od klienta przy zwrocie. Możesz podać różne kwoty. Opłaty są doliczane automatycznie. Puste pole oznacza bezpłatnie; zmiany dotyczą tylko nowych rezerwacji.','Set the standard fee for delivering the car to this pickup location and collecting it when returned. You can set different amounts. Fees are added automatically. Leave a field blank for no charge; changes apply only to new bookings.'));
            const save=actions(f,d);f.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const pick=amount(pickup.value),ret=amount(dropoff.value);const {data,error}=await db.from('partner_locations').update({extra_fee:pick>0,extra_fee_amount:pick,return_fee_amount:ret}).eq('id',location.id).eq('partner_id',partner.id).eq('is_api_managed',false).select('id').single();if(error||!data)throw new Error(text('Nie udało się zapisać opłat.','Could not save fees.'));d.close();await refresh();}catch(error){status.textContent=error.message;}finally{save.disabled=false;}};
        }
    };
})();
