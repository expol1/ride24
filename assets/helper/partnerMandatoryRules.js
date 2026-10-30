// Ride24 Partner: simplified mandatory fee and unavailable-hours editor.
// Pricing checks and fee application remain on the server; database contract is unchanged.
(function () {
  'use strict';
  const tr = (pl, en) => window.Ride24PartnerI18n
    ? window.Ride24PartnerI18n.text(pl, en)
    : (localStorage.getItem('partner_lang') === 'pl' ? pl : en);
  const node = (tag, pl, en) => {
    const element = document.createElement(tag);
    if (en !== undefined) {
      if (window.Ride24PartnerI18n) window.Ride24PartnerI18n.bind(element, pl, en);
      else element.textContent = tr(pl, en);
    } else if (pl !== undefined) element.textContent = pl;
    return element;
  };
  const live = (element, render) => window.Ride24PartnerI18n
    ? window.Ride24PartnerI18n.live(element, render)
    : (element.textContent = render(), element);
  const input = (type, value = '') => {
    const element = node('input'); element.type = type; element.value = value; return element;
  };
  const field = (form, pl, en, control) => {
    const label = node('label'); label.append(node('span', pl, en), control);
    form.append(label); return control;
  };
  const select = (options, selected) => {
    const element = node('select');
    for (const [value, pl, en] of options) {
      const option = node('option', pl, en); option.value = value; element.append(option);
    }
    element.value = selected || ''; return element;
  };
  const cssId = 'r24-simplified-mandatory-rules-css';
  function setupStyles() {
    if (document.getElementById(cssId)) return;
    const style = document.createElement('style'); style.id = cssId;
    style.textContent = [
      '#partnerMandatoryRules .r24-rule-card{border:1px solid #d7e4f3;border-radius:15px;padding:17px;margin:16px 0;background:#fff;}',
      '#partnerMandatoryRules .r24-rule-card h4{font-size:16px;font-weight:800;color:#21446f;margin:0 0 7px;}',
      '#partnerMandatoryRules .r24-rule-card>p{font-size:13px;line-height:1.5;margin:0 0 13px;color:#53677e;}',
      '#partnerMandatoryRules .r24-rule-card>.btn-primary{min-height:42px;border-radius:10px;margin-bottom:6px;}',
      '#partnerMandatoryRules .r24-rule-card .r24-extras-row{margin-top:10px;}',
      '#partnerMandatoryRules .r24-rule-empty{font-size:13px;color:#64748b;padding:12px 0 3px;}',
      '.r24-mandatory-dialog .r24-rule-help{font-size:13px;color:#52667d;margin:-6px 0 0;line-height:1.5;}',
      '.r24-mandatory-dialog .r24-rule-preview{padding:14px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff;}',
      '.r24-mandatory-dialog .r24-rule-preview strong{display:block;color:#173b68;font-size:13px;margin-bottom:7px;}',
      '.r24-mandatory-dialog .r24-rule-preview p{color:#1e3a5f;font-size:14px;overflow-wrap:anywhere;}',
      '.r24-mandatory-dialog .r24-rule-city-input{display:flex;gap:8px;align-items:stretch;}',
      '.r24-mandatory-dialog .r24-rule-city-input select{flex:1;min-width:0;}',
      '.r24-mandatory-dialog .r24-rule-city-input button{flex-shrink:0;border-radius:10px;padding:8px 13px;}',
      '.r24-mandatory-dialog .r24-rule-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px;}',
      '.r24-mandatory-dialog .r24-rule-chip{display:inline-flex;gap:7px;align-items:center;background:#e7f2ff;border:1px solid #bfd8f6;border-radius:999px;padding:7px 9px 7px 12px;font-size:13px;color:#173b68;max-width:100%;overflow-wrap:anywhere;}',
      '.r24-mandatory-dialog .r24-rule-chip button{display:inline-grid;place-items:center;border:0;background:#d2e8ff;border-radius:50%;width:24px;height:24px;font-size:18px;color:#23466f;cursor:pointer;}',
      '.r24-mandatory-dialog .r24-rule-city-group[hidden],.r24-mandatory-dialog label[hidden]{display:none!important;}',
      '@media(max-width:560px){#partnerMandatoryRules .r24-rule-card{padding:14px;}#partnerMandatoryRules .r24-rule-card>.btn-primary{width:100%;}.r24-mandatory-dialog .r24-rule-city-input{flex-wrap:wrap;}.r24-mandatory-dialog .r24-rule-city-input button{width:100%;}}'
    ].join('');
    document.head.append(style);
  }
  function dialog(pl, en) {
    const d = node('dialog'); d.className = 'r24-extras-dialog r24-mandatory-dialog';
    d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', tr(pl, en));
    const header = node('div'); header.className = 'r24-extras-dialog__head';
    header.append(node('h3', pl, en));
    const close = node('button', '×'); close.type = 'button'; close.className = 'r24-extras-dialog__close';
    if (window.Ride24PartnerI18n) window.Ride24PartnerI18n.bind(close, 'Zamknij', 'Close', 'aria-label');
    close.onclick = () => d.close(); header.append(close); d.append(header);
    const form = node('form'); form.className = 'r24-extras-dialog__form'; d.append(form);
    const status = node('p'); status.className = 'r24-extras-dialog__status';
    status.setAttribute('role', 'alert'); status.setAttribute('aria-live', 'assertive'); form.append(status);
    const actions = node('div'); actions.className = 'r24-extras-dialog__actions';
    const cancel = node('button', 'Anuluj', 'Cancel'); cancel.type = 'button';
    cancel.className = 'btn-secondary'; cancel.onclick = () => d.close();
    const save = node('button', 'Zapisz', 'Save'); save.type = 'submit'; save.className = 'btn-primary';
    actions.append(cancel, save);
    document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
    return {d, form, status, actions, save};
  }
  function group(form, pl, en) {
    const wrapper = node('div'); wrapper.className = 'r24-rule-city-group';
    wrapper.append(node('strong', pl, en)); form.append(wrapper); return wrapper;
  }
  window.ride24PartnerMandatoryRules = {
    async mount(db, partner) {
      const host = document.getElementById('partnerMandatoryRules');
      if (!host) return;
      host.replaceChildren();
      host.hidden = partner.provider_type === 'api';
      if (host.hidden) return;
      setupStyles();
      host.append(node('h3', 'Obowiązkowe opłaty i godziny niedostępne',
        'Mandatory surcharges and unavailable hours'));
      host.append(node('p',
        'Dodaj obowiązkową dopłatę albo zablokuj godziny, w których odbiór lub zwrot auta nie jest możliwy.',
        'Add a required fee or block hours when pickup or return is unavailable.'));
      const [feesResult, blocksResult, locationsResult] = await Promise.all([
        db.from('partner_conditional_fees').select('*').eq('partner_id', partner.id).order('created_at'),
        db.from('partner_time_blocks').select('*').eq('partner_id', partner.id).order('created_at'),
        db.from('partner_locations').select('id,location_name,city').eq('partner_id', partner.id)
          .eq('is_api_managed', false).order('location_name')
      ]);
      if (feesResult.error || blocksResult.error || locationsResult.error) {
        host.append(node('p', 'Nie udało się wczytać reguł.', 'Could not load rules.')); return;
      }
      const locations = locationsResult.data || [];
      const locationOptions = [
        ['', 'Wybierz lokalizację', 'Choose a location'],
        ...locations.map(x => [x.id, x.location_name, x.location_name])
      ];
      const place = id => locations.find(x => x.id === id)?.location_name
        || tr('Wszystkie punkty', 'All locations');
      // Use the exact city values already configured in this partner's locations.
      // Do not invent city names or allow unlinked, free-form strings.
      const citySuggestions = [...new Map(locations.map(x => String(x.city || '').trim())
        .filter(Boolean).map(city => [city.toLocaleLowerCase(), city])).values()]
        .sort((a, b) => a.localeCompare(b));
      const displayKind = kind => kind === 'cross_city'
        ? tr('Zwrot w innym mieście', 'Return in another city')
        : tr('Obsługa wybranej lokalizacji', 'Service at a selected location');

      function edit(which, rule = {}) {
        const isBlock = which === 'blocks';
        const {d, form, status, actions, save} = dialog(
          isBlock ? 'Niedostępne godziny' : 'Obowiązkowa dopłata',
          isBlock ? 'Unavailable hours' : 'Mandatory fee'
        );
        let kind, location, applies, start, end, amount, cities = [], cityEntry;
        let buildPreview = () => '';
        const preview = node('div'); preview.className = 'r24-rule-preview';
        preview.append(node('strong', 'Podsumowanie', 'Summary'));
        const previewText = live(node('p'), () => buildPreview());
        preview.append(previewText);
        const refresh = () => { previewText.textContent = buildPreview(); };
        if (isBlock) {
          applies = field(form, 'Co zablokować?', 'What should be blocked?', select([
            ['pickup', 'Odbiór', 'Pickup'], ['return', 'Zwrot', 'Return'],
            ['either', 'Odbiór i zwrot', 'Pickup and return']
          ], rule.applies_to || 'pickup'));
          location = field(form, 'W którym miejscu?', 'At which location?', select([
            ['', 'Wszystkie punkty', 'All locations'], ...locationOptions.slice(1)
          ], rule.location_id || ''));
          start = field(form, 'Godzina od', 'Start time',
            input('time', (rule.starts_at || '23:00').slice(0, 5)));
          end = field(form, 'Godzina do', 'End time',
            input('time', (rule.ends_at || '06:00').slice(0, 5)));
          start.required = end.required = true; start.step = end.step = 60;
          form.append(node('p',
            'W tych godzinach system nie pozwoli na rezerwację odbioru lub zwrotu. Nie nalicza żadnej opłaty.',
            'Bookings cannot start or end during the blocked hours. No fee is charged.'));
          buildPreview = () => (applies.selectedOptions[0]?.textContent || '') + ' · '
            + start.value + '–' + end.value + ' · '
            + (location.value ? place(location.value) : tr('Wszystkie punkty', 'All locations'));
          for (const element of [applies, location, start, end]) element.addEventListener('change', refresh);
        } else {
          kind = field(form, 'Za co pobierasz dopłatę?', 'What is the fee for?', select([
            ['location_either', 'Obsługa wybranej lokalizacji', 'Service at a selected location'],
            ['cross_city', 'Zwrot w innym mieście', 'Return in another city']
          ], rule.kind || 'location_either'));
          location = field(form, 'W którym miejscu?', 'At which location?',
            select(locationOptions, rule.location_id || ''));
          const cityGroup = group(form, 'Miasta objęte dopłatą', 'Cities covered by the fee');
          const cityRow = node('div'); cityRow.className = 'r24-rule-city-input';
          cityEntry = select([
            ['', 'Wybierz miasto z listy', 'Choose a city from the list'],
            ...citySuggestions.map(city => [city, city, city])
          ], '');
          cityEntry.setAttribute('aria-label', tr('Wybierz miasto z listy', 'Choose a city from the list'));
          const addCityButton = node('button', 'Dodaj miasto', 'Add city');
          addCityButton.className = 'btn-secondary'; addCityButton.type = 'button';
          cityRow.append(cityEntry, addCityButton);
          cityGroup.append(cityRow);
          cityGroup.append(node('p',
            'Lista zawiera miasta dodane wcześniej w zakładce Lokalizacje.',
            'The list contains cities already set up under Locations.'));
          if (!citySuggestions.length) {
            cityEntry.disabled = true;
            cityGroup.append(node('p',
              'Najpierw dodaj lokalizacje odbioru i zwrotu z nazwami miast w zakładce Lokalizacje.',
              'First add pickup and return locations with city names under Locations.'));
          }
          const chips = node('div'); chips.className = 'r24-rule-chips';
          cityGroup.append(chips, node('p',
            'Wybierz od 2 do 12 miast. Dopłata obowiązuje przy odbiorze i zwrocie w różnych miastach z tej listy.',
            'Choose 2–12 cities. The fee applies when pickup and return are in two different cities from this list.'));
          cities = Array.isArray(rule.city_scope) ? [...rule.city_scope] : [];
          const renderCities = () => {
            chips.replaceChildren();
            for (const city of cities) {
              const chip = node('span'); chip.className = 'r24-rule-chip';
              chip.append(node('span', city));
              const remove = node('button', '×'); remove.type = 'button';
              if (window.Ride24PartnerI18n) window.Ride24PartnerI18n.bind(
                remove, 'Usuń miasto', 'Remove city', 'aria-label'
              );
              remove.onclick = () => {
                cities = cities.filter(item => item !== city); renderCities(); refresh();
              };
              chip.append(remove); chips.append(chip);
            }
            // Keep old saved city scopes visible, even when a location was later removed.
            // Only actual current partner-location cities can be added to a rule.
            for (const option of cityEntry.options) {
              if (option.value) option.disabled = cities.some(
                city => city.toLocaleLowerCase() === option.value.toLocaleLowerCase()
              );
            }
            cityEntry.value = '';
            addCityButton.disabled = true;
          };
          const addCity = () => {
            const city = cityEntry.value;
            if (!citySuggestions.includes(city)) return;
            if (cities.some(x => x.toLocaleLowerCase() === city.toLocaleLowerCase())) {
              renderCities(); return;
            }
            if (cities.length >= 12) {
              status.textContent = tr('Możesz wybrać maksymalnie 12 miast.', 'You can choose up to 12 cities.');
              return;
            }
            cities.push(city); status.textContent = '';
            renderCities(); refresh();
          };
          cityEntry.addEventListener('change', () => {
            addCityButton.disabled = !cityEntry.value;
          });
          addCityButton.onclick = addCity;
          renderCities();
          amount = field(form, 'Kwota dopłaty (' + (partner.currency || 'EUR') + ')',
            'Fee amount (' + (partner.currency || 'EUR') + ')',
            input('text', rule.amount || ''));
          amount.inputMode = 'decimal'; amount.required = true;
          form.append(node('p',
            'Jeśli masz już standardową opłatę za odbiór lub zwrot w tym miejscu, nie naliczaj jej ponownie.',
            'If a standard pickup or return fee already applies at this location, do not charge it twice.'));
          const show = () => {
            location.parentElement.hidden = kind.value !== 'location_either';
            cityGroup.hidden = kind.value !== 'cross_city';
            refresh();
          };
          buildPreview = () => displayKind(kind.value) + ' · '
            + (kind.value === 'cross_city'
              ? (cities.join(', ') || tr('Wybierz miasta', 'Choose cities'))
              : (location.value ? place(location.value) : tr('Wybierz lokalizację', 'Choose a location')))
            + ' · ' + (amount.value || '0') + ' ' + (partner.currency || 'EUR');
          kind.addEventListener('change', show); location.addEventListener('change', refresh);
          amount.addEventListener('input', refresh); show();
        }
        const active = input('checkbox'); active.checked = rule.active !== false;
        field(form, 'Reguła aktywna', 'Rule active', active);
        form.append(preview, actions); refresh();
        form.onsubmit = async event => {
          event.preventDefault(); save.disabled = true; status.textContent = '';
          try {
            let payload = {partner_id: partner.id, active: active.checked};
            if (isBlock) {
              if (!start.value || !end.value || start.value === end.value) {
                throw new Error(tr('Sprawdź godziny.', 'Check the times.'));
              }
              payload = {...payload, location_id: location.value || null,
                applies_to: applies.value, starts_at: start.value, ends_at: end.value};
            } else {
              const price = window.ride24PartnerExtras.amount(amount.value);
              if (!Number.isFinite(price) || price <= 0) {
                throw new Error(tr('Opłata musi być większa od zera.', 'Fee must be positive.'));
              }
              if (kind.value === 'cross_city' && (cities.length < 2 || cities.length > 12)) {
                throw new Error(tr('Wymagane 2–12 różnych miast.', '2–12 distinct cities required.'));
              }
              if (kind.value === 'location_either' && !location.value) {
                throw new Error(tr('Wybierz lokalizację.', 'Choose a location.'));
              }
              const oldCities = Array.isArray(rule.city_scope) ? rule.city_scope : [];
              const unchanged = rule.kind === kind.value
                && (kind.value === 'cross_city'
                  ? JSON.stringify(oldCities) === JSON.stringify(cities)
                  : rule.location_id === location.value);
              const generatedPl = kind.value === 'cross_city'
                ? 'Zwrot w innym mieście'
                : 'Obsługa lokalizacji: ' + place(location.value);
              const generatedEn = kind.value === 'cross_city'
                ? 'Return in another city'
                : 'Service at location: ' + place(location.value);
              payload = {...payload, kind: kind.value,
                location_id: kind.value === 'location_either' ? location.value : null,
                city_scope: kind.value === 'cross_city' ? cities : null,
                name_pl: (unchanged && rule.name_pl ? rule.name_pl : generatedPl).slice(0, 120),
                name_en: (unchanged && rule.name_en ? rule.name_en : generatedEn).slice(0, 120),
                amount: price};
            }
            const table = isBlock ? 'partner_time_blocks' : 'partner_conditional_fees';
            const query = rule.id
              ? db.from(table).update(payload).eq('id', rule.id).eq('partner_id', partner.id)
              : db.from(table).insert(payload);
            const {data, error} = await query.select('id').single();
            if (error || !data) {
              throw new Error(tr('Nie udało się zapisać. Sprawdź ewentualnie zdublowane reguły.',
                'Could not save. Check for duplicate rules.'));
            }
            d.close(); await window.ride24PartnerMandatoryRules.mount(db, partner);
          } catch (error) { status.textContent = error.message; }
          finally { save.disabled = false; }
        };
      }
      const sections = [
        ['conditional', 'Dopłaty obowiązkowe', 'Required fees',
          'System automatycznie doliczy je do odpowiedniej rezerwacji.',
          'The system adds them automatically to matching bookings.',
          'Dodaj dopłatę', 'Add fee', 'Nie ustawiono dopłat.', 'No fees set.'],
        ['blocks', 'Godziny niedostępne', 'Blocked hours',
          'Zablokuj godziny, w których nie obsługujesz odbiorów lub zwrotów.',
          'Block times when pickup or return is not available.',
          'Zablokuj godziny', 'Block hours', 'Nie ustawiono blokad godzinowych.', 'No unavailable hours set.']
      ];
      for (const [which, titlePl, titleEn, descPl, descEn, addPl, addEn, emptyPl, emptyEn] of sections) {
        const card = node('section'); card.className = 'r24-rule-card';
        card.append(node('h4', titlePl, titleEn), node('p', descPl, descEn));
        const add = node('button', addPl, addEn);
        add.type = 'button'; add.className = 'btn-primary';
        add.onclick = () => edit(which); card.append(add);
        const records = which === 'blocks' ? blocksResult.data || [] : feesResult.data || [];
        if (!records.length) {
          const empty = node('p', emptyPl, emptyEn); empty.className = 'r24-rule-empty';
          card.append(empty);
        }
        for (const rule of records) {
          const row = node('div'); row.className = 'r24-extras-row';
          const heading = () => {
            if (which === 'blocks') return ({
              pickup: tr('Odbiór', 'Pickup'), return: tr('Zwrot', 'Return'),
              either: tr('Odbiór i zwrot', 'Pickup and return')
            })[rule.applies_to] + ' · ' + rule.starts_at.slice(0, 5) + '–' + rule.ends_at.slice(0, 5);
            const isAutoName = String(rule.name_en || '').startsWith('Service at location:')
              || rule.name_en === 'Return in another city';
            return isAutoName ? displayKind(rule.kind)
              : (window.Ride24PartnerI18n?.getLanguage() === 'pl' ? rule.name_pl : rule.name_en);
          };
          const detail = () => which === 'blocks'
            ? place(rule.location_id)
            : Number(rule.amount).toFixed(2) + ' ' + (partner.currency || 'EUR') + ' · '
              + (rule.kind === 'cross_city' ? (rule.city_scope || []).join(', ') : place(rule.location_id));
          row.append(live(node('strong'), heading),
            live(node('span'), () => detail() + (rule.active ? '' : ' · ' + tr('wyłączona', 'inactive'))));
          const editButton = node('button', 'Edytuj', 'Edit');
          editButton.type = 'button'; editButton.className = 'btn-secondary';
          editButton.onclick = () => edit(which, rule);
          row.append(editButton); card.append(row);
        }
        host.append(card);
      }
    }
  };
})();