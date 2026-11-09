/* Ride24 region map. Read-only location data; the existing search selection is retained. */
(() => {
  'use strict';

  // Emergency switch: false restores the previous map without changing any data.
  const ENABLED = true;
  const VERSION = '20261109-islands1';
  const legacyRequested = new URLSearchParams(window.location.search).get('ride24Map') === 'legacy';
  if (!ENABLED || legacyRequested) return;

  const scriptUrl = document.currentScript?.src || new URL('assets/js/world-map-regions.js', document.baseURI).href;
  const assetRoot = new URL('../', scriptUrl);
  const svgNS = 'http://www.w3.org/2000/svg';
  let geometryPromise;
  let islandAtlasPromise;
  let islandAtlas = null;
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
  // Reuse the local PL/EN registry, without additional requests or map changes.
  const countryLabelsByCode = new Map(Object.values(window.RIDE24_COUNTRIES || {})
    .filter(country => country?.code)
    .map(country => [country.code, country]));

  function hoveredCountryName(target) {
    const shape = target?.closest?.('.r24-map-coverage, .r24-map-land, .r24-map-target');
    if (!shape || !stage?.contains(shape)) return '';
    const area = areas.find(item => item.id === shape.dataset.area);
    if (area) return label(area);
    const code = shape.dataset.country;
    if (code === 'CY-NORTH') return text('Cypr północny', 'Northern Cyprus');
    return countryLabelsByCode.get(code)?.[lang()] || shape.dataset.countryName || '';
  }

  // Island detection is based on the partner's actual pickup location, never on
  // country-level activation. Unknown island names remain in the destination list
  // without colouring the entire parent country.
  const ISLANDS = {
    'ES-MALLORCA': { pl:'Majorka', en:'Mallorca', country:'724', box:[2.15,39.2,3.65,40.1] },
    'ES-MENORCA': { pl:'Minorka', en:'Menorca', country:'724', box:[3.7,39.7,4.5,40.25] },
    'ES-IBIZA': { pl:'Ibiza', en:'Ibiza', country:'724', box:[1.1,38.75,1.8,39.2] },
    'ES-FORMENTERA': { pl:'Formentera', en:'Formentera', country:'724', box:[1.3,38.6,1.6,38.82] },
    'ES-TENERIFE': { pl:'Teneryfa', en:'Tenerife', country:'724', box:[-16.95,27.98,-16.05,28.75] },
    'ES-GRAN-CANARIA': { pl:'Gran Canaria', en:'Gran Canaria', country:'724', box:[-15.95,27.65,-15.25,28.35] },
    'ES-LANZAROTE': { pl:'Lanzarote', en:'Lanzarote', country:'724', box:[-13.96,28.75,-13.3,29.27] },
    'ES-FUERTEVENTURA': { pl:'Fuerteventura', en:'Fuerteventura', country:'724', box:[-14.6,27.8,-13.7,28.82] },
    'ES-LA-PALMA': { pl:'La Palma', en:'La Palma', country:'724', box:[-18.15,28.4,-17.65,28.95] },
    'ES-LA-GOMERA': { pl:'La Gomera', en:'La Gomera', country:'724', box:[-17.42,27.98,-17.05,28.27] },
    'ES-EL-HIERRO': { pl:'El Hierro', en:'El Hierro', country:'724', box:[-18.2,27.55,-17.78,27.85] },
    'GR-CRETE': { pl:'Kreta', en:'Crete', country:'300', box:[23.4,34.8,26.5,35.8] },
    'GR-CORFU': { pl:'Korfu', en:'Corfu', country:'300', box:[19.6,39.3,20.3,39.9] },
    'TZ-ZANZIBAR': { pl:'Zanzibar', en:'Zanzibar', country:'834', box:[39.15,-6.55,39.75,-5.65] },
    'TZ-PEMBA': { pl:'Pemba', en:'Pemba', country:'834', box:[39.4,-5.55,40,-4.7] },
    'PT-PORTO-SANTO': { pl:'Porto Santo', en:'Porto Santo', region:'PT-MADEIRA', box:[-16.65,32.4,-16.2,32.7] },
    'PT-SAO-MIGUEL': { pl:'São Miguel', en:'São Miguel', region:'PT-AZORES', box:[-25.95,37.65,-25.05,38] },
    'PT-TERCEIRA': { pl:'Terceira', en:'Terceira', region:'PT-AZORES', box:[-27.5,38.55,-26.9,38.9] },
    'PT-FAIAL': { pl:'Faial', en:'Faial', region:'PT-AZORES', box:[-28.95,38.45,-28.5,38.75] },
    'PT-PICO': { pl:'Pico', en:'Pico', region:'PT-AZORES', box:[-28.6,38.3,-27.7,38.65] },
    'PT-SANTA-MARIA': { pl:'Santa Maria', en:'Santa Maria', region:'PT-AZORES', box:[-25.3,36.85,-24.95,37.1] },
    'PT-SAO-JORGE': { pl:'São Jorge', en:'São Jorge', region:'PT-AZORES', box:[-28.2,38.5,-27.7,38.85] },
    'PT-GRACIOSA': { pl:'Graciosa', en:'Graciosa', region:'PT-AZORES', box:[-28.2,38.95,-27.9,39.2] },
    'PT-FLORES': { pl:'Flores', en:'Flores', region:'PT-AZORES', box:[-31.35,39.25,-31.05,39.6] },
    'PT-CORVO': { pl:'Corvo', en:'Corvo', region:'PT-AZORES', box:[-31.25,39.55,-31.0,39.82] }
  };

  function areaForLocation(row) {
    const country = countryOf(row);
    const region = key(row.region);
    const city = key(row.city);
    const name = key(row.location_name);
    const place = [region,city,name].join('_');
    const has = expression => expression.test(place);
    if (country === 'Spain') {
      if (has(/mallorca|majorca|majorka|palma_de_mallorca|(?:^|_)pmi(?:_|$)|alcudia|calvia|manacor|porto_cristo|paguera/)) return 'ES-MALLORCA';
      if (has(/menorca|minorca|minorka|mahon|mao|ciutadella|(?:^|_)mah(?:_|$)/)) return 'ES-MENORCA';
      if (has(/formentera/)) return 'ES-FORMENTERA';
      if (has(/ibiza|eivissa|(?:^|_)ibz(?:_|$)/)) return 'ES-IBIZA';
      if (has(/tenerife|teneryfa|(?:^|_)tfs(?:_|$)|(?:^|_)tfn(?:_|$)|santa_cruz_de_tenerife|puerto_de_la_cruz/)) return 'ES-TENERIFE';
      if (has(/gran_canaria|las_palmas|maspalomas|(?:^|_)lpa(?:_|$)/)) return 'ES-GRAN-CANARIA';
      if (has(/lanzarote|arrecife|(?:^|_)ace(?:_|$)/)) return 'ES-LANZAROTE';
      if (has(/fuerteventura|corralejo|puerto_del_rosario|(?:^|_)fue(?:_|$)/)) return 'ES-FUERTEVENTURA';
      if (has(/la_palma|santa_cruz_de_la_palma|(?:^|_)spc(?:_|$)/)) return 'ES-LA-PALMA';
      if (has(/la_gomera|san_sebastian_de_la_gomera|(?:^|_)gmz(?:_|$)/)) return 'ES-LA-GOMERA';
      if (has(/el_hierro|valverde|(?:^|_)vde(?:_|$)/)) return 'ES-EL-HIERRO';
      if (has(/canarias|canary|balear|baleares|cabrera|la_graciosa/)) return 'ES-ISLAND-UNSPECIFIED';
      return 'ES';
    }
    if (country === 'Greece') {
      if (has(/corfu|korfu|kerkyra|kerkira|(?:^|_)cfu(?:_|$)|paleokastritsa/)) return 'GR-CORFU';
      if (has(/creta|crete|kreta|heraklion|iraklio|chania|chani|rethym|agios_nikolaos|(?:^|_)her(?:_|$)|(?:^|_)chq(?:_|$)/)) return 'GR-CRETE';
      if (has(/rhodes|rodos|santorini|thira|mykonos|mikonos|naxos|paros|zakynthos|zante|kefalonia|cephalonia|kos|lesbos|samos|skiathos|skopelos|lefkas|lefkada|kefalonia|aegina|andros|milos|ios|karpathos|patmos|chios|island|wyspa/)) return 'GR-ISLAND-UNSPECIFIED';
      return 'GR-MAINLAND';
    }
    if (country === 'Tanzania') {
      if (has(/pemba|chake_chake|(?:^|_)pma(?:_|$)/)) return 'TZ-PEMBA';
      if (has(/zanzibar|unguja|stone_town|nungwi|kendwa|(?:^|_)znz(?:_|$)/)) return 'TZ-ZANZIBAR';
      if (has(/mafia_island|kilindoni|chole_island/)) return 'TZ-ISLAND-UNSPECIFIED';
      return 'TZ-MAINLAND';
    }
    if (country === 'Portugal') {
      if (has(/sao_miguel|ponta_delgada|ribeira_grande|(?:^|_)pdl(?:_|$)/)) return 'PT-SAO-MIGUEL';
      if (has(/terceira|angra_do_heroismo|praia_da_vitoria|(?:^|_)ter(?:_|$)/)) return 'PT-TERCEIRA';
      if (has(/faial|horta|(?:^|_)hor(?:_|$)/)) return 'PT-FAIAL';
      if (has(/pico|madalena|lajes_do_pico|(?:^|_)pix(?:_|$)/)) return 'PT-PICO';
      if (has(/santa_maria|vila_do_porto|(?:^|_)sma(?:_|$)/)) return 'PT-SANTA-MARIA';
      if (has(/sao_jorge|velas|(?:^|_)sjz(?:_|$)/)) return 'PT-SAO-JORGE';
      if (has(/graciosa|santa_cruz_da_graciosa|(?:^|_)gru(?:_|$)/)) return 'PT-GRACIOSA';
      if (has(/flores|santa_cruz_das_flores|(?:^|_)flw(?:_|$)/)) return 'PT-FLORES';
      if (has(/corvo|vila_do_corvo|(?:^|_)cvu(?:_|$)/)) return 'PT-CORVO';
      if (has(/azores|azory|acores/)) return 'PT-AZORES-UNSPECIFIED';
      if (has(/porto_santo|(?:^|_)pxo(?:_|$)/)) return 'PT-PORTO-SANTO';
      if (has(/madeira|madera|funchal|camara_de_lobos|(?:^|_)fnc(?:_|$)/)) return 'PT-MADEIRA';
      return 'PT';
    }
    if (country === 'Italy') {
      if (/sicil|sycyl/.test(region) || /^(palermo|catania|trapani|messina|siracusa|syracuse|ragusa|taormina|agrigento)$/.test(city) || /palermo|catania|trapani/.test(name)) return 'IT-SICILY';
      if (/sardini|sardegn|sardyni/.test(region) || /^(cagliari|olbia|alghero|sassari)$/.test(city) || /cagliari|olbia|alghero/.test(name)) return 'IT-SARDINIA';
      if (has(/elba|capri|ischia|lampedusa|pantelleria|aeolian_islands|lipari|stromboli/)) return 'IT-ISLAND-UNSPECIFIED';
      return 'IT';
    }
    if (country === 'Cyprus') {
      if (/north|northern|polnoc|kuzey/.test(region + '_' + city) || /^(kyrenia|girne|famagusta|gazimagusa|lefke)$/.test(city) || /ercan/.test(name)) return 'CY-NORTH';
      return 'CY';
    }
    return countryCode(country) || 'COUNTRY-' + key(country);
  }

  // Natural Earth 50m TopoJSON supplies coastal islands absent from the older
  // background map. Load once and use only the required country polygons.
  function unpackAtlasCountry(numericId) {
    if (!islandAtlas) return null;
    const topology = islandAtlas;
    const object = topology.objects?.countries?.geometries?.find(x => x.id === numericId);
    if (!object) return null;
    const arcCache = new Map();
    function arc(index) {
      const reversed = index < 0;
      const n = reversed ? ~index : index;
      if (!arcCache.has(n)) {
        let x=0,y=0;
        const points=topology.arcs[n].map(pair => {
          x+=pair[0];y+=pair[1];
          return [x*topology.transform.scale[0]+topology.transform.translate[0],
            y*topology.transform.scale[1]+topology.transform.translate[1]];
        });
        arcCache.set(n, points);
      }
      const points = arcCache.get(n);
      return reversed ? [...points].reverse() : points;
    }
    const polygon = rings => rings.map(parts => {
      const coords=[];
      parts.forEach((index,i) => coords.push(...arc(index).slice(i ? 1 : 0)));
      return coords;
    });
    const coords = object.type==='Polygon' ? [polygon(object.arcs)] : object.arcs.map(polygon);
    return coords;
  }

  function shapeForIsland(id) {
    const config = ISLANDS[id];
    if (!config) return null;
    if (id === 'GR-CRETE') {
      const source = geometry.countries.find(x=>x.properties.code==='GR');
      const coords=source?.geometry?.coordinates;
      if (source?.geometry?.type==='MultiPolygon' && coords?.length>1) {
        return {type:'Polygon',coordinates:coords[0]};
      }
    }
    const source = config.region
      ? geometry.regions.find(x => x.id === config.region)?.geometry
      : null;
    const polygons = source
      ? (source.type==='Polygon' ? [source.coordinates] : source.coordinates)
      : unpackAtlasCountry(config.country);
    if (!polygons) return null;
    const [minX,minY,maxX,maxY]=config.box;
    const matching = polygons.filter(polygon => {
      const ring=polygon[0];
      if (!ring?.length) return false;
      const xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);
      const x=(Math.min(...xs)+Math.max(...xs))/2, y=(Math.min(...ys)+Math.max(...ys))/2;
      return x>=minX && x<=maxX && y>=minY && y<=maxY;
    });
    if (!matching.length) return null;
    return matching.length===1
      ? {type:'Polygon',coordinates:matching[0]}
      : {type:'MultiPolygon',coordinates:matching};
  }

  function featureForArea(id) {
    if (ISLANDS[id]) {
      const shape=shapeForIsland(id);
      return shape && {type:'Feature', properties:{id}, geometry:shape};
    }
    if (id==='GR-MAINLAND') {
      const f=geometry.countries.find(x=>x.properties.code==='GR');
      if (f?.geometry?.type==='MultiPolygon') return {type:'Feature',properties:{id},geometry:{type:'Polygon',coordinates:f.geometry.coordinates[1]}};
    }
    if (id==='TZ-MAINLAND') {
      const f=geometry.countries.find(x=>x.properties.code==='TZ');
      if (f) return {...f,properties:{...f.properties,id}};
    }
    const region=geometry.regions.find(x=>x.id===id);
    if (region) return {type:'Feature',properties:{id},geometry:region.geometry};
    return geometry.countries.find(x=>x.properties.code===id) || null;
  }

  function makeAreas(rows) {
    const grouped = new Map();
    rows.filter(row => row.location_name).forEach(row => {
      const id = areaForLocation(row);
      if (!grouped.has(id)) {
        const region = geometry.regions.find(item => item.id === id);
        const country = countryOf(row);
        grouped.set(id, {
          id, country, pl: ISLANDS[id]?.pl || region?.pl || (id.endsWith('-UNSPECIFIED') ? row.region || row.city || row.country : (id==='GR-MAINLAND' ? 'Grecja kontynentalna' : id==='TZ-MAINLAND' ? 'Tanzania kontynentalna' : undefined)), en: ISLANDS[id]?.en || region?.en || (id.endsWith('-UNSPECIFIED') ? row.region || row.city || row.country : (id==='GR-MAINLAND' ? 'Mainland Greece' : id==='TZ-MAINLAND' ? 'Mainland Tanzania' : undefined)),
          feature: featureForArea(id),
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
    if (!islandAtlasPromise) {
      // Optional fine-scale overlay: failure never colours an entire country.
      islandAtlasPromise = fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json')
        .then(r => {if (!r.ok) throw new Error('Natural Earth atlas unavailable'); return r.json();})
        .then(data => {if (data?.type !== 'Topology' || !data?.objects?.countries) throw new Error('Invalid island atlas'); return data;})
        .catch(err => {console.warn('Ride24 fine island outlines unavailable:', err.message);return null;});
    }
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
    return Promise.all([dependenciesPromise, geometryPromise, islandAtlasPromise]).then(([, data, atlas]) => {islandAtlas = atlas;return data;});
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

  function appendAreaName(container, area, compact = false) {
    const code = countryCode(area.country);
    if (/^[A-Z]{2}$/.test(code || '')) {
      const flag = element('img', 'r24-map-flag');
      flag.src = new URL('flags/' + code.toLowerCase() + '.svg', assetRoot).href;
      flag.alt = '';
      flag.width = 22;
      flag.height = 16;
      flag.setAttribute('aria-hidden', 'true');
      flag.addEventListener('error', () => flag.remove(), { once: true });
      container.append(flag);
    }
    const name = compact && area.id === 'PT' ? text('Portugalia', 'Portugal') : label(area);
    container.append(element('span', 'r24-area-label', name));
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
        const item = button('r24-area-choice', undefined, () => chooseArea(area.id));
        appendAreaName(item, area, true);
        item.dataset.area = area.id;
        chooser.append(item);
      });
      panel.append(chooser);
      return;
    }
    title.replaceChildren();
    appendAreaName(title, selectedArea);
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
        } else {
          node.dataset.country = feature.properties.code || '';
          node.dataset.countryName = feature.properties.name || '';
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
    const countryTooltip = element('div', 'r24-map-country-tooltip');
    countryTooltip.hidden = true;
    countryTooltip.setAttribute('aria-hidden', 'true');
    const hideTooltip = () => { countryTooltip.hidden = true; };
    const showTooltip = event => {
      const name = hoveredCountryName(event.target);
      if (!name) return hideTooltip();
      countryTooltip.textContent = name;
      countryTooltip.hidden = false;
      const rect = stage.getBoundingClientRect();
      const halfWidth = countryTooltip.offsetWidth / 2 + 8;
      const x = Math.max(halfWidth, Math.min(rect.width - halfWidth, event.clientX - rect.left));
      const y = Math.max(countryTooltip.offsetHeight + 8, event.clientY - rect.top - 12);
      countryTooltip.style.left = x + 'px';
      countryTooltip.style.top = y + 'px';
    };
    stage.append(mapSvg, targets, controls, element('small', 'r24-map-credit', 'Natural Earth'), countryTooltip);
    let drag;
    stage.onpointerdown = event => {
      hideTooltip();
      if (event.target.closest('button') || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, pan: [...pan], moved: false };
    };
    stage.onpointermove = event => {
      if (!drag) {
        if (event.pointerType !== 'touch') showTooltip(event);
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) {
        drag.moved = true;
        stage.setPointerCapture(event.pointerId);
        pan = [drag.pan[0] + dx, drag.pan[1] + dy];
        hideTooltip();
        draw();
      }
    };
    stage.onpointerup = event => {
      if (drag?.moved) {
        event.preventDefault();
        hideTooltip();
      } else if (event.pointerType === 'touch') {
        // A tap on an inactive country shows its name; active-area clicks still work.
        showTooltip(event);
      }
      drag = null;
    };
    stage.onpointercancel = () => { drag = null; hideTooltip(); };
    stage.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'touch') hideTooltip();
    });
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
