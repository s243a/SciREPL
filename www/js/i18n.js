/**
 * i18n.js — localization: language detection, string lookup, RTL.
 *
 * Two decisions worth stating up front, because both came from a specific
 * concern: that a user picks their language and gets a mostly-English UI.
 *
 * 1. A locale is only offered once it is actually translated. Every catalogue
 *    is scored against English, and anything below MIN_COMPLETENESS is hidden
 *    from the picker rather than listed and disappointing. Partial locales
 *    between the thresholds are listed with their percentage, so the choice is
 *    informed rather than a surprise.
 *
 * 2. Some things must NOT be translated, and the catalogues reflect that. File
 *    extensions (.srwb, .ipynb, .py) and kernel names (Python, Bash, Prolog)
 *    are identifiers, not prose — they stay literal in every locale. In a
 *    right-to-left script this matters visibly: the Latin extension keeps its
 *    own direction inside the surrounding RTL sentence, and translators are
 *    told so in the catalogue itself rather than having to guess.
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'scirepl_language';
    const BASE_LOCALE = 'en';

    /** Below this, a locale is not offered at all. */
    const MIN_COMPLETENESS = 0.8;
    /** Between this and 1.0 it is offered, but labelled partial. */
    const PARTIAL_THRESHOLD = 1.0;

    /**
     * Locales that ship with the app. `dir` drives document direction.
     * `endonym` is the language's own name for itself — a picker that says
     * "Spanish" is no use to someone who only reads Spanish.
     */
    const LOCALES = [
        { code: 'en', endonym: 'English', english: 'English', dir: 'ltr' },
        { code: 'es', endonym: 'Español', english: 'Spanish', dir: 'ltr' },
    ];

    class I18n {
        constructor() {
            this.catalogues = {};      // code -> { key: string }
            this.completeness = {};    // code -> 0..1
            this.current = BASE_LOCALE;
            this._ready = null;
        }

        /* --------------------------- detection --------------------------- */

        /** Stored choice, or 'auto'. */
        getPreference() {
            return localStorage.getItem(STORAGE_KEY) || 'auto';
        }

        setPreference(code) {
            if (code === 'auto') localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, code);
        }

        /**
         * Resolve the preference to a locale that actually exists and is
         * complete enough to use. Falls back through the language subtag
         * (es-MX -> es) before giving up on English.
         */
        resolve(preference = this.getPreference()) {
            const usable = (code) =>
                this.catalogues[code] && this.completeness[code] >= MIN_COMPLETENESS;

            if (preference !== 'auto') {
                if (usable(preference)) return preference;
                const base = String(preference).split('-')[0];
                if (usable(base)) return base;
                return BASE_LOCALE;
            }

            const wanted = navigator.languages && navigator.languages.length
                ? navigator.languages
                : [navigator.language || BASE_LOCALE];

            for (const tag of wanted) {
                if (usable(tag)) return tag;
                const base = String(tag).split('-')[0];
                if (usable(base)) return base;
            }
            return BASE_LOCALE;
        }

        /** What `auto` would pick right now, for showing in the picker. */
        detected() {
            return this.resolve('auto');
        }

        /* --------------------------- catalogues -------------------------- */

        async load(code) {
            if (this.catalogues[code]) return this.catalogues[code];
            try {
                const res = await fetch(`i18n/${code}.json`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.catalogues[code] = data.strings || {};
                this._score(code);
                return this.catalogues[code];
            } catch (e) {
                console.warn(`[i18n] could not load '${code}':`, e.message);
                this.catalogues[code] = null;
                this.completeness[code] = 0;
                return null;
            }
        }

        /**
         * Fraction of English keys that this locale translates to something
         * different. A value identical to English counts as untranslated —
         * which is the check that stops a stub catalogue looking complete.
         *
         * Keys marked `!` in the catalogue's `literal` list are exempt: they are
         * meant to be identical (file extensions, product names), so counting
         * them as untranslated would understate real coverage.
         */
        _score(code) {
            const base = this.catalogues[BASE_LOCALE];
            const target = this.catalogues[code];
            if (!base || !target) { this.completeness[code] = 0; return; }
            if (code === BASE_LOCALE) { this.completeness[code] = 1; return; }

            const literal = new Set(target.__literal || []);
            const keys = Object.keys(base).filter((k) => !k.startsWith('__') && !literal.has(k));
            if (!keys.length) { this.completeness[code] = 1; return; }

            let done = 0;
            for (const k of keys) {
                const v = target[k];
                if (typeof v === 'string' && v.trim() && v !== base[k]) done++;
            }
            this.completeness[code] = done / keys.length;
        }

        /* ---------------------------- lookup ----------------------------- */

        /**
         * Translate. Falls back to English, then to the key itself, so a missing
         * string degrades to something readable rather than blank.
         *
         * `t('menu.appearance')` or with substitution:
         * `t('appearance.scalePercent', { percent: 150 })`
         */
        t(key, vars) {
            const cat = this.catalogues[this.current] || {};
            const base = this.catalogues[BASE_LOCALE] || {};
            let out = cat[key];
            if (typeof out !== 'string' || !out) out = base[key];
            if (typeof out !== 'string') return key;
            if (vars) {
                out = out.replace(/\{(\w+)\}/g, (m, name) =>
                    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
            }
            return out;
        }

        /* --------------------------- activation -------------------------- */

        /** Locales worth showing in the picker, with their status. */
        available() {
            return LOCALES
                .map((l) => ({
                    ...l,
                    completeness: this.completeness[l.code] ?? 0,
                }))
                .filter((l) => l.code === BASE_LOCALE || l.completeness >= MIN_COMPLETENESS)
                .map((l) => ({
                    ...l,
                    partial: l.completeness < PARTIAL_THRESHOLD && l.code !== BASE_LOCALE,
                }));
        }

        localeInfo(code) {
            return LOCALES.find((l) => l.code === code) || LOCALES[0];
        }

        /** Load what is needed and apply the resolved locale to the document. */
        async init() {
            if (this._ready) return this._ready;
            this._ready = (async () => {
                await this.load(BASE_LOCALE);
                // Score every shipped locale so the picker can be honest about
                // coverage before the user commits to one.
                await Promise.all(LOCALES.filter((l) => l.code !== BASE_LOCALE)
                    .map((l) => this.load(l.code)));
                await this.activate(this.resolve());
            })();
            return this._ready;
        }

        async activate(code) {
            await this.load(code);
            if (!this.catalogues[code]) code = BASE_LOCALE;
            this.current = code;

            const info = this.localeInfo(code);
            const root = document.documentElement;
            root.setAttribute('lang', code);
            root.setAttribute('dir', info.dir);

            this.applyToDom();
            document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { code } }));
        }

        /**
         * Translate everything currently in the DOM.
         *
         * Markup opts in with `data-i18n` (text), `data-i18n-title`,
         * `data-i18n-placeholder`, or `data-i18n-aria-label`. Untagged elements
         * are left alone, so this can be adopted incrementally rather than
         * needing every string extracted before anything works.
         */
        applyToDom(rootEl = document) {
            for (const el of rootEl.querySelectorAll('[data-i18n]')) {
                const key = el.getAttribute('data-i18n');
                const translated = this.t(key);
                if (translated !== key) el.textContent = translated;
            }
            const attrs = [
                ['data-i18n-title', 'title'],
                ['data-i18n-placeholder', 'placeholder'],
                ['data-i18n-aria-label', 'aria-label'],
            ];
            for (const [dataAttr, target] of attrs) {
                for (const el of rootEl.querySelectorAll(`[${dataAttr}]`)) {
                    const key = el.getAttribute(dataAttr);
                    const translated = this.t(key);
                    if (translated !== key) el.setAttribute(target, translated);
                }
            }
        }
    }

    const i18n = new I18n();
    i18n.LOCALES = LOCALES;
    i18n.MIN_COMPLETENESS = MIN_COMPLETENESS;
    i18n.BASE_LOCALE = BASE_LOCALE;

    window.i18n = i18n;
    window.t = (key, vars) => i18n.t(key, vars);

    i18n.init().catch((e) => console.warn('[i18n] init failed:', e));
})();
