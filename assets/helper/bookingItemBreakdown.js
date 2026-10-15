(function () {
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.ride24BookingBreakdown = function (snapshot, partnerView, isEn) {
        if (snapshot?.version !== 2 || !Array.isArray(snapshot.items) || !/^[A-Z]{3}$/.test(snapshot.currency)) return '';
        const money = amount => `${(Number(amount) / 100).toFixed(2)} ${esc(snapshot.currency)}`;
        const row = (pl, en, value, bold = false) => `<div style="display:flex;justify-content:space-between;gap:12px;margin:7px 0;${bold ? 'font-weight:800;' : ''}"><span data-pl="${esc(pl)}" data-en="${esc(en)}">${esc(isEn ? en : pl)}</span><span style="white-space:nowrap">${value}</span></div>`;
        let html = '<details style="font-weight:400;color:#334155;white-space:normal;min-width:220px;max-width:360px;font-size:12px;margin-top:8px"><summary style="cursor:pointer;color:#2563eb" data-pl="Rozpiska ceny i dodatków" data-en="Price and extras breakdown">' + (isEn ? 'Price and extras breakdown' : 'Rozpiska ceny i dodatków') + '</summary>';
        for (const item of snapshot.items.slice(0, 23)) {
            const suffix = (item.location_name ? ' — ' + item.location_name : '') + (item.kind === 'extra' ? ` × ${item.quantity}` + (item.billing === 'day' ? ` × ${item.days}` : '') : '');
            html += row(item.name_pl + suffix, item.name_en + suffix, money(partnerView ? item.partner_cents : item.customer_cents));
        }
        if (partnerView) html += row('Łącznie dla partnera', 'Total payable to partner', money(snapshot.partner_cents), true);
        else {
            if (snapshot.loyalty_discount_cents) html += row('Rabat lojalnościowy', 'Loyalty discount', '−' + money(snapshot.loyalty_discount_cents));
            html += row('Łącznie', 'Total', money(snapshot.total_cents), true);
            html += row('Online Ride24', 'Online Ride24', `${(Number(snapshot.online_pln_cents) / 100).toFixed(2)} PLN`);
            html += row('Do zapłaty partnerowi', 'Payable to the partner', money(snapshot.partner_cents));
        }
        return html + '</details>';
    };
})();
