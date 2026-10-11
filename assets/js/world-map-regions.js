/* Ride24 region map. Read-only location data; the existing search selection is retained. */
(() => {
  'use strict';

  // Emergency switch: false restores the previous map without changing any data.
  const ENABLED = true;
  const VERSION = '20261011-1';
  const legacyRequested = new URLSearchParams(window.location.search).get('ride24Map') === 'legacy';
  if (!ENABLED || legacyRequested) return;

  const scriptUrl = document.currentScript?.src || new URL('assets/js/world-map-regions.js', document.baseURI).href;
  const assetRoot = new URL('../', scriptUrl);
  const svgNS = 'http://www.w3.org/2000/svg';
  let geometryPromise;
  let dependenciesPromise;
  let requestId = 0;
  let selectedArea = null;
  let visibleLimit = 4;
  let areas = [];
  let geometry;
  let projection;
  let zoom = 1;
  let pan = [0, 0];
  let opener;
  let previousOverflow = '';
  let observer;
  let mapSvg;
  let baseGroup;
  let activeGroup;
  let targets;
  let stage;
  let modal;
  let originalOpen;
  let originalClose;
  let originalLanguage;
  let previousTitle;
  let failed = false;

  const lang = () => localStorage.getItem('lang') === 'en' ? 'en' : 'pl';
  const text = (pl, en) => lang() === 'en' ? en : pl;
  const key = value => String(value || '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_');
  const countryOf = row => window.normalizeRide24Country(row.country);
  const countryCode = country => window.getRide24CountryCode(country);
  const label = area => area[lang()] || window.getRide24CountryLabel(area.country, lang());

  function areaForLocation(row) {
    const country = countryOf(row);
    const region = key(row.region);
    const city = key(row.city);
    const name = key(row.location_name);
    if (country === 'Portugal') {
      if (/azores|azory|acores/.test(region) || /ponta_delgada|horta|angra_do_heroismo/.test(city) || /\bpdl\b/.test(name.replace(/_/g, ' '))) return 'PT-AZORES';
      if (/madeira|madera/.test(region) || /funchal|camara_de_lobos/.test(city) || /madeira|madera|\bfnc\b/.test(name.replace(/_/g, ' '))) return 'PT-MADEIRA';
      return 'PT';
    }
    if (country === 'Italy') {
      if (/sicil|sycyl/.test(region) || /^(palermo|catania|trapani|messina|siracusa|syracuse|ragusa|taormina|agrigento)$/.test(city) || /palermo|catania|trapani/.test(name)) return 'IT-SICILY';
      if (/sardini|sardegn|sardyni/.test(region) || /^(cagliari|olbia|alghero|sassari)$/.test(city) || /cagliari|olbia|alghero/.test(name)) return 'IT-SARDINIA';
      return 'IT';
    }
    if (country === 'Cyprus') {
      if (/north|northern|polnoc|kuzey/.test(region + '_' + city) || /^(kyrenia|girne|famagusta|gazimagusa|lefke)$/.test(city) || /ercan/.test(name)) return 'CY-NORTH';
      return 'CY';
    }
    return countryCode(country) || 'COUNTRY-' + key(country);
  }

  function makeAreas(rows) {
    const grouped = new Map();
    rows.filter(row => row.location_name).forEach(row => {
      const id = areaForLocation(row);
      if (!grouped.has(id)) {
        const region = geometry.regions.find(item => item.id === id);
        const country = countryOf(row);
        const boundary = geometry.countries.find(item => item.properties.code === id);
        grouped.set(id, {
          id, country, pl: region?.pl, en: region?.en,
          feature: region ? { type: 'Feature', properties: { id }, geometry: region.geometry } : boundary,
          locations: []
        });
      }
      grouped.get(id).locations.push(row);
    });
    return [...grouped.values()];
  }

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(path, assetRoot).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Map library unavailable'));
      document.head.append(script);
    });
  }

  function loadAssets() {
    if (!dependenciesPromise) {
      dependenciesPromise = (async () => {
        if (typeof window.d3?.geoMercator !== 'function') {
          await loadScript('vendor/d3-array-3.2.4.min.js');
          await loadScript('vendor/d3-geo-3.1.1.min.js');
        }
      })();
    }
    if (!geometryPromise) {
      geometryPromise = fetch(new URL('maps/regions-v1.json?v=' + VERSION, assetRoot), { credentials: 'same-origin' })
        .then(response => {
          if (!response.ok) throw new Error('Map geometry unavailable');
          return response.json();
        }).then(data => {
          if (!Array.isArray(data.countries) || !Array.isArray(data.regions)) throw new Error('Invalid map geometry');
          return data;
        });
    }
    return Promise.all([dependenciesPromise, geometryPromise]).then(([, data]) => data);
  }

  function element(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  }

  function button(className, value, onClick) {
    const item = element('button', className, value);
    item.type = 'button';
    item.addEventListener('click', onClick);
    return item;
  }

  function countText(count) {
    if (lang() === 'en') return count === 1 ? 'location' : 'locations';
    if (count === 1) return 'lokalizacja';
    return count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14) ? 'lokalizacje' : 'lokalizacji';
  }

  function showInitialList() {
    selectedArea = null;
    visibleLimit = 4;
    zoom = 1;
    pan = [0, 0];
    modal.classList.remove('r24-area-selected');
    renderPanel();
    draw();
  }

  function chooseArea(id) {
    const area = areas.find(item => item.id === id);
    if (!area) return;
    selectedArea = area;
    visibleLimit = 4;
    zoom = 1;
    pan = [0, 0];
    modal.classList.add('r24-area-selected');
    renderPanel();
    draw();
    document.querySelector('#countryLocations .r24-map-back')?.focus({ preventScroll: true });
  }

  function selectLocation(location) {
    // Keep the original SELECTED_PICKUP/DROP, events, modal close and search flow.
    // An intentional map selection must not start a new typed-query request.
    try { isSelectingLocation = true; lastQueryId += 1; } catch (_) { /* legacy globals may be absent */ }
    try {
      window.selectWorldLocation(location);
    } finally {
      const hide = () => document.querySelectorAll('#pickup-results, #drop-results').forEach(box => {
        box.classList.remove('show');
        box.replaceChildren();
      });
      hide();
      window.setTimeout(hide, 350);
      window.setTimeout(() => {
        try { isSelectingLocation = false; } catch (_) { /* optional legacy global */ }
        hide();
      }, 650);
    }
  }

  function renderPanel() {
    const panel = document.getElementById('countryLocations');
    const title = document.getElementById('countryLocationsTitle');
    if (!panel || !title) return;
    // Do not put partner-entered names in data-pl/data-en: setLang uses innerHTML.
    title.removeAttribute('data-pl');
    title.removeAttribute('data-en');
    panel.replaceChildren();
    if (!selectedArea) {
      title.textContent = text('Wybierz kierunek', 'Choose a destination');
      panel.append(element('p', 'r24-map-hint', areas.length
        ? text('Kliknij zielony obszar na mapie lub wybierz kierunek z listy.', 'Click a green area on the map or choose a destination below.')
        : text('Brak aktywnych miejsc odbioru.', 'No active pick-up locations.')));
      const chooser = element('div', 'r24-area-chooser');
      [...areas].sort((a, b) => label(a).localeCompare(label(b), lang())).forEach(area => {
        const item = button('r24-area-choice', label(area), () => chooseArea(area.id));
        item.dataset.area = area.id;
        chooser.append(item);
      });
      panel.append(chooser);
      return;
    }
    title.textContent = label(selectedArea);
    panel.append(button('r24-map-back', text('← Wszystkie kierunki', '← All destinations'), showInitialList));
    const count = element('div', 'r24-area-count');
    count.append(element('strong', '', selectedArea.locations.length), element('span', '', countText(selectedArea.locations.length)));
    panel.append(count);
    const list = element('div', 'r24-map-location-list');
    const rows = [...selectedArea.locations].sort((a, b) => String(a.location_name).localeCompare(String(b.location_name), lang()));
    rows.slice(0, visibleLimit).forEach(row => {
      const item = button('country-location-item r24-map-location', undefined, () => selectLocation(row));
      item.append(element('span', 'country-location-name', row.location_name));
      item.append(element('span', 'country-location-type', window.getRide24LocationType(row, lang())));
      list.append(item);
    });
    panel.append(list);
    if (rows.length > visibleLimit) {
      const more = button('r24-map-more', text('Pokaż pozostałe', 'Show remaining') + ' (' + (rows.length - visibleLimit) + ')', () => {
        visibleLimit = rows.length;
        renderPanel();
      });
      panel.append(more);
    }
  }

  function viewBounds() {
    const d3 = window.d3;
    if (selectedArea?.feature) return d3.geoBounds(selectedArea.feature);
    const features = areas.map(area => area.feature).filter(Boolean);
    if (!features.length) return [[-33, 27], [40, 54]];
    let bounds = d3.geoBounds({ type: 'FeatureCollection', features });
    // Atlantic/Europe overview leaves enough context around islands and countries.
    if (bounds[0][0] >= -40 && bounds[1][0] <= 50 && bounds[0][1] >= 20 && bounds[1][1] <= 60) return [[-33, 27], [40, 54]];
    // A globe overview also keeps distant current/future destinations accessible.
    if (bounds[0][0] > bounds[1][0]) bounds = [[-180, -60], [180, 80]];
    return bounds;
  }

  function draw() {
    if (!geometry || !stage || !mapSvg || !modal.classList.contains('r24-regions')) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    const d3 = window.d3;
    const bounds = viewBounds();
    const unit = d3.geoMercator().scale(1).translate([0, 0]);
    const a = unit([bounds[0][0], Math.min(80, bounds[1][1])]);
    const b = unit([bounds[1][0], Math.max(-75, bounds[0][1])]);
    const scale = Math.min((w - 52) / Math.max(.001, b[0] - a[0]), (h - 52) / Math.max(.001, b[1] - a[1])) * zoom;
    projection = d3.geoMercator().scale(scale).translate([w / 2 - scale * (a[0] + b[0]) / 2 + pan[0], h / 2 - scale * (a[1] + b[1]) / 2 + pan[1]]).clipExtent([[0, 0], [w, h]]);
    const path = d3.geoPath(projection);
    mapSvg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const updatePaths = (group, features, className, active) => {
      const children = Array.from(group.children);
      features.forEach((feature, index) => {
        const node = children[index] || document.createElementNS(svgNS, 'path');
        node.setAttribute('class', className + (active && selectedArea?.id === feature.properties.id ? ' is-selected' : ''));
        node.setAttribute('d', path(feature) || '');
        if (active) {
          node.dataset.area = feature.properties.id;
          node.onclick = () => chooseArea(feature.properties.id);
        }
        if (!children[index]) group.append(node);
      });
      children.slice(features.length).forEach(node => node.remove());
    };
    updatePaths(baseGroup, geometry.countries, 'r24-map-land', false);
    const features = areas.filter(area => area.feature).map(area => ({ ...area.feature, properties: { ...area.feature.properties, id: area.id } }));
    updatePaths(activeGroup, features, 'r24-map-coverage', true);
    targets.replaceChildren();
    features.forEach(feature => {
      const area = areas.find(item => item.id === feature.properties.id);
      const centroid = projection(d3.geoCentroid(feature));
      if (centroid[0] < 22 || centroid[0] > w - 22 || centroid[1] < 22 || centroid[1] > h - 22) return;
      // Invisible native touch/keyboard target helps with geographically small islands.
      const target = button('r24-map-target', '', () => chooseArea(area.id));
      target.dataset.area = area.id;
      target.style.left = centroid[0] + 'px';
      target.style.top = centroid[1] + 'px';
      target.setAttribute('aria-label', text('Pokaż miejsca: ', 'Show locations: ') + label(area));
      targets.append(target);
    });
  }

  function updateLanguage() {
    if (!modal?.classList.contains('r24-regions')) return;
    const header = modal.querySelector('.world-map-header h2');
    header.textContent = text('Wybierz miejsce odbioru', 'Choose a pick-up location');
    modal.querySelector('.r24-map-reset').textContent = text('Cała mapa', 'Full map');
    modal.querySelector('.r24-map-legend-text').textContent = text('Nasze kierunki', 'Our destinations');
    modal.querySelector('.r24-map-close')?.setAttribute('aria-label', text('Zamknij mapę', 'Close map'));
    mapSvg?.setAttribute('aria-label', text('Zielone obszary z miejscami odbioru', 'Green areas with pick-up locations'));
    modal.querySelectorAll('.r24-map-zoom button').forEach((item, index) => {
      item.setAttribute('aria-label', index ? text('Oddal mapę', 'Zoom out') : text('Przybliż mapę', 'Zoom in'));
    });
    renderPanel();
    draw();
  }

  function buildMap() {
    stage = document.getElementById('worldMapSvg');
    stage.replaceChildren();
    if (typeof ride24WorldMap !== 'undefined' && ride24WorldMap?.destroy) {
      ride24WorldMap.destroy();
      ride24WorldMap = null;
    }
    const toolbar = element('div', 'r24-map-toolbar');
    const legend = element('span', 'r24-map-legend');
    legend.append(element('span', 'r24-map-swatch'), element('span', 'r24-map-legend-text'));
    toolbar.append(legend, button('r24-map-reset', '', showInitialList));
    stage.parentElement.querySelector('.r24-map-toolbar')?.remove();
    stage.before(toolbar);
    mapSvg = document.createElementNS(svgNS, 'svg');
    mapSvg.setAttribute('class', 'r24-region-svg');
    mapSvg.setAttribute('role', 'img');
    mapSvg.setAttribute('aria-label', text('Zielone obszary z miejscami odbioru', 'Green areas with pick-up locations'));
    baseGroup = document.createElementNS(svgNS, 'g');
    activeGroup = document.createElementNS(svgNS, 'g');
    mapSvg.append(baseGroup, activeGroup);
    targets = element('div', 'r24-map-targets');
    const controls = element('div', 'r24-map-zoom');
    [['+', 1.4, 'Przybliż mapę', 'Zoom in'], ['−', 1 / 1.4, 'Oddal mapę', 'Zoom out']].forEach(([value, factor, pl, en]) => {
      const control = button('', value, () => { zoom = Math.max(.7, Math.min(12, zoom * factor)); draw(); });
      control.setAttribute('aria-label', text(pl, en));
      controls.append(control);
    });
    stage.append(mapSvg, targets, controls, element('small', 'r24-map-credit', 'Natural Earth'));
    let drag;
    stage.onpointerdown = event => {
      if (event.target.closest('button') || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, pan: [...pan], moved: false };
    };
    stage.onpointermove = event => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) {
        drag.moved = true;
        stage.setPointerCapture(event.pointerId);
        pan = [drag.pan[0] + dx, drag.pan[1] + dy];
        draw();
      }
    };
    stage.onpointerup = event => {
      if (drag?.moved) event.preventDefault();
      drag = null;
    };
    stage.onpointercancel = () => { drag = null; };
    observer?.disconnect();
    if (window.ResizeObserver) {
      observer = new ResizeObserver(draw);
      observer.observe(stage);
    }
  }

  function restoreLegacy() {
    failed = true;
    requestId += 1;
    observer?.disconnect();
    modal?.classList.remove('r24-regions', 'r24-area-selected');
    modal?.querySelector('.r24-map-toolbar')?.remove();
    if (previousTitle) {
      const title = modal.querySelector('.world-map-header h2');
      title.dataset.pl = previousTitle.pl;
      title.dataset.en = previousTitle.en;
      title.textContent = previousTitle[lang()];
    }
    window.openWorldMap = originalOpen;
    window.closeWorldMap = originalClose;
    window.updateWorldExplorerLanguage = originalLanguage;
    return originalOpen();
  }

  async function openMap() {
    if (failed) return originalOpen();
    const id = ++requestId;
    if (modal.style.display !== 'flex') {
      opener = document.activeElement;
      previousOverflow = document.body.style.overflow;
    }
    modal.style.display = 'flex';
    modal.classList.add('r24-regions');
    modal.classList.remove('r24-area-selected');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    const title = document.getElementById('countryLocationsTitle');
    title.removeAttribute('data-pl');
    title.removeAttribute('data-en');
    title.textContent = text('Ładowanie kierunków…', 'Loading destinations…');
    document.getElementById('countryLocations').replaceChildren();
    try {
      const db = window.getRide24SupabaseClient();
      if (!db) throw new Error('Location client unavailable');
      const [data, result] = await Promise.all([
        loadAssets(),
        db.from('partner_locations').select('id,country,region,city,location_name,type').eq('active', true)
      ]);
      if (id !== requestId) return;
      if (result.error) throw result.error;
      geometry = data;
      areas = makeAreas(Array.isArray(result.data) ? result.data : []);
      buildMap();
      showInitialList();
      updateLanguage();
      modal.querySelector('.r24-map-close')?.focus({ preventScroll: true });
    } catch (error) {
      if (id !== requestId) return;
      console.warn('Ride24: restoring the previous map after a region map load error.', error?.message || 'Map unavailable');
      return restoreLegacy();
    }
  }

  function install() {
    modal = document.getElementById('worldMapModal');
    if (!modal || typeof window.openWorldMap !== 'function' || typeof window.selectWorldLocation !== 'function') return;
    originalOpen = window.openWorldMap;
    originalClose = window.closeWorldMap;
    originalLanguage = window.updateWorldExplorerLanguage;
    const heading = modal.querySelector('.world-map-header h2');
    previousTitle = { pl: heading.dataset.pl, en: heading.dataset.en };
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    heading.id = 'ride24RegionMapTitle';
    modal.setAttribute('aria-labelledby', heading.id);
    const oldClose = modal.querySelector('.world-map-header span[onclick]');
    if (oldClose) {
      const close = button('r24-map-close', '×', () => window.closeWorldMap());
      close.setAttribute('aria-label', text('Zamknij mapę', 'Close map'));
      oldClose.replaceWith(close);
    }
    window.openWorldMap = openMap;
    window.closeWorldMap = function () {
      requestId += 1;
      originalClose();
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = previousOverflow;
      opener?.focus?.({ preventScroll: true });
    };
    window.updateWorldExplorerLanguage = function () {
      originalLanguage?.();
      updateLanguage();
    };
    modal.addEventListener('click', event => { if (event.target === modal) window.closeWorldMap(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modal.classList.contains('r24-regions') && modal.style.display !== 'none') {
        event.preventDefault();
        window.closeWorldMap();
      }
    });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        const focusable = [...modal.querySelectorAll('button')].filter(item => !item.disabled && item.getClientRects().length);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    window.Ride24RegionMap = { version: VERSION, areaForLocation, restoreLegacy };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
