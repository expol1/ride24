// Shared web presentation for server-authoritative v2 quotes. Never computes totals.
export function createBookingExtras({ db, url, key, context, isEn }) {
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
    function render() {
        const box = el('bookingPriceBreakdown'); box.replaceChildren();
        const picker = el('bookingExtrasPicker'); picker.replaceChildren();
        const total = el('bookingExtrasTotal'); total?.replaceChildren();
        const enabled = quote?.enabled === true;
        box.hidden = !enabled;
        picker.hidden = !enabled;
        if (total) total.hidden = !enabled;
        el('equipmentLegacyInfo').hidden = enabled;
        if (!enabled) {
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
            if (item.kind === 'extra') name += ` × ${item.quantity}` + (item.billing === 'day' ? ` × ${item.days} ${label('dni', 'days')}` : '');
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
            copy.append(node('small', money(extra.unit_customer_cents, p.currency) + ' / ' + (extra.billing === 'day' ? label('dzień', 'day') : label('wynajem', 'rental'))));
            r.append(copy);
            if (extra.code === 'additional_driver') {
                r.append(node('small', label('Wybierz osobę w polu „Dodatkowy kierowca”.', 'Select a person in “Additional driver”.')));
            } else {
                const select = node('select'); select.setAttribute('aria-label', isEn() ? extra.name_en : extra.name_pl);
                for (let i = 0; i <= extra.max_quantity; i++) { const option = node('option', String(i)); option.value = String(i); select.append(option); }
                select.value = String(selections.find(x => x.id === extra.id)?.quantity || 0);
                select.onchange = () => {
                    selections = selections.filter(x => x.id !== extra.id);
                    if (Number(select.value)) selections.push({ id: extra.id, quantity: Number(select.value) });
                    refresh();
                };
                r.append(select);
            }
            picker.append(r);
        }
        picker.append(node('small', label('Kwoty obejmują wybraną liczbę sztuk i dni. Aktualizacja ceny pochodzi bezpośrednio z serwera Ride24.', 'Prices reflect quantity and days. The updated quote comes directly from Ride24.')));
        if (total) {
            const selected = p.items.filter(item => item.kind === 'extra');
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
            const { data: { session } } = await db.auth.getSession();
            if (!session?.access_token) throw new Error(label('Zaloguj się ponownie.', 'Please sign in again.'));
            const response = await fetch(url + '/functions/v1/booking-options', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: key }, body: JSON.stringify({ ...c, extras: selections }) });
            const result = await response.json();
            if (current !== revision) return;
            if (!response.ok) throw new Error((isEn() ? result.error_en : result.error) || result.error || label('Nie udało się obliczyć ceny.', 'Could not calculate the price.'));
            quote = result; quoteContext = JSON.stringify(c); ready = true; busy = false;
            render(); el('confirmBookingBtn').disabled = false;
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
            return quote?.enabled ? { pricing_version: 2, pricing_fingerprint: quote.fingerprint, extras: selections.map(x => ({ ...x })) } : {};
        },
        canSubmit: () => ready && !busy,
    };
}
