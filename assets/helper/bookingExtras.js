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
        // Only the partner-approved optional driver product and
        // supplier-required items are relevant to this offer. All amounts are
        // displayed exactly as returned by the server's verified quote.
        picker.hidden = false;
        const offer = a.offer_extras && typeof a.offer_extras === 'object' ? a.offer_extras : {status:'unavailable',items:[]};
        const available = Array.isArray(offer.items)
            ? offer.items.filter(x => x && ((x.kind === 'additional_driver' && x.code !== '2' && x.bookable) || x.required === true)) : [];
        const byCode = new Map(available.filter(x => x && typeof x.code === 'string').map(x => [x.code,x]));
        const selectable = available.filter(x => x && x.bookable === true);
        // Supplier names can be Turkish. Customer-facing Arvent UI must
        // follow Ride24 PL/EN; unknown codes are shown neutrally by code
        // rather than leaking an untranslated supplier label.
        const extraName = code => {
            if(code !== '2' && byCode.get(code)?.kind==='additional_driver') return label('Dodatkowy kierowca','Additional driver');
            const names = {
                '1': ['Nawigacja GPS','GPS navigation'],
                '2': ['Ubezpieczenie IMM','IMM insurance'],
                '6': ['Fotelik niemowlęcy','Infant seat'],
                '18': ['Wi-Fi','Wi-Fi']
            };
            const pair=names[String(code)];
            return pair ? (isEn()?pair[1]:pair[0])
                :label('Usługa partnera (kod '+String(code)+')',
                    'Supplier service (code '+String(code)+')');
        };
        const additional = el('additionalDriverSelect');
        // Arvent's additional driver is a paid option, NOT a saved
        // secondary-driver identity. Staff check the licence at pickup.
        if (typeof window !== 'undefined') window.r24ArventExtraDriverAllowed = false;
        if (additional) { additional.disabled = true; additional.value = 'none'; }
        const allowExtraDriver = selectable.some(x => x.kind === 'additional_driver');
        const unavailable = label('Niedostępny online dla tej oferty.', 'Unavailable online for this offer.');
        const driverStatus = allowExtraDriver
            ? ((a.extras || []).some(x => byCode.get(x.code)?.kind === 'additional_driver')
                ? label('Wybrany', 'Selected') : label('Do wyboru w dodatkach', 'Choose in rental extras'))
            : unavailable;
        const driverNote = el('arventAdditionalDriverNote');
        if (driverNote) {
            driverNote.hidden = false;
            driverNote.style.removeProperty('display');
            el('arventAdditionalDriverStatus').textContent = driverStatus;
        }
        if (!allowExtraDriver) {
            const driver = node('div');
            driver.className = 'booking-extra-row';
            driver.append(node('strong', label('Dodatkowy kierowca', 'Additional driver')), node('small', unavailable));
            picker.append(driver);
        }
        const callout = document.querySelector('#termsModal .r24-extras-callout');
        if (callout) callout.hidden = false;
        const modal = el('equipmentInfoModal');
        if (modal) {
            modal.dataset.r24Arvent = 'true';
            const button = modal.querySelector('.equipment-info-actions button');
            if (button) {
                button.dataset.pl = 'Zatwierdź i kontynuuj';
                button.dataset.en = 'Confirm and continue';
                button.textContent = label(button.dataset.pl, button.dataset.en);
            }
        }
        const renderItem=(parent,code,name,priced)=>{
            const item=node('div');item.className='booking-extra-row';
            const detail=node('span');
            const title=extraName(code);
            detail.append(node('strong',title));
            if(code !== '2' && priced?.kind==='additional_driver'){
                detail.append(node('small',money(Math.round(priced.price_eur*100),'EUR') + label(' / doba',' / day')));
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
            if(priced?.bookable===true && !priced.required){
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
            for(const option of available){
                if(!option||typeof option.code!=='string')continue;
                renderItem(picker,option.code,option.name,option);
            }
        }
        // Catalogue entries are informational until this rental has a verified price and product.
        const catalogueCodes = new Set();
        for (const item of [...(Array.isArray(offer.items) ? offer.items : []),
                            ...(Array.isArray(a.extra_catalog) ? a.extra_catalog : [])]) {
            if (typeof item?.code === 'string' && item.code.trim() && !byCode.has(item.code)
                && (item.code === '2' || item.kind !== 'additional_driver')) catalogueCodes.add(item.code);
        }
        if (catalogueCodes.size) {
            picker.append(node('h4', label('Pozostałe dodatki partnera', 'Other supplier extras')));
            picker.append(node('p', label('Katalog informacyjny. Tych dodatków nie można zamówić online.',
                'For information only. These extras cannot be booked online.')));
            for (const code of catalogueCodes) picker.append(node('div', extraName(code)));
        }
        box.hidden = false;
        const cents = v => Math.round(Number(v) * 100);
        // rental_public_total is the original customer-facing Ride24 SEARCH
        // price, NOT the lower supplier net. The online/acquisition fee is
        // already within that searched price; never add it as a new line.
        const extras = a.extras || [];
        // Older no-extras quotes expose the public rental price as total.
        const publicRentalCents = cents(a.rental_public_total ?? (!extras.length ? a.total : NaN));
        if (!Number.isFinite(publicRentalCents)) throw Error('ARVENT_PUBLIC_PRICE_REQUIRED');
        for (const panel of [box, total].filter(Boolean)) {
            panel.append(node('h4', label('Podsumowanie ceny', 'Price summary')));
            row(panel, label('Wynajem samochodu', 'Car rental'), money(publicRentalCents, a.currency));
            for (const fee of (a.mandatory_fees || []))
                row(panel, label('Opłata obowiązkowa', 'Mandatory fee'), money(cents(fee.amount), a.currency));
            for (const extra of extras) {
                const quantity = extra.quantity > 1 ? ' × ' + extra.quantity : '';
                const days = extra.billing === 'day' ? ' × ' + extra.days + label(' dni', ' days') : '';
                row(panel, extraName(extra.code) + quantity + days, money(extra.total_cents, a.currency));
            }
            if (a.loyalty_discount_percent)
                row(panel, label('Rabat lojalnościowy', 'Loyalty discount'), a.loyalty_discount_percent + '%');
            row(panel, label('Łącznie', 'Total'), money(cents(a.total), a.currency), true);
            row(panel, label('Płatność online', 'Online payment'), money(cents(a.online_pln), 'PLN'));
            row(panel, label('Do zapłaty partnerowi', 'Payable to partner'), money(cents(a.pay_on_pickup), a.currency));
            panel.append(node('small', label('Płatność online w PLN według kursu podanego w wycenie.',
                'Online payment in PLN at the exchange rate used for this quote.')));
        }
    }
    function render() {
        const box = el('bookingPriceBreakdown'); box.replaceChildren();
        const picker = el('bookingExtrasPicker'); picker.replaceChildren();
        const total = el('bookingExtrasTotal'); total?.replaceChildren();
        const enabled = quote?.enabled === true;
        if (quote?.arvent) { renderArvent(box, picker, total, quote.arvent); return; }
        const modal = el('equipmentInfoModal');
        if (modal?.dataset.r24Arvent) {
            delete modal.dataset.r24Arvent;
            const button = modal.querySelector('.equipment-info-actions button');
            if (button) { button.dataset.pl = 'OK, rozumiem'; button.dataset.en = 'OK, I understand'; button.textContent = label(button.dataset.pl, button.dataset.en); }
            const callout = document.querySelector('#termsModal .r24-extras-callout');
            if (callout) callout.hidden = false;
        }
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
            // The verified Arvent driver product is managed by its checkbox, never by the
            // additional-driver person dropdown or a saved driver record.
            const { data: { session } } = await db.auth.getSession();
            if (!session?.access_token) throw new Error(label('Zaloguj się ponownie.', 'Please sign in again.'));
            const response = await fetch(url + '/functions/v1/booking-options', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: key }, body: JSON.stringify({ ...c, extras: selections }) });
            const result = await response.json();
            if (current !== revision) return;
            if (!response.ok) throw new Error((isEn() ? result.error_en : result.error) || result.error || label('Nie udało się obliczyć ceny.', 'Could not calculate the price.'));
            quote = result; quoteContext = JSON.stringify(c); ready = true; busy = false;
            render();
            const arventSelectedButUncertified=!!quote?.arvent&&selections.length>0&&quote.enabled!==true;
            el('confirmBookingBtn').disabled = !ready||arventSelectedButUncertified;
            // Price recalculation cannot re-enable the booking while the
            // selected main driver's saved licence date is missing.
            if(quote?.arvent&&typeof window!=='undefined')
                window.ride24ArventLicenceCheck?.();
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
