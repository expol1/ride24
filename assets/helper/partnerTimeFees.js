// Separate obligatory after-hours fees from optional equipment extras.
// Times are interpreted as the selected location's local wall-clock time.
(function () {
  const lang = () => localStorage.getItem('partner_lang') === 'en';
  const label = (pl,en) => lang() ? en : pl;
  const el = (tag,value) => {const n=document.createElement(tag); if(value!=null)n.textContent=value;return n;};
  const field = (host,pl,en,control) => {const l=el('label');l.append(el('span',label(pl,en)),control);host.append(l);return control;};
  const input = (type,value='')=>{const i=el('input');i.type=type;i.value=value;return i;};
  const choice=(items,selected)=>{const s=el('select');for(const [value,pl,en] of items){const o=el('option',label(pl,en));o.value=value;s.append(o)}s.value=selected;return s};
  const money = (n,currency)=>new Intl.NumberFormat(lang()?'en-GB':'pl-PL',{style:'currency',currency:currency||'EUR'}).format(Number(n||0));

  window.ride24PartnerTimeFees = {
    async mount(db,partner) {
      const host=document.getElementById('partnerTimeFeesCatalog');if(!host)return;
      host.replaceChildren();host.hidden=partner.provider_type==='api';if(host.hidden)return;
      host.append(el('h3',label('Automatyczne dopłaty za godziny','Automatic time-based fees')));
      host.append(el('p',label(
        'Wybierz przedziały czasu, w których odbiór lub zwrot wymaga dopłaty. System doda ją sam w podsumowaniu przed rezerwacją — klient nie musi wybierać dodatku.',
        'Set time windows when pickup or return requires a fee. It will automatically appear in the price summary before booking, without any optional selection.'
      )));
      const info=el('p');info.setAttribute('role','status');host.append(info);
      const add=el('button',label('Dodaj regułę godzinową','Add time rule'));add.type='button';add.className='btn-primary';host.append(add);
      const [feesResult,locationResult]=await Promise.all([
        db.from('partner_time_fees').select('*').eq('partner_id',partner.id).order('created_at'),
        db.from('partner_locations').select('id,location_name').eq('partner_id',partner.id).eq('active',true).eq('is_api_managed',false).order('location_name')
      ]);
      if(feesResult.error||locationResult.error){
        info.textContent=label('Nie udało się wczytać reguł. Odśwież stronę.','Could not load time rules. Refresh the page.');
        add.disabled=true;return;
      }
      const fees=feesResult.data||[],locations=locationResult.data||[];
      const actionName=kind=>({pickup:label('Odbiór','Pickup'),return:label('Zwrot','Return'),either:label('Odbiór lub zwrot','Pickup or return')})[kind]||kind;
      const edit=(fee={})=>{
        const d=el('dialog');d.className='r24-extras-dialog';d.setAttribute('aria-modal','true');
        const head=el('div');head.className='r24-extras-dialog__head';
        head.append(el('h3',fee.id?label('Edytuj regułę','Edit rule'):label('Dodaj regułę','Add rule')));
        const close=el('button','×');close.type='button';close.className='r24-extras-dialog__close';close.onclick=()=>d.close();head.append(close);d.append(head);
        const f=el('form');f.className='r24-extras-dialog__form';d.append(f);
        const status=el('p');status.className='r24-extras-dialog__status';status.setAttribute('role','alert');f.append(status);
        const event=field(f,'Dotyczy','Applies to',choice([
          ['pickup','Odbioru','Pickup'],['return','Zwrotu','Return'],['either','Odbioru lub zwrotu','Pickup or return']
        ],fee.applies_to||'pickup'));
        const locOptions=[['','Wszystkie lokalizacje','All locations'],...locations.map(l=>[l.id,l.location_name,l.location_name])];
        if(fee.location_id&&!locations.some(l=>l.id===fee.location_id))locOptions.push([fee.location_id,'Wcześniejsza lokalizacja (nieaktywna)','Previous location (inactive)']);
        const location=field(f,'Lokalizacja','Location',choice(locOptions,fee.location_id||''));
        const start=field(f,'Początek przedziału (włącznie)','Window start (inclusive)',input('time',(fee.starts_at||'22:00').slice(0,5)));
        const end=field(f,'Koniec przedziału (bez tej minuty)','Window end (exclusive)',input('time',(fee.ends_at||'07:00').slice(0,5)));
        start.required=end.required=true;start.step=end.step=60;
        const amount=field(f,'Opłata w '+(partner.currency||'EUR'),'Fee in '+(partner.currency||'EUR'),input('text',fee.amount||''));
        amount.inputMode='decimal';amount.required=true;
        const once=input('checkbox');once.checked=fee.once_per_booking!==false;
        field(f,'Raz na rezerwację, nawet gdy odbiór i zwrot są w tych godzinach','Once per booking if both pickup and return match',once);
        const update=()=>{once.disabled=event.value!=='either';if(once.disabled)once.checked=true;};event.onchange=update;update();
        const enabled=input('checkbox');enabled.checked=fee.active!==false;field(f,'Reguła aktywna','Rule active',enabled);
        f.append(el('p',label('Przykład: 22:00–07:00 obejmuje godziny nocne. Kwota zostanie automatycznie doliczona do ceny przed rezerwacją.','Example: 22:00–07:00 covers overnight times. The charge will be included in the total before booking.')));
        const buttons=el('div');buttons.className='r24-extras-dialog__actions';
        const cancel=el('button',label('Anuluj','Cancel'));cancel.type='button';cancel.className='btn-secondary';cancel.onclick=()=>d.close();
        const save=el('button',label('Zapisz','Save'));save.type='submit';save.className='btn-primary';buttons.append(cancel,save);f.append(buttons);
        document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();
        f.onsubmit=async e=>{
          e.preventDefault();save.disabled=true;
          try{
            if(start.value===end.value)throw new Error(label('Początek i koniec muszą być różne.','Start and end must differ.'));
            const charge=window.ride24PartnerExtras.amount(amount.value);
            if(charge<=0)throw new Error(label('Opłata musi być większa od zera.','Fee must be greater than zero.'));
            if(enabled.checked&&!fee.active&&fees.filter(x=>x.active).length>=30)throw new Error(label('Maksymalnie 30 aktywnych reguł.','Maximum 30 active rules.'));
            if(!fee.id&&enabled.checked&&fees.filter(x=>x.active).length>=30)throw new Error(label('Maksymalnie 30 aktywnych reguł.','Maximum 30 active rules.'));
            const payload={partner_id:partner.id,location_id:location.value||null,applies_to:event.value,starts_at:start.value,ends_at:end.value,
              amount:charge,once_per_booking:once.checked,active:enabled.checked};
            const q=fee.id?db.from('partner_time_fees').update(payload).eq('id',fee.id).eq('partner_id',partner.id):db.from('partner_time_fees').insert(payload);
            const {data,error}=await q.select('id').single();
            if(error||!data)throw new Error(label('Nie udało się zapisać reguły.','Could not save the rule.'));
            d.close();await window.ride24PartnerTimeFees.mount(db,partner);
          }catch(error){status.textContent=error.message;}finally{save.disabled=false;}
        };
      };
      add.onclick=()=>edit();
      if(!fees.length)info.textContent=label('Nie ma jeszcze reguł godzinowych. Rezerwacje pozostają bez dodatkowej opłaty za czas.','No time rules yet. Time-related charges are not added.');
      for(const fee of fees){
        const row=el('div');row.className='r24-extras-row';
        const place=locations.find(x=>x.id===fee.location_id)?.location_name||label('Wszystkie lokalizacje','All locations');
        const name=el('strong',actionName(fee.applies_to)+' · '+fee.starts_at.slice(0,5)+'–'+fee.ends_at.slice(0,5));
        const detail=el('span',money(fee.amount,partner.currency)+' · '+place+
          (fee.applies_to==='either'?(' · '+(fee.once_per_booking?label('raz za rezerwację','once per booking'):label('za każde zdarzenie','per event'))):'')+
          (fee.active?'':' · '+label('wyłączona','disabled')));
        row.append(name,detail);
        const button=el('button',label('Edytuj','Edit'));button.type='button';button.className='btn-secondary';button.onclick=()=>edit(fee);row.append(button);
        host.append(row);
      }
    }
  };
})();
