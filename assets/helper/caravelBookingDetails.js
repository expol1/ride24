// Caravel booking archive: customer-visible, authenticated and read-only.
// Never infer purchased extras from the current catalog; use the archived quote.
(function () {
  const $ = (tag, content, cls) => {
    const el=document.createElement(tag);
    if(content !== undefined && content !== null) el.textContent=String(content);
    if(cls)el.className=cls;
    return el;
  };
  const label = (pl,en,english) => english ? en : pl;
  const minor = n => Number.isSafeInteger(n) && n>=0 ? n : 0;
  const money = (n,cur) => (minor(n)/100).toFixed(2)+' '+cur;
  const excluded = {
    administration_fee:['opłata administracyjna','administration fee'],
    cross_border_use:['wyjazd za granicę','cross-border use'],
    driving_under_influence:['jazda pod wpływem','driving under influence'],
    ferry_or_sea_transport:['transport promem lub morzem','ferry / sea transport'],
    glass:['szyby','glass'],
    immobilisation:['unieruchomienie pojazdu','immobilisation'],
    interior:['wnętrze','interior'],
    keys:['kluczyki','keys'],
    mirrors:['lusterka','mirrors'],
    off_road_use:['jazda terenowa','off-road use'],
    roof:['dach','roof'],
    tyres_and_wheels:['opony i koła','tyres and wheels'],
    unauthorised_driver:['nieuprawniony kierowca','unauthorised driver'],
    undercarriage:['podwozie','undercarriage'],
    wrong_fuel:['niewłaściwe paliwo','wrong fuel']
  };
  function detailDialog(title,build) {
    const dlg=$('dialog',null,'r24-caravel-document-modal');
    const header=$('div',null,'r24-caravel-document-head');
    header.append($('h3',title));
    const close=$('button','×');
    close.type='button';
    close.setAttribute('aria-label','Zamknij / Close');
    close.onclick=()=>dlg.close();
    header.append(close);dlg.append(header);
    const content=$('div',null,'r24-caravel-document-body');
    build(content);dlg.append(content);
    document.body.append(dlg);
    dlg.addEventListener('close',()=>dlg.remove(),{once:true});
    dlg.showModal();
  }
  function addDocumentButton(box,name,callback){
    const btn=$('button',name,'r24-caravel-document-btn');
    btn.type='button';btn.onclick=callback;box.append(btn);
  }
  function coverageBody(el,details,en) {
    const p=details.coverage||{};
    if(p.premium) el.append($('p',label('Pakiet Premium — zgodnie z wyceną rezerwacji.',
      'Premium package — as confirmed in the booked quote.',en)));
    if(p.deposit_minor===0) el.append($('p',label('Kaucja: brak.',
      'Deposit: none.',en)));
    if(p.excess_minor===0) el.append($('p',label('Udział własny: 0 EUR.',
      'Excess: EUR 0.',en)));
    if(Array.isArray(p.excluded_codes)&&p.excluded_codes.length) {
      el.append($('h4',label('Wyłączenia ochrony','Coverage exclusions',en)));
      const ul=$('ul');
      for(const code of p.excluded_codes){
        ul.append($('li',(excluded[code]||[code,code])[en?1:0]));
      }
      el.append(ul);
    }
    if(Number.isSafeInteger(p.damage_admin_fee_minor) && p.damage_admin_fee_minor>0)
      el.append($('p',label('Opłata administracyjna w razie szkody lub kradzieży: ',
        'Administration fee in case of damage or theft: ',en)+money(p.damage_admin_fee_minor,'EUR')));
    el.append($('p',label('Pełne warunki i wyłączenia znajdują się w zatwierdzonym regulaminie Caravel.',
      'Full terms and exclusions are in the approved Caravel terms.',en)));
  }
  function showTerms(details,en) {
    const doc=details.terms;
    if(!doc) return;
    detailDialog((doc.title||'Caravel')+' — v'+doc.version,content=>{
      content.append($('p',label('Dokument obowiązujący w momencie dokonania rezerwacji.',
        'Terms in force when the booking was made.',en)));
      for(const clause of doc.clauses){
        const section=$('section',null,'r24-caravel-term-clause');
        section.append($('h4',clause.number+'. '+clause.heading));
        for(const paragraph of clause.paragraphs)section.append($('p',paragraph));
        content.append(section);
      }
    });
  }
  function line(parent,name,value,cls) {
    const row=$('div',null,'r24-client-price-row'+(cls?' '+cls:''));
    row.append($('span',name),$('strong',value));parent.append(row);
  }
  function render(details,target,en=false) {
    if(!target||!details||details.kind!=='caravel')return false;
    target.replaceChildren();
    const docs=$('section',null,'r24-caravel-booking-documents');
    docs.append($('h4',label('📄 Dokumenty Caravel','📄 Caravel documents',en)));
    if(details.terms) {
      addDocumentButton(docs,'📘 '+label('Regulamin Caravel — wersja ',
        'Caravel terms — version ',en)+details.terms.version,()=>showTerms(details,en));
    } else docs.append($('p',label('Archiwalny regulamin niedostępny — skontaktuj się z Ride24.',
      'Archived rental terms unavailable — contact Ride24.',en)));
    addDocumentButton(docs,'🛡️ '+label('Pakiet Premium — ochrona i wyłączenia',
      'Premium package — coverage and exclusions',en),()=>{
        detailDialog(label('Ochrona Caravel Premium','Caravel Premium coverage',en),
          el=>coverageBody(el,details,en));
      });
    target.append(docs);
    const drivers=[details.main_driver,details.additional_driver].filter(Boolean);
    if(drivers.length) {
      const wrap=$('section',null,'r24-caravel-booking-drivers');
      wrap.append($('h4',label('Kierowcy w rezerwacji','Booked drivers',en)));
      if(details.main_driver)wrap.append($('p',
        label('Główny: ','Main: ',en)+details.main_driver));
      if(details.additional_driver)wrap.append($('p',
        label('Dodatkowy: ','Additional: ',en)+details.additional_driver));
      target.append(wrap);
    }
    const box=$('section',null,'r24-client-price-body r24-caravel-booked-pricing');
    target.append($('h4',label('Rozliczenie rezerwacji','Booking price breakdown',en)));
    target.append(box);
    if(Array.isArray(details.items)) {
      for(const item of details.items) {
        const title=(en?item.name_en:item.name_pl)+(item.kind==='extra'?' × '+item.quantity:'');
        const value=money(item.amount_minor,details.currency)+(item.kind==='extra'&&item.amount_minor===0
          ? label(' — w cenie',' — included',en) : '');
        line(box,title,value);
      }
    } else box.append($('p',label(
      'Nie udało się zweryfikować poszczególnych pozycji archiwalnej wyceny. Pokazujemy wyłącznie zapisane sumy.',
      'The historic itemised quote could not be verified. Only the recorded totals are shown.',en),
      'r24-price-legacy'));
    line(box,label('Łącznie','Total',en),money(details.total_minor,details.currency),'r24-client-price-total');
    line(box,label('Online Ride24','Online Ride24',en),money(details.online_pln_minor,'PLN'));
    line(box,label('Do zapłaty partnerowi','Payable to partner',en),money(details.partner_minor,details.currency));
    line(box,label('Zwrotna kaucja (poza ceną)','Refundable deposit (not in price)',en),
      Number.isSafeInteger(details.deposit_minor)&&details.deposit_minor>0
        ? money(details.deposit_minor,details.currency)
        : label('Brak kaucji','No deposit',en),'r24-client-price-deposit');
    target.append($('p',label('Kwota Ride24 jest zapisana w PLN według kursu z chwili rezerwacji. Wszystkie dodatki i dopłaty są już w sumie — bez podwójnego naliczania.',
      'The Ride24 PLN amount is the saved booking charge. Extras and mandatory fees are included in the total, never counted twice.',en),
      'r24-caravel-booking-note'));
    return true;
  }
  window.Ride24CaravelBookingDetails={render};
})();
