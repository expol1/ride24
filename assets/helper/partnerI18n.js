/* Partner panel only. Local, explicit UI translations; no remote translation or IP lookup. */
(function () {
    'use strict';
    const languages = {
        en: {name: 'English', flag: 'uk', locale: 'en-GB'},
        pl: {name: 'Polski', flag: 'pl', locale: 'pl-PL'},
        es: {name: 'Español', flag: 'es', locale: 'es-ES'},
        el: {name: 'Ελληνικά', flag: 'gr', locale: 'el-GR'},
        it: {name: 'Italiano', flag: 'it', locale: 'it-IT'},
        de: {name: 'Deutsch', flag: 'de', locale: 'de-DE'},
        ru: {name: 'Русский', flag: 'ru', locale: 'ru-RU'}
    };
    const catalog = window.Ride24PartnerLocales || {source: {}, languages: {}};
    const storageKey = 'partner_lang';
    const renderers = new Map();
    const excluded = '#ag-content, #signed-agreement-content, #guideModal, [data-partner-original]';
    const selector = '[data-pl][data-en], [data-title-pl][data-title-en], [data-aria-pl][data-aria-en]';
    let initialized = false;
    let menuOpen = false;

    function storedLanguage() {
        try { return localStorage.getItem(storageKey); } catch (_) { return null; }
    }

    function resolveLanguage(stored, preferred) {
        if (Object.hasOwn(languages, stored)) return stored;
        for (const candidate of preferred || []) {
            const code = String(candidate || '').toLowerCase().split(/[-_]/)[0];
            if (Object.hasOwn(languages, code)) return code;
        }
        return 'en';
    }

    let language = resolveLanguage(storedLanguage(), navigator.languages?.length ? navigator.languages : [navigator.language]);
    const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const templates = Object.keys(catalog.source || {}).filter(key => /\{\w+\}/.test(key)).map(key => {
        const names = [];
        let pattern = '', offset = 0;
        for (const match of key.matchAll(/\{(\w+)\}/g)) {
            pattern += escapePattern(key.slice(offset, match.index)) + '([\\s\\S]*?)';
            names.push(match[1]); offset = match.index + match[0].length;
        }
        return {key, names, pattern: new RegExp('^' + pattern + escapePattern(key.slice(offset)) + '$')};
    });

    function format(value, params) {
        return String(value).replace(/\{(\w+)\}/g, (token, name) =>
            params && Object.hasOwn(params, name) ? String(params[name] ?? '') : token);
    }

    function text(pl, en, params) {
        const source = String(en ?? pl ?? '');
        const polish = String(pl ?? catalog.source?.[source] ?? source);
        if (language === 'en') return format(source, params);
        if (language === 'pl') return format(polish, params);
        const dictionary = catalog.languages?.[language] || {};
        if (Object.hasOwn(dictionary, source)) return format(dictionary[source], params);
        const decorated = source.match(/^([^\p{L}\p{N}]+)([\s\S]+)$/u);
        if (decorated && Object.hasOwn(dictionary, decorated[2])) return decorated[1] + format(dictionary[decorated[2]], params);
        // Only known UI templates are matched, never arbitrary page or partner text.
        if (source.length <= 2000) for (const template of templates) {
            const match = template.pattern.exec(source);
            if (!match || !Object.hasOwn(dictionary, template.key)) continue;
            const values = {...params};
            template.names.forEach((name, index) => { values[name] = match[index + 1]; });
            return format(dictionary[template.key], values);
        }
        return format(source, params);
    }

    function write(element, value, attribute) {
        value = String(value ?? '');
        if (attribute === 'textContent' || attribute === 'placeholder' || attribute === 'title') {
            if (element[attribute] !== value) element[attribute] = value;
        } else if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
    }

    function bind(element, pl, en, attribute = 'textContent') {
        if (!element) return element;
        const prefix = attribute === 'title' ? 'data-title-' : attribute === 'aria-label' ? 'data-aria-' : 'data-';
        for (const [code, value] of [['pl', pl], ['en', en ?? pl]]) {
            if (element.getAttribute(prefix + code) !== String(value ?? '')) element.setAttribute(prefix + code, String(value ?? ''));
        }
        write(element, text(pl, en), attribute);
        return element;
    }

    function live(element, render, attribute = 'textContent') {
        if (!element) return element;
        renderers.set(element, {render, attribute});
        write(element, render(), attribute);
        return element;
    }

    function applyElement(element) {
        if (element.closest(excluded)) return;
        if (renderers.has(element)) return;
        if (element.hasAttribute('data-pl') && element.hasAttribute('data-en')) {
            const input = ['INPUT', 'TEXTAREA'].includes(element.tagName);
            // Never touch input values, selected option values, or user-entered content.
            if (!input || element.hasAttribute('placeholder')) {
                if (!(element.disabled && element.textContent.trim() === '...')) {
                    write(element, text(element.dataset.pl, element.dataset.en), input ? 'placeholder' : 'textContent');
                }
            }
        }
        if (element.hasAttribute('data-title-pl')) write(element, text(element.dataset.titlePl, element.dataset.titleEn), 'title');
        if (element.hasAttribute('data-aria-pl')) write(element, text(element.dataset.ariaPl, element.dataset.ariaEn), 'aria-label');
    }

    function apply(root = document) {
        if (root.nodeType === 1 && root.matches(selector)) applyElement(root);
        root.querySelectorAll?.(selector).forEach(applyElement);
        for (const [element, binding] of renderers) {
            if (!element.isConnected) { renderers.delete(element); continue; }
            if (root === document || root === element || root.contains?.(element)) write(element, binding.render(), binding.attribute);
        }
    }

    function updatePicker() {
        const button = document.getElementById('partnerLanguageButton');
        const flag = document.getElementById('partnerLanguageFlag');
        const code = document.getElementById('partnerLanguageCode');
        if (!button || !flag || !code) return;
        flag.src = 'flagi/' + languages[language].flag + '.svg';
        code.textContent = language.toUpperCase();
        button.setAttribute('aria-label', text('Język panelu', 'Panel language') + ': ' + languages[language].name);
        document.getElementById('partnerLanguageMenu')?.setAttribute('aria-label', text('Język panelu', 'Panel language'));
        document.querySelectorAll('[data-partner-language]').forEach(option => {
            option.setAttribute('aria-selected', String(option.dataset.partnerLanguage === language));
            option.tabIndex = option.dataset.partnerLanguage === language ? 0 : -1;
        });
    }

    function closeMenu(restoreFocus = false) {
        const menu = document.getElementById('partnerLanguageMenu');
        if (menu) menu.hidden = true;
        document.getElementById('partnerLanguageButton')?.setAttribute('aria-expanded', 'false');
        menuOpen = false;
        if (restoreFocus) document.getElementById('partnerLanguageButton')?.focus();
    }

    function openMenu() {
        const menu = document.getElementById('partnerLanguageMenu');
        const button = document.getElementById('partnerLanguageButton');
        if (!menu || !button) return;
        menu.hidden = false; menuOpen = true; button.setAttribute('aria-expanded', 'true');
        const box = button.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
        const below = box.bottom + 7;
        menu.style.top = Math.max(8, Math.min(below, window.innerHeight - menu.offsetHeight - 8)) + 'px';
        menu.querySelector('[aria-selected="true"]')?.focus();
    }

    function setLanguage(code, options = {}) {
        if (!Object.hasOwn(languages, code)) return false;
        language = code;
        if (options.persist !== false) try { localStorage.setItem(storageKey, code); } catch (_) { /* Usable with storage blocked. */ }
        document.documentElement.lang = code;
        document.title = text('Ride24 — Panel Partnera', 'Ride24 — Partner Panel');
        apply(); updatePicker(); closeMenu();
        window.Ride24PartnerGuide?.setPanelLanguage?.(code);
        return true;
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        const button = document.getElementById('partnerLanguageButton');
        const menu = document.getElementById('partnerLanguageMenu');
        if (menu) document.body.append(menu); // Outside the scrolling mobile topbar.
        button?.addEventListener('click', () => menuOpen ? closeMenu() : openMenu());
        button?.addEventListener('keydown', event => {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openMenu(); }
        });
        const select = option => {
            const code = option.dataset.partnerLanguage;
            if (typeof window.setLang === 'function') window.setLang(code);
            else setLanguage(code);
            closeMenu(true);
        };
        menu?.addEventListener('click', event => {
            const option = event.target.closest('[data-partner-language]');
            if (option) select(option);
        });
        menu?.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
            if (event.key === 'Tab') { closeMenu(true); return; }
            const options = Array.from(menu.querySelectorAll('[data-partner-language]'));
            const index = options.indexOf(document.activeElement);
            let next;
            if (event.key === 'ArrowDown') next = (index + 1) % options.length;
            if (event.key === 'ArrowUp') next = (index + options.length - 1) % options.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = options.length - 1;
            if (next !== undefined) { event.preventDefault(); options[next].focus(); }
        });
        document.addEventListener('click', event => {
            if (menuOpen && !button?.contains(event.target) && !menu?.contains(event.target)) closeMenu();
        });
        window.addEventListener('resize', () => closeMenu());
        document.addEventListener('scroll', event => { if (menuOpen && !menu?.contains(event.target)) closeMenu(); }, true);
        window.addEventListener('storage', event => {
            if (event.key !== storageKey) return;
            setLanguage(resolveLanguage(event.newValue, navigator.languages || [navigator.language]), {persist: false});
        });
        setLanguage(language, {persist: false});
        const observer = new MutationObserver(records => {
            const roots = new Set();
            for (const record of records) {
                if (record.type === 'attributes') roots.add(record.target);
                else for (const node of record.addedNodes) if (node.nodeType === 1) roots.add(node);
            }
            for (const root of roots) if (root.isConnected) apply(root);
        });
        observer.observe(document.body, {childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-pl', 'data-en', 'data-title-pl', 'data-title-en', 'data-aria-pl', 'data-aria-en']});
    }

    window.Ride24PartnerI18n = {text, bind, live, apply, setLanguage, initialize, resolveLanguage,
        getLanguage: () => language, locale: () => languages[language].locale,
        supported: Object.freeze(Object.keys(languages))};
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once: true});
    else initialize();
})();
