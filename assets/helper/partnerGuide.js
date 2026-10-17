/* Illustrated partner guide. Read-only: no auth, booking or database operations. */
(function () {
    'use strict';

    const version = '20261017';
    const storageKey = 'ride24_partner_guide_language';
    const languages = ['pl', 'en', 'it', 'fr', 'el', 'ru', 'es', 'de'];
    const scriptURL = document.currentScript && document.currentScript.src;
    const assetBase = new URL('../partner-guide/', scriptURL || new URL('assets/helper/partnerGuide.js', document.baseURI));
    let data = null;
    let loading = null;
    let language = null;
    let panelLanguage = 'en';
    let chapterId = 'welcome';
    let isApi = false;
    let isOpen = false;
    let previousFocus = null;
    let previousOverflow = '';
    let bound = false;

    const element = (tag, className, text) => {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    const byId = id => document.getElementById(id);
    const modal = () => byId('guideModal');
    const visibleChapters = () => data.languages[language].chapters.filter(chapter =>
        !chapter.audience || chapter.audience === (isApi ? 'api' : 'local'));
    const ui = () => data.languages[language].ui;
    const button = (label, action) => {
        const item = element('button', 'r24-guide-button', label);
        item.type = 'button';
        item.addEventListener('click', action);
        return item;
    };

    function storedLanguage() {
        try {
            const stored = localStorage.getItem(storageKey);
            return languages.includes(stored) ? stored : null;
        } catch (_) { return null; }
    }

    function status(error) {
        const isPl = panelLanguage === 'pl';
        const host = byId('guideContent');
        const card = element('div', 'guide-card');
        const message = element('p', '', error
            ? (isPl ? 'Nie udało się wczytać instrukcji. Spróbuj ponownie.' : 'The guide could not be loaded. Please try again.')
            : (isPl ? 'Ładowanie instrukcji…' : 'Loading the guide…'));
        message.setAttribute('role', error ? 'alert' : 'status');
        card.append(message);
        if (error) card.append(button(isPl ? 'Spróbuj ponownie' : 'Try again', load));
        host.replaceChildren(card);
        host.lang = isPl ? 'pl' : 'en';
    }

    function validate(value) {
        if (!value || !value.images || !value.languages) throw new Error('Invalid guide');
        const expectedIds = value.languages.en && value.languages.en.chapters.map(ch => ch.id).join(',');
        for (const code of languages) {
            const locale = value.languages[code];
            if (!locale || !locale.ui || !Array.isArray(locale.chapters) ||
                locale.chapters.map(ch => ch.id).join(',') !== expectedIds) throw new Error('Incomplete guide');
            for (const chapter of locale.chapters) {
                if (!chapter.title || !Array.isArray(chapter.paragraphs)) throw new Error('Invalid chapter');
                if (chapter.image) {
                    const image = value.images[chapter.image];
                    if (!image || !/^[a-z0-9-]+\.webp$/.test(image.src) || image.width <= 0 || image.height <= 0) {
                        throw new Error('Invalid screenshot');
                    }
                }
            }
        }
        return value;
    }

    async function load() {
        if (data) { render(); return; }
        if (loading) return loading;
        status(false);
        loading = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 12000);
            try {
                const response = await fetch(new URL('manual.json?v=' + version, assetBase), {
                    credentials: 'omit', signal: controller.signal
                });
                if (!response.ok) throw new Error('Guide unavailable');
                data = validate(await response.json());
                render();
            } catch (_) {
                status(true);
            } finally {
                clearTimeout(timer);
                loading = null;
            }
        })();
        return loading;
    }

    function renderNavigation(chapters) {
        const navigation = byId('guideNavigation');
        const select = byId('guideChapter');
        const fragment = document.createDocumentFragment();
        const options = document.createDocumentFragment();
        chapters.forEach((chapter, index) => {
            const active = chapter.id === chapterId;
            const tab = element('button', 'guide-tab' + (active ? ' active' : ''));
            tab.type = 'button';
            tab.dataset.chapter = chapter.id;
            tab.append(element('span', 'r24-guide-number', String(index + 1).padStart(2, '0')),
                element('span', '', chapter.title));
            if (active) tab.setAttribute('aria-current', 'page');
            tab.addEventListener('click', () => goTo(chapter.id));
            fragment.append(tab);
            const option = element('option', '', (index + 1) + '. ' + chapter.title);
            option.value = chapter.id;
            option.selected = active;
            options.append(option);
        });
        navigation.replaceChildren(fragment);
        select.replaceChildren(options);
        navigation.setAttribute('aria-label', ui().chapter);
        // Scroll only the chapter list, never the page behind the modal.
        const active = navigation.querySelector('[aria-current]');
        if (active) {
            const top = active.offsetTop - navigation.offsetTop;
            if (top < navigation.scrollTop || top + active.offsetHeight > navigation.scrollTop + navigation.clientHeight) {
                navigation.scrollTop = Math.max(0, top - 24);
            }
        }
    }

    function screenshot(chapter) {
        const info = data.images[chapter.image];
        const figure = element('figure', 'r24-guide-figure' + (info.height > info.width ? ' r24-guide-portrait' : ''));
        const caption = element('figcaption', 'r24-guide-caption');
        caption.append(element('span', '', chapter.id === 'voucher' ? ui().example : ui().screenshot));
        const viewport = element('div', 'r24-guide-image-viewport');
        viewport.tabIndex = 0;
        viewport.setAttribute('role', 'region');
        viewport.setAttribute('aria-label', ui().screenshot + ': ' + chapter.title);
        const img = element('img');
        img.alt = ui().screenshot + ': ' + chapter.title;
        img.width = info.width;
        img.height = info.height;
        img.decoding = 'async';
        img.src = new URL(info.src, assetBase).href;
        const enlarge = button(ui().zoom, () => {
            const zoomed = figure.classList.toggle('r24-guide-zoomed');
            enlarge.textContent = zoomed ? ui().fit : ui().zoom;
            enlarge.setAttribute('aria-pressed', String(zoomed));
        });
        enlarge.setAttribute('aria-pressed', 'false');
        caption.append(enlarge);
        viewport.append(img);
        img.addEventListener('error', () => {
            const oldRetry = viewport.querySelector('button');
            if (oldRetry) oldRetry.remove();
            const retry = button(ui().retry, () => {
                retry.remove();
                img.hidden = false;
                img.src = new URL(info.src + '?retry=' + Date.now(), assetBase).href;
            });
            img.hidden = true;
            retry.textContent = ui().imageError + ' ' + ui().retry;
            viewport.append(retry);
        });
        figure.append(caption, viewport);
        return figure;
    }

    function render(focusContent = false) {
        if (!data) return;
        const root = modal();
        const chapters = visibleChapters();
        if (!chapters.some(ch => ch.id === chapterId)) chapterId = 'welcome';
        const index = chapters.findIndex(ch => ch.id === chapterId);
        const chapter = chapters[index];
        root.lang = language;
        byId('guideTitle').textContent = ui().title;
        byId('guideLanguageLabel').textContent = ui().language;
        byId('guideLanguage').value = language;
        byId('guideChapterLabel').textContent = ui().chapter;
        root.querySelector('.guide-close').setAttribute('aria-label', ui().close);
        renderNavigation(chapters);

        const article = element('article', 'guide-section active r24-guide-article');
        const stepper = element('div', 'r24-guide-stepper');
        stepper.append(element('span', 'r24-guide-progress', ui().chapter + ' ' + (index + 1) + ' / ' + chapters.length));
        const actions = element('div', 'r24-guide-step-actions');
        const previous = button('←', () => goTo(chapters[index - 1].id));
        previous.setAttribute('aria-label', ui().previous);
        previous.title = ui().previous;
        previous.disabled = index === 0;
        const next = button('→', () => goTo(chapters[index + 1].id));
        next.setAttribute('aria-label', ui().next);
        next.title = ui().next;
        next.disabled = index === chapters.length - 1;
        actions.append(previous, next);
        stepper.append(actions);
        const card = element('div', 'guide-card r24-guide-copy');
        const heading = element('h3', '', chapter.title);
        heading.tabIndex = -1;
        card.append(heading);
        if (isApi && chapter.id === 'welcome') card.append(element('p', 'r24-guide-note', ui().apiNote));
        for (const paragraph of chapter.paragraphs) card.append(element('p', '', paragraph));
        if (chapter.support) {
            const link = element('a', 'r24-guide-support', 'kontakt@ride24.pl');
            link.href = 'mailto:kontakt@ride24.pl';
            card.append(link);
        }
        article.append(stepper, card);
        if (chapter.image) article.append(screenshot(chapter));
        const host = byId('guideContent');
        host.removeAttribute('lang');
        host.replaceChildren(article);
        host.scrollTop = 0;
        if (focusContent && isOpen) heading.focus({preventScroll: true});
    }

    function goTo(id) {
        if (!data || !visibleChapters().some(ch => ch.id === id)) return;
        chapterId = id;
        render(true);
    }

    function bind() {
        if (bound) return;
        bound = true;
        byId('guideLanguage').addEventListener('change', event => {
            if (!languages.includes(event.target.value)) return;
            language = event.target.value;
            try { localStorage.setItem(storageKey, language); } catch (_) { /* Private browsing. */ }
            if (data) render();
        });
        byId('guideChapter').addEventListener('change', event => goTo(event.target.value));
        document.addEventListener('keydown', event => {
            if (!isOpen) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                window.closeGuide();
            } else if (event.key === 'Tab') {
                const focusable = Array.from(modal().querySelectorAll('button, select, a[href], [tabindex="0"]'))
                    .filter(item => !item.disabled && item.getClientRects().length);
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (first && event.shiftKey && (document.activeElement === first || !modal().contains(document.activeElement))) {
                    event.preventDefault(); last.focus();
                } else if (last && !event.shiftKey && (document.activeElement === last || !modal().contains(document.activeElement))) {
                    event.preventDefault(); first.focus();
                }
            }
        });
    }

    window.Ride24PartnerGuide = {
        open(options = {}) {
            panelLanguage = options.panelLanguage === 'pl' ? 'pl' : 'en';
            isApi = options.isApi === true;
            language = language || storedLanguage() || panelLanguage;
            bind();
            if (!isOpen) {
                previousFocus = document.activeElement;
                previousOverflow = document.body.style.overflow;
            }
            isOpen = true;
            modal().inert = false;
            modal().setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
            byId('guideLanguage').value = language;
            byId('guideLanguage').focus({preventScroll: true});
            return load();
        },
        close() {
            isOpen = false;
            modal().setAttribute('aria-hidden', 'true');
            modal().inert = true;
            document.body.style.overflow = previousOverflow;
            if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll: true});
        },
        setPartnerType(api) {
            isApi = api === true;
            if (data) render();
        },
        goTo
    };
})();
