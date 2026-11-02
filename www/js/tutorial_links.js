/** Optional online reading; locale and routes never come from arbitrary URLs. */
(function () {
    'use strict';

    const BASE = 'https://s243a.github.io/SciREPL/help/';
    const LOCALES = new Set(['ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id',
        'ja', 'ko', 'pt-BR', 'ru', 'zh']);
    // Free deliberately offers no Pro-only AI or completion walkthrough.
    const ROUTES = Object.freeze({
        index: 'tutorials/?edition=free',
        import: 'workbooks/import/?edition=free',
    });

    function url(guide, locale = window.i18n?.current) {
        if (!Object.prototype.hasOwnProperty.call(ROUTES, guide)) {
            throw new TypeError('Unknown tutorial guide');
        }
        const code = LOCALES.has(locale) ? locale : 'en';
        return BASE + code + '/' + ROUTES[guide];
    }

    function update(root = document) {
        for (const anchor of root.querySelectorAll('a[data-tutorial-guide]')) {
            const guide = anchor.getAttribute('data-tutorial-guide');
            if (!Object.prototype.hasOwnProperty.call(ROUTES, guide)) continue;
            anchor.href = url(guide);
        }
    }

    window.scireplTutorials = Object.freeze({ url, update });
    document.addEventListener('i18n:changed', () => update());
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => update(), { once: true });
    } else {
        update();
    }
})();
