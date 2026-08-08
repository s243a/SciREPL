/**
 * appearance.js — Menu → Appearance: top margin, button scale, theme.
 *
 * Everything here works by setting CSS custom properties on <html>. The app's
 * colours and the two sizing knobs already come from custom properties
 * (css/style.css), so appearance changes need no per-element styling and apply
 * instantly without a reload.
 *
 * Settings persist in localStorage, so they survive restarts on every platform
 * and follow the same pattern as the rest of the app's preferences.
 */

(function () {
    'use strict';

    const KEYS = {
        topMargin: 'scirepl_appearance_top_margin',   // '' = auto, else integer px
        btnScale: 'scirepl_appearance_btn_scale',
        theme: 'scirepl_appearance_theme',
        customTheme: 'scirepl_appearance_custom_theme',
        customCss: 'scirepl_appearance_custom_css',
    };

    /**
     * `auto` deliberately resolves through env(), not to a fixed number.
     *
     * Where the platform reports a real safe-area inset (edge-to-edge Android,
     * notched iOS) that value is exactly right and no guess can beat it. The
     * 28px fallback only applies on engines with no env() support at all, and
     * matches the icon-button height so the header clears a typical status bar.
     *
     * On desktop the inset is 0, so `auto` costs nothing there — which is why
     * this is not simply a constant.
     */
    const AUTO_TOP_MARGIN = 'env(safe-area-inset-top, 28px)';

    /** Bounds for the button scale. 1 is the historical 28px button. */
    const SCALE = { min: 0.75, max: 2.5, step: 0.05, default: 1 };

    /** Theme variables a custom theme is allowed to set. */
    const THEMEABLE = [
        '--bg-primary', '--bg-secondary', '--bg-card', '--bg-input', '--border',
        '--text-primary', '--text-secondary', '--text-muted',
        '--accent', '--accent-glow', '--green', '--orange', '--red',
    ];

    const BUILTIN_THEMES = ['auto', 'dark', 'light'];

    class Appearance {
        constructor() {
            this._mediaQuery = null;
        }

        /* ---------------------------- reading ---------------------------- */

        /** Top margin: null means auto. */
        getTopMargin() {
            const raw = localStorage.getItem(KEYS.topMargin);
            if (raw === null || raw === '') return null;
            const n = parseInt(raw, 10);
            // 0 is a legitimate value and must not be mistaken for "unset",
            // which is why auto is stored as an empty string rather than 0.
            return Number.isFinite(n) && n >= 0 ? n : null;
        }

        getButtonScale() {
            const n = parseFloat(localStorage.getItem(KEYS.btnScale));
            if (!Number.isFinite(n)) return SCALE.default;
            return Math.min(SCALE.max, Math.max(SCALE.min, n));
        }

        getTheme() {
            const t = localStorage.getItem(KEYS.theme);
            if (t === 'custom' && this.getCustomTheme()) return 'custom';
            return BUILTIN_THEMES.includes(t) ? t : 'auto';
        }

        getCustomTheme() {
            try {
                const raw = localStorage.getItem(KEYS.customTheme);
                return raw ? JSON.parse(raw) : null;
            } catch {
                return null;
            }
        }

        getCustomCss() {
            return localStorage.getItem(KEYS.customCss) || '';
        }

        /* ---------------------------- writing ---------------------------- */

        /** @param {number|null} px null (or '') restores auto. */
        setTopMargin(px) {
            if (px === null || px === '') localStorage.removeItem(KEYS.topMargin);
            else localStorage.setItem(KEYS.topMargin, String(Math.max(0, Math.round(px))));
            this.apply();
        }

        setButtonScale(scale) {
            localStorage.setItem(KEYS.btnScale, String(
                Math.min(SCALE.max, Math.max(SCALE.min, Number(scale) || SCALE.default))
            ));
            this.apply();
        }

        setTheme(theme) {
            localStorage.setItem(KEYS.theme, theme);
            this.apply();
        }

        setCustomCss(css) {
            localStorage.setItem(KEYS.customCss, css || '');
            this.apply();
        }

        /* -------------------------- custom themes ------------------------- */

        /**
         * Validate a custom theme before it is stored.
         *
         * Unknown keys are rejected rather than ignored so a typo is reported
         * instead of silently doing nothing, and every value must parse as a
         * colour — a theme is data, and this keeps it that way. Arbitrary
         * declarations belong in the advanced CSS box, which is separate and
         * carries its own warning.
         *
         * @returns {{ ok: true, theme: object } | { ok: false, error: string }}
         */
        validateTheme(json) {
            let parsed;
            try {
                parsed = typeof json === 'string' ? JSON.parse(json) : json;
            } catch (e) {
                return { ok: false, error: `Not valid JSON: ${e.message}` };
            }
            if (!parsed || typeof parsed !== 'object') {
                return { ok: false, error: 'Expected a JSON object.' };
            }

            const vars = parsed.vars || parsed;
            if (!vars || typeof vars !== 'object') {
                return { ok: false, error: 'Expected a "vars" object of CSS variables.' };
            }

            const unknown = Object.keys(vars).filter((k) => !THEMEABLE.includes(k));
            if (unknown.length) {
                return {
                    ok: false,
                    error: `Unknown variable(s): ${unknown.join(', ')}\n\n` +
                        `Allowed:\n  ${THEMEABLE.join('\n  ')}`,
                };
            }

            const bad = Object.entries(vars).filter(([, v]) => !this._isColour(v));
            if (bad.length) {
                return {
                    ok: false,
                    error: `Not a valid colour: ${bad.map(([k, v]) => `${k}: ${v}`).join(', ')}`,
                };
            }

            return {
                ok: true,
                theme: { name: typeof parsed.name === 'string' ? parsed.name : 'Custom', vars },
            };
        }

        /** Ask the browser: if it round-trips as a colour, it is one. */
        _isColour(value) {
            if (typeof value !== 'string' || !value.trim()) return false;
            // Reject anything that could terminate the declaration and inject more.
            if (/[;{}<>]/.test(value)) return false;
            const probe = new Option().style;
            probe.color = '';
            probe.color = value;
            return probe.color !== '';
        }

        saveCustomTheme(json) {
            const result = this.validateTheme(json);
            if (!result.ok) return result;
            localStorage.setItem(KEYS.customTheme, JSON.stringify(result.theme));
            this.setTheme('custom');
            return result;
        }

        /** The current effective theme as an editable JSON starting point. */
        exportCurrentTheme() {
            const custom = this.getCustomTheme();
            if (custom) return JSON.stringify(custom, null, 2);
            const computed = getComputedStyle(document.documentElement);
            const vars = {};
            for (const key of THEMEABLE) {
                const v = computed.getPropertyValue(key).trim();
                if (v) vars[key] = v;
            }
            return JSON.stringify({ name: 'My theme', vars }, null, 2);
        }

        /* ---------------------------- applying ---------------------------- */

        /** Resolve `auto` to a concrete theme, following the OS preference. */
        _resolveTheme(theme) {
            if (theme !== 'auto') return theme;
            const prefersLight = window.matchMedia
                && window.matchMedia('(prefers-color-scheme: light)').matches;
            return prefersLight ? 'light' : 'dark';
        }

        /** Push every setting onto the document. Safe to call repeatedly. */
        apply() {
            const root = document.documentElement;

            // --- top margin ---
            const margin = this.getTopMargin();
            root.style.setProperty('--app-top-margin',
                margin === null ? AUTO_TOP_MARGIN : `${margin}px`);

            // --- button scale ---
            root.style.setProperty('--ui-btn-scale', String(this.getButtonScale()));

            // --- theme ---
            const theme = this.getTheme();
            const custom = theme === 'custom' ? this.getCustomTheme() : null;

            // Clear any previously applied custom variables first, or switching
            // from a custom theme back to a built-in one would leave them behind.
            for (const key of THEMEABLE) root.style.removeProperty(key);

            if (custom) {
                // A custom theme sits on top of a built-in base, so a partial
                // theme overriding two colours still yields a coherent UI.
                root.setAttribute('data-theme', this._resolveTheme(
                    BUILTIN_THEMES.includes(custom.base) ? custom.base : 'dark'));
                for (const [k, v] of Object.entries(custom.vars || {})) {
                    if (THEMEABLE.includes(k) && this._isColour(v)) {
                        root.style.setProperty(k, v);
                    }
                }
            } else {
                root.setAttribute('data-theme', this._resolveTheme(theme));
            }

            this._applyCustomCss();
            this._watchSystemTheme(theme === 'auto');
        }

        /**
         * Advanced escape hatch: raw CSS, in its own <style> element so it can be
         * replaced or removed cleanly. Deliberately last, so it wins.
         *
         * This is genuinely unrestricted and can make the UI unusable — which is
         * why the dialog warns, keeps it collapsed, and offers a reset. It is not
         * a security boundary: notebook code already shares this realm, so CSS
         * here grants nothing that was not already reachable.
         */
        _applyCustomCss() {
            const css = this.getCustomCss();
            let el = document.getElementById('appearance-custom-css');
            if (!css.trim()) {
                if (el) el.remove();
                return;
            }
            if (!el) {
                el = document.createElement('style');
                el.id = 'appearance-custom-css';
                document.head.appendChild(el);
            }
            el.textContent = css;
        }

        /** Follow the OS light/dark preference while the theme is `auto`. */
        _watchSystemTheme(enabled) {
            if (!window.matchMedia) return;
            if (!this._mediaQuery) {
                this._mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
                this._onSystemChange = () => {
                    if (this.getTheme() === 'auto') this.apply();
                };
            }
            const mq = this._mediaQuery;
            const handler = this._onSystemChange;
            if (mq.removeEventListener) mq.removeEventListener('change', handler);
            if (enabled && mq.addEventListener) mq.addEventListener('change', handler);
        }

        /** Restore every appearance setting to its default. */
        reset() {
            for (const key of Object.values(KEYS)) localStorage.removeItem(key);
            this.apply();
        }

        /** Measured height of the menu button — the basis for the auto margin. */
        menuButtonHeight() {
            const btn = document.getElementById('menu-btn');
            return btn ? Math.round(btn.getBoundingClientRect().height) : 28;
        }
    }

    const appearance = new Appearance();
    appearance.SCALE = SCALE;
    appearance.THEMEABLE = THEMEABLE;
    appearance.BUILTIN_THEMES = BUILTIN_THEMES;
    appearance.AUTO_TOP_MARGIN = AUTO_TOP_MARGIN;

    window.appearance = appearance;

    // Apply before first paint where possible, so the app does not flash the
    // default theme and then jump to the chosen one.
    appearance.apply();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => appearance.apply(), { once: true });
    }
})();
