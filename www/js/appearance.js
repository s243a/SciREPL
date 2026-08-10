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
        // CSS that was rolled back for hiding the way out of Appearance. Kept
        // rather than deleted: it is the user's work and may be one typo away
        // from what they wanted.
        quarantinedCss: 'scirepl_appearance_quarantined_css',
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

    /**
     * Dark is SciREPL's default, and it is a product decision rather than a
     * fallback value: the app looked dark before this menu existed and must
     * still look dark after it.
     *
     * Defaulting to 'auto' would have quietly handed that decision to the
     * device — a user on a light-mode phone who never opened Appearance would
     * have seen the app change appearance on upgrade, having chosen nothing.
     * 'auto' stays available as an explicit choice; it is just not the one made
     * on the user's behalf. This also covers a corrupt or hand-edited value in
     * storage, which must land on the product default rather than the device's.
     */
    const DEFAULT_THEME = 'dark';

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
            // Absent, unrecognised, or 'custom' with no stored custom theme all
            // land here, and all resolve to the product default rather than the
            // device preference. See DEFAULT_THEME.
            return BUILTIN_THEMES.includes(t) ? t : DEFAULT_THEME;
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
            const theme = this.safeMode() ? DEFAULT_THEME : this.getTheme();
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
            let el = document.getElementById('appearance-custom-css');
            const css = this.safeMode() ? '' : this.getCustomCss();
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

            // The CSS is applied above (before first paint, so no flash). But the
            // escape-path check must NOT run while the app's own loading overlay
            // still covers the UI: elementFromPoint would see the overlay and
            // mistake it for a user lockout, quarantining harmless CSS on every
            // reload. Defer the check until the overlay clears; validate now
            // otherwise (e.g. an edit from the dialog, when loading is long done).
            if (this._loadingOverlayActive()) {
                this._deferEscapeCheck();
            } else {
                this._runEscapeCheck(css, el);
            }
        }

        /**
         * Roll back custom CSS if it broke the way back to Appearance. Kept
         * separate from application so it can run later, once the app is in its
         * normal interactive state rather than mid-load.
         */
        _runEscapeCheck(css, el) {
            el = el || document.getElementById('appearance-custom-css');
            if (!el) return;
            if (this._escapeHatchIntact()) {
                this._scheduleDelayedRecheck();
                return;
            }
            el.remove();
            localStorage.setItem(KEYS.quarantinedCss, css);
            localStorage.removeItem(KEYS.customCss);
            this._announceQuarantine();
        }

        /** Is the app's loading overlay currently covering the UI? */
        _loadingOverlayActive() {
            const o = document.getElementById('loading-overlay');
            if (!o || o.classList.contains('hidden')) return false;
            const cs = getComputedStyle(o);
            return cs.display !== 'none' && cs.visibility !== 'hidden'
                && parseFloat(cs.opacity) >= 0.1;
        }

        /** Run the escape check once the loading overlay has gone. */
        _deferEscapeCheck() {
            if (this._escapeCheckObserver) return;
            const finish = () => {
                if (this._loadingOverlayActive()) return;
                this._escapeCheckObserver.disconnect();
                this._escapeCheckObserver = null;
                clearInterval(this._escapeCheckPoll);
                const css = this.getCustomCss();
                const el = document.getElementById('appearance-custom-css');
                if (css.trim() && el) this._runEscapeCheck(css, el);
            };
            this._escapeCheckObserver = new MutationObserver(finish);
            const o = document.getElementById('loading-overlay');
            if (o) this._escapeCheckObserver.observe(o, {
                attributes: true, attributeFilter: ['class', 'style'],
            });
            // Fallback for engines/paths where the overlay is removed rather than
            // class-toggled, or MutationObserver is unavailable.
            this._escapeCheckPoll = setInterval(finish, 250);
        }

        /**
         * Is the whole way back to this dialog still usable?
         *
         * The route is menu button → menu → Appearance button → dialog. Checking
         * only the menu button missed CSS that hides the menu itself or the
         * Appearance entry, or drops a full-screen overlay over the button while
         * leaving the button's own box intact. So this walks the path: the menu
         * button must be visible AND not covered, and the menu is briefly opened
         * (invisibly, and restored in the same synchronous frame so nothing
         * paints) to confirm the Appearance entry still renders.
         */
        _escapeHatchIntact() {
            const btn = document.getElementById('menu-btn');
            if (!btn) return true;              // nothing rendered yet; not our call
            if (!this._nodeReachable(btn)) return false;

            // A rule that is fine this frame but animates the button away later
            // (a delayed @keyframes, a transition) would pass a one-frame check
            // and then lock the user out. Inspect the recovery path's own
            // animations and fail closed if any keyframe hides it.
            if (this._pathHasHidingAnimation()) return false;

            const menu = document.getElementById('menu-modal');
            const appBtn = document.getElementById('btn-appearance');
            if (menu && appBtn) {
                const wasHidden = menu.classList.contains('hidden');
                const savedStyle = menu.style.cssText;
                // Opacity 0 (not visibility/display) keeps children laid out and
                // hit-testable for the coverage check; no frame paints before the
                // restore below, so it is invisible to the user.
                menu.classList.remove('hidden');
                menu.style.opacity = '0';
                // The Appearance entry just has to render — display, visibility
                // and size. Coverage is not meaningful here: the open menu is the
                // top layer, and forcing pointer-events to test it would break
                // the very hit-test it needs.
                const reachable = this._hasVisibleBox(appBtn);
                menu.style.cssText = savedStyle;
                if (wasHidden) menu.classList.add('hidden');
                if (!reachable) return false;
            }
            return true;
        }

        /** Rendered, on-screen, interactive, and nothing painted over it. */
        _nodeReachable(el) {
            if (!this._hasVisibleBox(el)) return false;
            const cs = getComputedStyle(el);
            if (parseFloat(cs.opacity) < 0.1 || cs.pointerEvents === 'none') return false;
            const r = el.getBoundingClientRect();
            if (r.bottom < 0 || r.right < 0
                || r.top > window.innerHeight || r.left > window.innerWidth) return false;
            return !this._coveredByForeign(el, el);
        }

        _hasVisibleBox(el) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width >= 8 && r.height >= 8;
        }

        /** Is the element's centre covered by something outside `within`? */
        _coveredByForeign(el, within) {
            const r = el.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
            const top = document.elementFromPoint(cx, cy);
            if (!top) return false;
            if (top === el || el.contains(top)) return false;   // el itself or its child on top
            if (within && within.contains(top)) return false;   // within the allowed subtree
            // Anything else on top — a sibling overlay, or an ancestor whose
            // pseudo-element covers the point (elementFromPoint returns the host)
            // — means el is painted over.
            return true;
        }

        /**
         * Does any animation on the recovery path have a keyframe that would hide
         * the control — opacity to nothing, visibility/display off,
         * pointer-events off, or a translate far off-screen? This catches the
         * delayed-animation attack a single-frame geometry check cannot: the
         * keyframes are known the instant the rule is applied, before the delay
         * elapses, so the CSS is quarantined at once and never locks anyone out.
         */
        _pathHasHidingAnimation() {
            const ids = ['menu-btn', 'menu-modal', 'btn-appearance', 'app-header'];
            for (const id of ids) {
                const el = document.getElementById(id);
                if (!el || typeof el.getAnimations !== 'function') continue;
                let anims;
                try { anims = el.getAnimations({ subtree: false }); } catch { anims = []; }
                for (const anim of anims) {
                    const eff = anim.effect;
                    let frames = [];
                    try { frames = eff && eff.getKeyframes ? eff.getKeyframes() : []; } catch { frames = []; }
                    if (frames.some((f) => this._frameHides(f))) return true;
                }
            }
            return false;
        }

        _frameHides(f) {
            if (f.opacity !== undefined && parseFloat(f.opacity) < 0.1) return true;
            if (f.visibility === 'hidden' || f.visibility === 'collapse') return true;
            if (f.display === 'none') return true;
            if (f.pointerEvents === 'none') return true;
            if (typeof f.transform === 'string' && /translate|matrix/i.test(f.transform)) {
                const nums = (f.transform.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
                if (nums.some((n) => Math.abs(n) > 1500)) return true;
            }
            return false;
        }

        /**
         * Re-run the escape check a little later. Transitions and computed
         * changes that a keyframe scan cannot predict still get caught, and
         * because the quarantine also runs on the next launch, a lockout that
         * somehow applied cannot persist across a restart.
         */
        _scheduleDelayedRecheck() {
            for (const t of (this._recheckTimers || [])) clearTimeout(t);
            this._recheckTimers = [900, 3000].map((ms) => setTimeout(() => {
                const css = this.getCustomCss();
                const el = document.getElementById('appearance-custom-css');
                if (css.trim() && el) this._runEscapeCheck(css, el);
            }, ms));
        }

        /** Whether this load is deliberately ignoring custom appearance. */
        safeMode() {
            try {
                const q = new URLSearchParams(location.search);
                return q.has('safe') || /(^|[&#])safe(=|$|&)/.test(location.hash);
            } catch { return false; }
        }

        /** The CSS that was rolled back, so the editor can offer it back. */
        getQuarantinedCss() {
            return localStorage.getItem(KEYS.quarantinedCss) || '';
        }

        clearQuarantinedCss() {
            localStorage.removeItem(KEYS.quarantinedCss);
        }

        _announceQuarantine() {
            if (this._quarantineAnnounced) return;
            this._quarantineAnnounced = true;
            const note = document.createElement('div');
            note.id = 'appearance-css-quarantine';
            note.setAttribute('role', 'alert');
            // Called with the key spelled out so scripts/check-i18n-keys.mjs can
            // see it; the fallback covers being called before i18n has loaded.
            const translated = window.t && window.t('appearance.cssQuarantined');
            note.textContent = (translated && translated !== 'appearance.cssQuarantined')
                ? translated
                : 'Your custom CSS hid the menu button, so it has been turned off. '
                  + 'It is kept in Appearance → Advanced so you can edit it.';
            document.body.appendChild(note);
            setTimeout(() => note.remove(), 12000);
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
