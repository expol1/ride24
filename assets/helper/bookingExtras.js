// Shared web presentation for server-authoritative v2 quotes. Never computes totals.
export function createBookingExtras({ db, url, key, context, isEn, isApiBooking = () => false }) {
    let quote = null, selections = [], revision = 0, ready = false, busy = false, quoteContext = '';
    const el = id => document.getElementById(id);
    const label = (pl, en) => isEn() ? en : pl;
    const money = (cents, currency) => new Intl.NumberFormat(isEn() ? 'en-GB' : 'pl-PL', { style: 'currency', currency }).format(cents / 100);
    const node = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
    function lock() {
        ready = false;
        if (el('acceptTerms')) el('acceptTerms').checked = false;
        if (el('confirmBookingBtn')) el('confirmBookingBtn').disabled = true;
    }
    function row(parent, name, value, strong = false) {
        const r = node('div'); r.className = 'booking-price-row';
        r.append(node(strong ? 'strong' : 'span', name), node(strong ? 'strong' : 'span', value)); parent.append(r);
    }
    // Arvent: read-only server preview bound to the search api_quote_id.
    // Only server values are shown; nothing is computed here.
    function renderArvent(box, picker, total, a) {
        if (total) total.hidden = false;
        el('equipmentLegacyInfo').hidden = true;
        // Only the partner-approved optional code 2 (additional driver) and
        // supplier-required items are relevant to this offer. All amounts are
        // displayed exactly as returned by the server's verified quote.
        picker.hidden = false;
        const catalog = Array.isArray(a.extra_catalog) ? a.extra_catalog.filter(x => x?.code === '2') : [];
        const offer = a.offer_extras && typeof a.offer_extras === 'object' ? a.offer_extras : {status:'unavailable',items:[]};
        const available = Array.isArray(offer.items)
            ? offer.items.filter(x => x && (x.code === '2' || x.required === true)) : [];
        const byCode = new Map(available.filter(x => x && typeof x.code === 'string').map(x => [x.code,x]));
        const selectable = available.filter(x => x && x.bookable === true);
        const additional = el('additionalDriverSelect');
        const allowExtraDriver = selectable.some(x => x.code === '2');
        // Arvent's additional driver is a code-2 checkbox, NOT a saved
        // secondary-driver identity. Staff check the licence at pickup.
        if (typeof window !== 'undefined') window.r24ArventExtraDriverAllowed = false;
        if (additional) { additional.disabled = true; additional.value = 'none'; }
        const modalHeading=document.querySelector('#equipmentInfoModal h3');
        if (modalHeading) {
            modalHeading.dataset.pl = selectable.length ? 'Dodatkowy kierowca i cena' : 'Dodatkowy kierowca – informacja';
            modalHeading.dataset.en = selectable.length ? 'Additional driver and price' : 'Additional driver – information';
            modalHeading.textContent = isEn() ? modalHeading.dataset.en : modalHeading.dataset.pl;
        }
        const intro = selectable.length
            ? label('Wybierz dodatki. Kwoty są przeliczane przez Ride24 z cen otrzymanych dla tej oferty.',
                    'Choose extras. Ride24 recalculates totals from this offer’s supplier prices.')
            : offer.status === 'present'
            ? label('Dostępność dla Twojego terminu została odczytana z API. Kwot nie doliczamy bez potwierdzenia zasad naliczania.',
                    'Availability was retrieved for your rental dates. No charges are added until billing terms are confirmed.')
            : offer.status === 'none'
            ? label('Arvent potwierdził stawkę 4 € za dobę dla dodatkowego kierowcy, ale nie udostępnił tej usługi do zamówienia online w tej ofercie.',
                    'Arvent confirmed €4 per day for an additional driver, but this option is not bookable online for this offer.')
            : label('Dodatkowy kierowca kosztuje 4 € za dobę, ale czekamy na potwierdzenie dostępności tej usługi w API.',
                    'The additional driver costs €4 per day, but this offer’s API availability is not yet confirmed.');
        picker.append(node('p',intro));
        const renderItem=(parent,code,name,priced)=>{
            const item=node('div');item.className='booking-extra-row';
            const detail=node('span');
            const title=code==='2'?label('Dodatkowy kierowca','Additional driver'):name;
            detail.append(node('strong',title));
            if(code==='2'){
                detail.append(node('small',label('Stawka Arvent: 4 € / doba.','Arvent rate: €4 / day.')));
                detail.append(node('small',priced?.bookable===true
                    ?label('Prawo jazdy dodatkowy kierowca okaże przy odbiorze.','The additional driver presents their licence at pickup.')
                    :label('Wybór online wymaga potwierdzonej wyceny API.','Online selection requires a verified offer-specific API quote.')));
            } else if(priced && typeof priced.price_eur==='number'){
                detail.append(node('small',label('Cena z API: ','Supplier rate: ')
                    +money(Math.round(priced.price_eur*100),'EUR')
                    +(priced.bookable===true
                      ?(priced.billing==='day'?label(' / doba',' / day'):label(' / wynajem',' / rental'))
                      :label(' — zasady naliczania wymagają potwierdzenia.',' — billing terms still require confirmation.'))));
            } else {
                detail.append(node('small',label('Brak potwierdzonej wyceny dla tej oferty.','No verified quote for this offer.')));
            }
            item.append(detail);
            if(priced?.bookable===true){
                const max=Number.isInteger(priced.max_quantity)?Math.min(10,Math.max(1,priced.max_quantity)):1;
                if(max===1){
                    // Reuse the same premium accessible toggle as local
                    // and Caravel. The Arvent server remains price authority.
                    const control=node('span');control.className='r24-extra-switch';
                    const toggle=node('input');toggle.type='checkbox';
                    toggle.className='r24-extra-switch-input';
                    toggle.setAttribute('role','switch');
                    toggle.setAttribute('aria-label',title+': '+label('Tak lub Nie','Yes or No'));
                    toggle.checked=selections.some(x=>x.id===code && x.quantity===1);
                    const track=node('span');track.className='r24-extra-switch-track';
                    track.setAttribute('aria-hidden','true');track.append(node('span'));
                    const value=node('span',toggle.checked?label('Tak','Yes'):label('Nie','No'));
                    value.className='r24-extra-switch-value';
                    toggle.onchange=()=>{
                        value.textContent=toggle.checked?label('Tak','Yes'):label('Nie','No');
                        selections=selections.filter(x=>x.id!==code);
                        if(toggle.checked)selections.push({id:code,quantity:1});
                        refresh();
                    };
                    control.append(toggle,track,value);item.append(control);
                } else {
                    const select=node('select');select.setAttribute('aria-label',title);
                    for(let i=0;i<=max;i++){
                        const opt=node('option',String(i));opt.value=String(i);select.append(opt);
                    }
                    select.value=String(selections.find(x=>x.id===code)?.quantity||0);
                    select.onchange=()=>{
                        selections=selections.filter(x=>x.id!==code);
                        if(Number(select.value)>0)selections.push({id:code,quantity:Number(select.value)});
                        refresh();
                    };
                    item.append(select);
                }
            }
            parent.append(item);
        };
        // Same clear separation as an AVIA supplier-calculated offer: what is
        // returned for this rental is distinct from the unpriced global list.
        if(available.length){
            picker.append(node('h4',label('Usługi zwrócone dla tej oferty','Services returned for this offer')));
            for(const option of available){
                if(!option||typeof option.code!=='string')continue;
                const entry=catalog.find(x=>x&&x.code===option.code);
                renderItem(picker,option.code,entry?.name||option.name||option.code,option);
            }
        }
        const notOffered=catalog.filter(x=>x&&typeof x.name==='string'
            &&typeof x.code==='string'&&!byCode.has(x.code));
        // Only additional-driver code 2 may appear without a quote: show
        // the known commercial rate but do not present a selectable input.
        for(const extra of notOffered)renderItem(picker,extra.code,extra.name,null);
        if(!available.length&&!notOffered.length)
            picker.append(node('p',label('Brak dodatków w odpowiedzi dostawcy dla tej oferty.',
                'No supplier extras returned for this offer.')));
        const additionalNote=el('arventAdditionalDriverNote');
        if (additionalNote) {
            const driver=byCode.get('2');
            additionalNote.dataset.pl=allowExtraDriver
                ?'Dodatkowy kierowca: 4 € za dobę. Wybierz dodatek w katalogu; prawo jazdy okaże przy odbiorze.'
                :driver?'Dodatkowy kierowca: 4 € za dobę. Czekamy na potwierdzenie usługi w API dla tej oferty.'
                :'Dodatkowy kierowca: 4 € za dobę, ale na razie brak potwierdzenia dostępności w tej ofercie.';
            additionalNote.dataset.en=allowExtraDriver
                ?'Additional driver: €4 per day. Select the extra; the licence is checked at pickup.'
                :driver?'Additional driver: €4 per day. Supplier API availability is pending.'
                :'Additional driver: €4 per day, but offer-specific API availability is not yet confirmed.';
            additionalNote.textContent=isEn()?additionalNote.dataset.en:additionalNote.dataset.pl;
        }
        box.hidden = false;
        const cents = v => Math.round(Number(v) * 100);
        box.append(node('h4', label('Podsumowanie ceny', 'Price summary')));
        const cat = a.category || {};
        const catText = [cat.group_name, cat.example_model ? cat.example_model + label(' lub podobny', ' or similar') : null, cat.sipp ? '(' + cat.sipp + ')' : null].filter(Boolean).join(' ');
        if (catText) row(box, label('Kategoria samochodu', 'Car category'), catText);
        row(box, label('Odbiór', 'Pickup'), `${a.start_date} ${a.pickup_time} • ${a.pickup_location}`);
        row(box, label('Zwrot', 'Return'), `${a.end_date} ${a.return_time} • ${a.return_location}`);
        row(box, label('Liczba rozliczanych dób', 'Billed rental days'), String(a.billed_days));
        row(box, label('Wynajem za cały okres', 'Rental for the whole period'), money(cents(a.rental_total), a.currency));
        for (const fee of (a.mandatory_fees || [])) row(box, isEn() ? fee.name_en : fee.name_pl, money(cents(fee.amount), a.currency));
        for (const extra of (a.extras || [])) {
            const qty=extra.quantity>1?' × '+extra.quantity:'';
            const days=extra.billing==='day'?' × '+extra.days+' '+label('dni','days'):'';
            row(box,(extra.code==='2'?label('Dodatkowy kierowca','Additional driver'):extra.name)+qty+days,
                money(extra.total_cents,'EUR'));
        }
        if (!(a.extras || []).length)
            row(box, label('Dodatki', 'Extras'), label('Brak', 'None'));
        if (a.loyalty_discount_percent) row(box, label('Rabat lojalnościowy (opłata Ride24)', 'Loyalty discount (Ride24 fee)'), a.loyalty_discount_percent + '%');
        row(box, label('Całkowita cena rezerwacji', 'Total booking price'), money(cents(a.total), a.currency), true);
        row(box, label('Opłata Ride24 (online)', 'Ride24 fee (online)'), money(cents(a.online_pln), 'PLN'), true);
        row(box, label('Płatność przy odbiorze', 'Pay at pickup'), money(cents(a.pay_on_pickup), a.currency), true);
        box.append(node('small', label(
            `Kwota w PLN to odrębna opłata rezerwacyjna Ride24 (${money(cents(a.ride24_fee), a.currency)} według kursu NBP ${Number(a.exchange_rate).toFixed(4)}${a.loyalty_discount_percent ? ', po rabacie' : ''}). Wynajem ${money(cents(a.pay_on_pickup), a.currency)} płacisz bezpośrednio wypożyczalni przy odbiorze.`,
            `The PLN amount is the separate Ride24 booking fee (${money(cents(a.ride24_fee), a.currency)} at NBP rate ${Number(a.exchange_rate).toFixed(4)}${a.loyalty_discount_percent ? ', after discount' : ''}). You pay the rental of ${money(cents(a.pay_on_pickup), a.currency)} directly to the rental company at pickup.`)));
        // The same current server quote is visible inside this modal, rather
        // than forcing customers to close it to see their chosen extra's cost.
        if(total){
            const items=Array.isArray(a.extras)?a.extras:[];
            total.append(node('strong',label('Twoje dodatki','Your extras')+': '
                +(items.length?items.length:label('brak','none'))));
            for(const x of items){
                const name=x.code==='2'?label('Dodatkowy kierowca','Additional driver'):x.name;
                const suffix=(x.quantity>1?' × '+x.quantity:'')
                    +(x.billing==='day'?' × '+x.days+' '+label('dni','days'):'');
                row(total,name+suffix,money(x.total_cents,'EUR'));
            }
            row(total,label('Wynajem samochodu','Car rental'),money(cents(a.rental_total),a.currency));
            row(total,label('Cena łączna','Total booking price'),money(cents(a.total),a.currency),true);
            row(total,label('Opłata Ride24 online','Ride24 fee paid online'),money(cents(a.online_pln),'PLN'));
            row(total,label('Do zapłaty Arvent przy odbiorze','Pay Arvent at pickup'),money(cents(a.pay_on_pickup),a.currency),true);
            total.append(node('small',label('Wycena pochodzi z serwera Ride24. Bez potwierdzenia API nie można zamówić płatnego dodatku.',
                'The quote comes from Ride24. Paid extras cannot be selected without supplier API certification.')));
        }
    }
    function render() {
        const box = el('bookingPriceBreakdown'); box.replaceChildren();
        const picker = el('bookingExtrasPicker'); picker.replaceChildren();
        const total = el('bookingExtrasTotal'); total?.replaceChildren();
        const enabled = quote?.enabled === true;
        if (quote?.arvent) { renderArvent(box, picker, total, quote.arvent); return; }
        box.hidden = !enabled;
        picker.hidden = !enabled;
        if (total) total.hidden = !enabled;
        el('equipmentLegacyInfo').hidden = enabled;
        if (!enabled) {
            if (isApiBooking()) {
                picker.hidden = false;
                el("equipmentLegacyInfo").hidden = true;
                picker.append(node("p", label("Dodatki tego dostawcy nie są jeszcze dostępne do potwierdzenia i rezerwacji online. Nie zostały dodane do rezerwacji ani ceny.", "This supplier’s extras cannot yet be confirmed and booked online. No extras have been added to your reservation or price.")));
            }
            // Do not silently convert a previously selected v2 extra into a free v1 booking.
            if (selections.length) {
                ready = false;
                el('confirmBookingBtn').disabled = true;
                box.hidden = false;
                box.append(node('p', label('Płatne dodatki zostały tymczasowo wyłączone. Wróć do wyników i rozpocznij rezerwację ponownie.', 'Paid extras were disabled. Return to results and start a new booking.')));
            }
            return;
        }
        const p = quote.pricing;
        box.append(node('h4', label('Podsumowanie ceny', 'Price summary')));
        for (const item of p.items) {
            let name = isEn() ? item.name_en : item.name_pl;
            if (item.location_name) name += ' — ' + item.location_name;
            if (item.kind === 'extra' || (item.kind === 'time_fee' && item.quantity > 1)) name += ` × ${item.quantity}` + (item.billing === 'day' ? ` × ${item.days} ${label('dni', 'days')}` : '');
            row(box, name, money(item.customer_cents, p.currency));
        }
        if (p.loyalty_discount_cents) row(box, label('Rabat lojalnościowy', 'Loyalty discount'), '−' + money(p.loyalty_discount_cents, p.currency));
        row(box, label('Łącznie', 'Total'), money(p.total_cents, p.currency), true);
        row(box, label('Online po potwierdzeniu', 'Online after confirmation'), money(p.online_pln_cents, 'PLN'));
        row(box, label('Do zapłaty partnerowi', 'Payable to the partner'), money(p.pickup_payment_cents, p.currency));
        box.append(node('small', label('Płatność online w PLN według kursu podanego w wycenie. Dodatki potwierdza partner wraz z rezerwacją.', 'Online payment in PLN at the quoted exchange rate. The partner confirms extras with the booking.')));
        if (!quote.catalog.length) picker.append(node('p', label('Partner nie udostępnił dodatków do rezerwacji online.', 'This partner has no extras available to book online.')));
        for (const extra of quote.catalog) {
            const r = node('label'); r.className = 'booking-extra-row';
            const copy = node('span'); copy.append(node('strong', isEn() ? extra.name_en : extra.name_pl));
            copy.append(node('small', money(extra.unit_customer_cents, p.currency) + ' / ' + (extra.billing === 'day' ? label('dzień', 'day') : label('szt. za cały wybrany okres', 'unit for the entire selected period'))));
            if (extra.provider_billing === 'duration')
                copy.append(node('small', label('Opłata zależna od długości najmu; pokazana kwota jest już sumą za wybrany okres.', 'Duration-based charge; the amount shown is already the total for the selected period.')));
            if (Number.isInteger(extra.max_billed_days) && extra.max_billed_days > 0)
                copy.append(node('small', label('Limit naliczania: ', 'Billing cap: ') + extra.max_billed_days + label(' dni; uwzględniony w cenie.', ' days; included in the quoted price.')));
            r.append(copy);
            if (extra.code === 'additional_driver') {
                r.append(node('small', label('Wybierz osobę w polu „Dodatkowy kierowca”.', 'Select a person in “Additional driver”.')));
            } else {
                // Single-use extras are genuine accessible on/off switches, not dropdowns.
                // API contract stays unchanged: checked = 1, unchecked = no selected item.
                const singleChoice = extra.max_quantity === 1
                    || /^(EQ-GPS|FEE-CB|FEE-FERRY|EQ-DIESEL|FEE-DIESEL|VEH-DIESEL)$/i.test(extra.code || '');
                if (singleChoice) {
                    const control = node('span'); control.className = 'r24-extra-switch';
                    const toggle = node('input');
                    toggle.type = 'checkbox';
                    toggle.className = 'r24-extra-switch-input';
                    toggle.setAttribute('role', 'switch');
                    toggle.setAttribute('aria-label', (isEn() ? extra.name_en : extra.name_pl) + ': ' + label('Tak lub Nie', 'Yes or No'));
                    toggle.checked = selections.some(x => x.id === extra.id && x.quantity > 0);
                    const track = node('span'); track.className = 'r24-extra-switch-track'; track.setAttribute('aria-hidden', 'true');
                    track.append(node('span')); // visual thumb
                    const value = node('span', toggle.checked ? label('Tak', 'Yes') : label('Nie', 'No'));
                    value.className = 'r24-extra-switch-value';
                    toggle.onchange = () => {
                        value.textContent = toggle.checked ? label('Tak', 'Yes') : label('Nie', 'No');
                        selections = selections.filter(x => x.id !== extra.id);
                        if (toggle.checked) selections.push({ id: extra.id, quantity: 1 });
                        refresh();
                    };
                    control.append(toggle, track, value);
                    r.append(control);
                } else {
                    const select = node('select'); select.setAttribute('aria-label', isEn() ? extra.name_en : extra.name_pl);
                    for (let i = 0; i <= extra.max_quantity; i++) {
                        const option = node('option', String(i)); option.value = String(i); select.append(option);
                    }
                    select.value = String(selections.find(x => x.id === extra.id)?.quantity || 0);
                    select.onchange = () => {
                        selections = selections.filter(x => x.id !== extra.id);
                        if (Number(select.value)) selections.push({ id: extra.id, quantity: Number(select.value) });
                        refresh();
                    };
                    r.append(select);
                }
            }
            picker.append(r);
        }
        for (const service of (quote.unavailable_services || []).filter(s => s.status !== 'mapping_requires_confirmation')) picker.append(node('p',
            (isEn() ? service.name_en : (service.name_pl || service.name_en)) + ' — ' +
            (service.status === 'price_requires_confirmation'
                ? label('cena wymaga potwierdzenia przez dostawcę; wybór online niedostępny.', 'price requires supplier confirmation; online selection unavailable.')
                : label('usługa wymaga potwierdzenia; wybór online niedostępny.', 'service requires confirmation; online selection unavailable.'))));
        if (quote.unavailable_services?.some(s => s.status === 'mapping_requires_confirmation'))
            picker.append(node('small', label('Pozostałe usługi wymagają indywidualnego potwierdzenia partnera.', 'Other services require individual confirmation by the partner.')));
        picker.append(node('small', label('Kwoty obejmują wybraną liczbę sztuk i dni. Aktualizacja ceny pochodzi bezpośrednio z serwera Ride24.', 'Prices reflect quantity and days. The updated quote comes directly from Ride24.')));
        if (total) {
            const selected = p.items.filter(item => item.kind === 'extra' && !item.included_in_price);
            total.append(node('strong', label('Twoje dodatki', 'Your extras') + ': ' + (selected.length ? selected.length : label('brak', 'none'))));
            for (const item of selected) {
                const name = (isEn() ? item.name_en : item.name_pl) + ' × ' + item.quantity + (item.billing === 'day' ? ' × ' + item.days + ' ' + label('dni', 'days') : '');
                row(total, name, money(item.customer_cents, p.currency));
            }
            row(total, label('Łączna cena rezerwacji', 'Total booking price'), money(p.total_cents, p.currency), true);
            row(total, label('Online Ride24', 'Online Ride24'), money(p.online_pln_cents, 'PLN'));
            row(total, label('Do zapłaty partnerowi', 'Payable to partner'), money(p.pickup_payment_cents, p.currency));
        }
    }
    async function refresh() {
        const current = ++revision; lock(); busy = true;
        const box = el('bookingPriceBreakdown'); box.hidden = false;
        box.replaceChildren(node('p', label('Obliczamy pełną cenę…', 'Calculating the full price…')));
        const total = el('bookingExtrasTotal');
        if (total) { total.hidden = false; total.replaceChildren(node('p', label('Aktualizujemy wycenę…', 'Updating your quote…'))); }
        try {
            const c = context();
            const driverExtra = quote?.catalog?.find(x => x.code === 'additional_driver');
            if (driverExtra) {
                selections = selections.filter(x => x.id !== driverExtra.id);
                if (c.additional_driver_id) selections.push({ id: driverExtra.id, quantity: 1 });
            }
            // For Arvent code 2 is managed by its checkbox, never by the
            // additional-driver person dropdown or a saved driver record.
            const { data: { session } } = await db.auth.getSession();
            if (!session?.access_token) throw new Error(label('Zaloguj się ponownie.', 'Please sign in again.'));
            const response = await fetch(url + '/functions/v1/booking-options', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: key }, body: JSON.stringify({ ...c, extras: selections }) });
            const result = await response.json();
            if (current !== revision) return;
            if (!response.ok) throw new Error((isEn() ? result.error_en : result.error) || result.error || label('Nie udało się obliczyć ceny.', 'Could not calculate the price.'));
            quote = result; quoteContext = JSON.stringify(c); ready = true; busy = false;
            render(); el('confirmBookingBtn').disabled = !ready;
        } catch (error) {
            if (current !== revision) return;
            busy = false;
            box.replaceChildren(node('p', error.message));
            const total = el('bookingExtrasTotal');
            if (total) { total.hidden = false; total.replaceChildren(node('p', error.message)); }
            const retry = node('button', label('Spróbuj ponownie', 'Try again')); retry.type = 'button'; retry.className = 'btn-secondary'; retry.onclick = refresh; box.append(retry);
            // Never permit booking with an unvalidated, stale quote.
            ready = false; el('confirmBookingBtn').disabled = true;
        }
    }
    return {
        async start() { quote = null; selections = []; await refresh(); },
        refresh,
        close() { ++revision; ready = false; busy = false; },
        payload() {
            if (selections.length && !quote?.enabled) throw new Error(label('Płatne dodatki nie są obecnie dostępne. Nie można ich pominąć po cichu.', 'Paid extras are currently unavailable and cannot be silently removed.'));
            if (!ready || busy || quoteContext !== JSON.stringify(context())) throw new Error(label('Sprawdź aktualne podsumowanie ceny.', 'Review the current price summary.'));
            return quote?.enabled ? { pricing_version: 2, pricing_fingerprint: quote.fingerprint, extras: selections.map(x => ({ ...x })), ...(quote.api_quote_id ? {api_quote_id:quote.api_quote_id} : {}) } : {};
        },
        canSubmit: () => ready && !busy && (!quote?.arvent || !selections.length || quote.enabled === true),
    };
}
