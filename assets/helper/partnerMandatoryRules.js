// Mandatory conditional location/route fees and blocked service times.
// Pricing and booking authorization always happen server-side.
(function(){
    const setLabel = (n,pl,en) => {if(window.Ride24PartnerI18n)return window.Ride24PartnerI18n.bind(n,pl,en);n.textContent=tr(pl,en);return n;};
  const en = () => { if (window.Ride24PartnerI18n) return window.Ride24PartnerI18n.getLanguage() !== 'pl'; try { return localStorage.getItem('partner_lang') !== 'pl'; } catch (_) { return true; } };
  const tr=(pl,eng)=>window.Ride24PartnerI18n ? window.Ride24PartnerI18n.text(pl,eng) : en()?eng:pl;
  const node=(tag,t,eng)=>{const n=document.createElement(tag);if(eng!==undefined){n.dataset.pl=t;n.dataset.en=eng;setLabel(n, t, eng);}else if(t!==undefined)n.textContent=t;return n;};
  const live=(n,render)=>{if(window.Ride24PartnerI18n)return window.Ride24PartnerI18n.live(n,render);n.textContent=render();return n;};
  const inp=(type,value='')=>{const n=node('input');n.type=type;n.value=value;return n;};
  const fld=(f,pl,eng,control)=>{const l=node('label');l.append(node('span', pl, eng),control);f.append(l);return control;};
  const sel=(opts,v)=>{const n=node('select');for(const [value,pl,eng] of opts){const o=node('option', pl, eng);o.value=value;n.append(o)}n.value=v;return n;};
  const dialog=(titlePl,titleEn)=>{
    const d=node('dialog');d.className='r24-extras-dialog';d.setAttribute('aria-modal','true');
    const head=node('div');head.className='r24-extras-dialog__head';head.append(node('h3', titlePl, titleEn));
    const close=node('button','×');close.type='button';close.className='r24-extras-dialog__close';close.onclick=()=>d.close();head.append(close);d.append(head);
    const f=node('form');f.className='r24-extras-dialog__form';d.append(f);
    const status=node('p');status.className='r24-extras-dialog__status';status.setAttribute('role','alert');f.append(status);
    document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();
    const actions=node('div');actions.className='r24-extras-dialog__actions';const cancel=node('button', 'Anuluj', 'Cancel');cancel.type='button';cancel.className='btn-secondary';cancel.onclick=()=>d.close();
    const save=node('button', 'Zapisz', 'Save');save.type='submit';save.className='btn-primary';actions.append(cancel,save);
    return {d,f,status,save,actions};
  };
  window.ride24PartnerMandatoryRules={
    async mount(db,partner){
      const parent=document.getElementById('partnerMandatoryRules');if(!parent)return;
      parent.replaceChildren();parent.hidden=partner.provider_type==='api';if(parent.hidden)return;
      parent.append(node('h3', 'Obowiązkowe opłaty i godziny niedostępne', 'Mandatory surcharges and unavailable hours'));
      parent.append(node('p', 'Tu ustawisz obowiązkową dopłatę za obsługę wybranego miejsca (np. hotelu) lub zwrot samochodu w innym mieście. System nalicza ją automatycznie po spełnieniu warunków. Uważaj, aby nie naliczać ponownie opłaty już ustawionej za odbiór lub zwrot w lokalizacji. W sekcji godzin niedostępnych ustawisz pory, w których rezerwacja odbioru lub zwrotu jest zablokowana — bez dodatkowych opłat.', 'Set a mandatory fee for serving a specific place (e.g. a hotel) or returning a car in another city. The system adds it automatically when its conditions are met. Avoid charging twice for a service already covered by the standard location pickup or return fee. In the unavailable-hours section, block pickup or return times when service is not offered — without adding a fee.'));
      const sections=[['conditional','Dodatkowe opłaty za lokalizację lub trasę','Additional location or route fees'],['blocks','Godziny niedostępne dla odbioru i zwrotu','Unavailable pickup and return hours']];
      const [cf,bk,loc]=await Promise.all([
        db.from('partner_conditional_fees').select('*').eq('partner_id',partner.id).order('created_at'),
        db.from('partner_time_blocks').select('*').eq('partner_id',partner.id).order('created_at'),
        db.from('partner_locations').select('id,location_name,city').eq('partner_id',partner.id).eq('is_api_managed',false).order('location_name')
      ]);
      if(cf.error||bk.error||loc.error){parent.append(node('p', 'Nie udało się wczytać reguł.', 'Could not load rules.'));return;}
      const locations=loc.data||[];
      const locOpts=[['', 'Wybierz lokalizację','Select a location'],...locations.map(x=>[x.id,x.location_name,x.location_name])];
      const locationLabel=id=>locations.find(x=>x.id===id)?.location_name||tr('Wszystkie punkty','All locations');
      function edit(which,fee={}){
        const isBlock=which==='blocks';
        const {d,f,status,save,actions}=dialog(isBlock?'Niedostępne godziny':'Obowiązkowa dopłata',isBlock?'Unavailable hours':'Mandatory fee');
        let kind, location, applies, start,end,cities,namePl,nameEn,amount;
        if(isBlock){
          applies=fld(f,'Dotyczy','Applies to',sel([['pickup','Odbiór','Pickup'],['return','Zwrot','Return'],['either','Oba','Both']],fee.applies_to||'pickup'));
          location=fld(f,'Lokalizacja','Location',sel([['','Wszystkie','All locations'],...locOpts.slice(1)],fee.location_id||''));
          start=fld(f,'Od (włącznie)','From (inclusive)',inp('time',(fee.starts_at||'23:45').slice(0,5)));
          end=fld(f,'Do (bez tej minuty)','Until (exclusive)',inp('time',(fee.ends_at||'05:00').slice(0,5)));
          start.required=end.required=true;
          f.append(node('p', 'W tym przedziale system odmówi rezerwacji dla wybranego punktu i czynności.', 'Bookings at this place and time will be rejected.'));
        }else{
          kind=fld(f,'Rodzaj opłaty','Fee type',sel([['location_either','Obsługa wybranej lokalizacji – raz za rezerwację','Selected location – once per booking'],['cross_city','Zwrot w innym mieście (wybrana lista miast)','One-way return between configured cities']],fee.kind||'location_either'));
          location=fld(f,'Lokalizacja','Location',sel(locOpts,fee.location_id||''));
          cities=fld(f,'Miasta (rozdzielone przecinkami)','Cities (comma separated)',inp('text',(fee.city_scope||[]).join(', ')));
          namePl=fld(f,'Nazwa po polsku','Polish name',inp('text',fee.name_pl||''));namePl.maxLength=120;
          nameEn=fld(f,'Nazwa po angielsku','English name',inp('text',fee.name_en||''));nameEn.maxLength=120;
          amount=fld(f,'Kwota w '+(partner.currency||'EUR'),'Amount in '+(partner.currency||'EUR'),inp('text',fee.amount||''));amount.inputMode='decimal';
          namePl.required=nameEn.required=amount.required=true;
          const show=()=>{location.parentElement.hidden=kind.value==='cross_city';cities.parentElement.hidden=kind.value!=='cross_city';};kind.onchange=show;show();
        }
        const active=inp('checkbox');active.checked=fee.active!==false;fld(f,'Aktywna','Active',active);f.append(actions);
        f.onsubmit=async e=>{
          e.preventDefault();save.disabled=true;status.textContent='';
          try{
            let payload={partner_id:partner.id,active:active.checked};
            if(isBlock){
              if(!start.value||!end.value||start.value===end.value)throw new Error(tr('Sprawdź godziny.','Check the times.'));
              payload={...payload,location_id:location.value||null,applies_to:applies.value,starts_at:start.value,ends_at:end.value};
            }else{
              const price=window.ride24PartnerExtras.amount(amount.value);
              if(price<=0)throw new Error(tr('Opłata musi być większa od zera.','Fee must be positive.'));
              const scope=cities.value.split(',').map(x=>x.trim()).filter(Boolean);
              if(kind.value==='cross_city' && (scope.length<2||scope.length>12||new Set(scope.map(x=>x.toLowerCase())).size!==scope.length))
                throw new Error(tr('Wymagane 2–12 różnych miast.','2–12 distinct cities required.'));
              if(kind.value==='location_either'&&!location.value)throw new Error(tr('Wybierz lokalizację.','Select a location.'));
              payload={...payload,kind:kind.value,location_id:kind.value==='location_either'?location.value:null,
                city_scope:kind.value==='cross_city'?scope:null,name_pl:namePl.value.trim(),name_en:nameEn.value.trim(),amount:price};
            }
            const table=isBlock?'partner_time_blocks':'partner_conditional_fees';
            const query=fee.id?db.from(table).update(payload).eq('id',fee.id).eq('partner_id',partner.id):db.from(table).insert(payload);
            const {data,error}=await query.select('id').single();
            if(error||!data)throw new Error(tr('Nie udało się zapisać. Sprawdź ewentualnie zdublowane reguły.','Could not save. Check for duplicate rules.'));
            d.close();await window.ride24PartnerMandatoryRules.mount(db,partner);
          }catch(err){status.textContent=err.message;}finally{save.disabled=false;}
        };
      }
      for(const [which,titlePl,titleEn] of sections){
        const h=node('h4',titlePl,titleEn);h.style.margin='20px 0 10px';parent.append(h);
        const add=node('button', 'Dodaj regułę', 'Add rule');add.type='button';add.className='btn-secondary';add.onclick=()=>edit(which);parent.append(add);
        const records=which==='blocks'?bk.data||[]:cf.data||[];
        for(const fee of records){
          const row=node('div');row.className='r24-extras-row';
          const heading=()=>which==='blocks'
            ? (({pickup:tr('Odbiór','Pickup'),return:tr('Zwrot','Return'),either:tr('Odbiór i zwrot','Pickup and return')})[fee.applies_to]||fee.applies_to)
              +' '+fee.starts_at.slice(0,5)+'–'+fee.ends_at.slice(0,5)
            : (en()?fee.name_en:fee.name_pl);
          const detail=()=>which==='blocks' ? locationLabel(fee.location_id) : Number(fee.amount).toFixed(2)+' '+(partner.currency||'EUR')+' · '+(fee.kind==='cross_city'?fee.city_scope.join(', '):locationLabel(fee.location_id));
          row.append(live(node('strong'),heading),live(node('span'),()=>detail()+(fee.active?'':' · '+tr('wyłączona','inactive'))));
          const button=node('button', 'Edytuj', 'Edit');button.type='button';button.className='btn-secondary';button.onclick=()=>edit(which,fee);row.append(button);
          parent.append(row);
        }
      }
    }
  };
})();
