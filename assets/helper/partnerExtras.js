(function () {
    const names = {child_seat:['Fotelik dziecięcy','Child seat'],booster_seat:['Podstawka dla dziecka','Booster seat'],gps:['Nawigacja GPS','GPS navigation'],additional_driver:['Dodatkowy kierowca','Additional driver'],custom:['Własny dodatek','Custom extra']};
    const en = () => localStorage.getItem('partner_lang') === 'en';
    const text = (pl,eng) => en() ? eng : pl;
    const node = (tag,pl,eng) => {const n=document.createElement(tag);if(pl!=null){n.textContent=text(pl,eng??pl);n.dataset.pl=pl;n.dataset.en=eng??pl;}return n;};
    const amount = value => {
        const raw=String(value).trim().replace(',','.');
        if(!raw) return 0;
        if(!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw)>1000000) throw new Error(text('Wpisz poprawną kwotę, maksymalnie dwa miejsca po przecinku.','Enter a valid amount with up to two decimal places.'));
        return Number(raw);
    };
    function input(type='text',value=''){const n=node('input');n.type=type;n.value=value;n.style.cssText='width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px';return n;}
    function field(form,pl,eng,control){const l=node('label');l.style.cssText='display:grid;gap:5px';l.append(node('span',pl,eng),control);form.append(l);return control;}
    function dialog(titlePl,titleEn){const d=node('dialog');d.style.cssText='border:0;border-radius:16px;padding:24px;width:min(480px,90vw);max-height:90dvh;overflow:auto';d.append(node('h3',titlePl,titleEn));const f=node('form');f.style.cssText='display:grid;gap:14px';d.append(f);const status=node('p');status.setAttribute('role','status');f.append(status);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return {d,f,status};}
    function actions(f,d){const row=node('div');row.style.cssText='display:flex;gap:12px;justify-content:flex-end';const cancel=node('button','Anuluj','Cancel');cancel.type='button';cancel.className='btn-secondary';cancel.onclick=()=>d.close();const save=node('button','Zapisz','Save');save.type='submit';save.className='btn-primary';row.append(cancel,save);f.append(row);return save;}
    window.ride24PartnerExtras = {amount,
        async mount(db,partner,refreshLocations){
            const host=document.getElementById('partnerExtrasCatalog');if(!host)return;
            host.replaceChildren();host.hidden=partner.provider_type==='api';if(host.hidden)return;
            host.append(node('h3','Dodatki do wynajmu','Rental extras'));
            host.append(node('p',`Podaj kwoty dla Twojej firmy w ${partner.currency || 'EUR'}. Ride24 doliczy swoją opłatę do ceny klienta. Puste pole oznacza 0.`,`Enter amounts payable to your company in ${partner.currency || 'EUR'}. Ride24 adds its fee to the customer price. A blank amount means 0.`));
            const status=node('p');status.setAttribute('role','status');host.append(status);
            const add=node('button','Dodaj dodatek','Add extra');add.className='btn-primary';add.type='button';host.append(add);
            const {data,error}=await db.from('partner_extras').select('*').eq('partner_id',partner.id).order('created_at');
            if(error){status.textContent=text('Nie udało się pobrać dodatków. Odśwież stronę.','Could not load extras. Refresh the page.');add.disabled=true;return;}
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
            for(const extra of data||[]){const row=node('div');row.style.cssText='display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e2e8f0';const n=names[extra.code]&&extra.code!=='custom'?names[extra.code]:[extra.name_pl||extra.name_en,extra.name_en];const name=node('strong',...n);row.append(name,node('span',`${Number(extra.amount).toFixed(2)} ${partner.currency||'EUR'} / ${extra.billing==='day'?'dzień':'wynajem'}${extra.active?'':' • wyłączony'}`,`${Number(extra.amount).toFixed(2)} ${partner.currency||'EUR'} / ${extra.billing==='day'?'day':'rental'}${extra.active?'':' • disabled'}`));const b=node('button','Edytuj','Edit');b.className='btn-secondary';b.type='button';b.onclick=()=>edit(extra);row.append(b);host.append(row);}
        },
        editFees(db,partner,location,refresh){
            const {d,f,status}=dialog('Opłaty za odbiór i zwrot','Pickup and return fees');f.append(node('p',location.location_name));
            const pickup=field(f,`Odbiór (${partner.currency||'EUR'})`,`Pickup (${partner.currency||'EUR'})`,input('text',location.extra_fee?location.extra_fee_amount??'':''));
            const dropoff=field(f,`Zwrot (${partner.currency||'EUR'})`,`Return (${partner.currency||'EUR'})`,input('text',location.return_fee_amount||''));pickup.inputMode=dropoff.inputMode='decimal';
            f.append(node('p','Kwoty dla partnera. Puste pole oznacza bezpłatnie. Zmiany dotyczą tylko nowych rezerwacji.','Amounts payable to the partner. Leave blank for free. Changes apply only to new bookings.'));
            const save=actions(f,d);f.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const pick=amount(pickup.value),ret=amount(dropoff.value);const {data,error}=await db.from('partner_locations').update({extra_fee:pick>0,extra_fee_amount:pick,return_fee_amount:ret}).eq('id',location.id).eq('partner_id',partner.id).eq('is_api_managed',false).select('id').single();if(error||!data)throw new Error(text('Nie udało się zapisać opłat.','Could not save fees.'));d.close();await refresh();}catch(error){status.textContent=error.message;}finally{save.disabled=false;}};
        }
    };
})();
