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
        showTourShortcut: 'scirepl_appearance_show_tour_shortcut',
        showFormulaShortcut: 'scirepl_appearance_show_formula_shortcut',
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

        /** Header shortcuts are opt-out: existing and new installs see both. */
        getShowTourShortcut() {
            return localStorage.getItem(KEYS.showTourShortcut) !== '0';
        }

        /** Formula palette is opt-in (off by default): its inserts are
         *  SymPy-specific, and on phones the palette competes with the
         *  composer for space — users who want it enable it once in
         *  Appearance. (Owner decision, Play closed-testing feedback.) */
        getShowFormulaShortcut() {
            return localStorage.getItem(KEYS.showFormulaShortcut) === '1';
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

        setShowTourShortcut(show) {
            localStorage.setItem(KEYS.showTourShortcut, show ? '1' : '0');
            this.apply();
        }

        setShowFormulaShortcut(show) {
            localStorage.setItem(KEYS.showFormulaShortcut, show ? '1' : '0');
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
                const errorKey = 'appearance.invalidJson';
                const errorVars = { error: e.message };
                return { ok: false, errorKey, errorVars, error: window.t(errorKey, errorVars) };
            }
            if (!parsed || typeof parsed !== 'object') {
                const errorKey = 'appearance.expectedJsonObject';
                return { ok: false, errorKey, error: window.t(errorKey) };
            }

            const vars = parsed.vars || parsed;
            if (!vars || typeof vars !== 'object') {
                const errorKey = 'appearance.expectedVarsObject';
                return { ok: false, errorKey, error: window.t(errorKey) };
            }

            const unknown = Object.keys(vars).filter((k) => !THEMEABLE.includes(k));
            if (unknown.length) {
                const errorKey = 'appearance.unknownVariables';
                const errorVars = {
                    variables: unknown.join(', '),
                    allowed: THEMEABLE.join('\n  '),
                };
                return {
                    ok: false,
                    errorKey,
                    errorVars,
                    error: window.t(errorKey, errorVars),
                };
            }

            const bad = Object.entries(vars).filter(([, v]) => !this._isColour(v));
            if (bad.length) {
                const errorKey = 'appearance.invalidColour';
                const errorVars = { values: bad.map(([k, v]) => `${k}: ${v}`).join(', ') };
                return {
                    ok: false,
                    errorKey,
                    errorVars,
                    error: window.t(errorKey, errorVars),
                };
            }

            return {
                ok: true,
                theme: { name: typeof parsed.name === 'string' ? parsed.name : window.t('appearance.customThemeName'), vars },
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
            return JSON.stringify({ name: window.t('appearance.myThemeName'), vars }, null, 2);
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

            // --- optional header shortcuts ---
            this._showHeaderShortcut('tour-shortcut-btn', this.getShowTourShortcut());
            this._showHeaderShortcut('math-mode-btn', this.getShowFormulaShortcut());

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

        _showHeaderShortcut(id, show) {
            const button = document.getElementById(id);
            if (!button) return;
            button.classList.toggle('header-shortcut-hidden', !show);
            button.setAttribute('aria-hidden', show ? 'false' : 'true');
            button.tabIndex = show ? 0 : -1;
            // Formula's header button is also the palette's toggle/close
            // control. If it is hidden while the palette is open, close the
            // palette first so no floating UI is left without its control.
            if (id === 'math-mode-btn' && !show) {
                if (window.mathMode && window.mathMode.setOpen) {
                    window.mathMode.setOpen(false);
                } else {
                    button.classList.remove('active');
                    const palette = document.getElementById('math-palette');
                    if (palette) palette.classList.add('hidden');
                }
            }
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
                this._runEscapeCheck(css, el, true);
            }
        }

        /**
         * Roll back custom CSS if it broke the way back to Appearance. Kept
         * separate from application so it can run later, once the app is in its
         * normal interactive state rather than mid-load.
         */
        _runEscapeCheck(css, el, followUp) {
            el = el || document.getElementById('appearance-custom-css');
            if (!el) return;
            if (this._escapeHatchIntact()) {
                // Schedule the two delayed re-checks ONCE, from the initial call
                // only. A delayed re-check that re-scheduled would loop forever
                // (~900ms hit-test churn) for perfectly good CSS.
                if (followUp) this._scheduleDelayedRecheck();
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
                if (this._loadingOverlayActive() || this._escapeCheckDone) return;
                this._escapeCheckDone = true;
                this._escapeCheckObserver.disconnect();
                this._escapeCheckObserver = null;
                clearInterval(this._escapeCheckPoll);
                const css = this.getCustomCss();
                const el = document.getElementById('appearance-custom-css');
                if (css.trim() && el) this._runEscapeCheck(css, el, true);
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
            // A rule fine this frame but animating the path away later would pass
            // a one-frame check and then lock the user out.
            if (this._pathHasHidingAnimation()) return false;

            const btn = document.getElementById('menu-btn');
            if (!btn) return true;              // nothing rendered yet; not our call
            // The menu button must be usable AND not painted over by a NON-app
            // element. The app's own chrome — an open Appearance dialog, the menu
            // itself, the loading overlay — is dismissible and does not count; a
            // user's full-screen overlay does. Without this, applying CSS through
            // the visibly-open dialog quarantined it, because the dialog covers
            // the header.
            if (!this._elementUsable(btn, { coverage: true })) return false;

            // The deeper path: the menu must open and show a usable Appearance
            // entry, and the Appearance dialog must be showable. Each is probed
            // independently (not stacked), with transitions disabled so the
            // opacity read is the settled target rather than a mid-fade 0 — while
            // still catching a user's own opacity:0, which has no transition to 1.
            const menu = document.getElementById('menu-modal');
            const appBtn = document.getElementById('btn-appearance');
            const dialog = document.getElementById('appearance-modal');

            if (menu && appBtn) {
                const ok = this._withProbeOpen(menu, () =>
                    this._elementUsable(menu, {})
                    // The Appearance entry may sit below the fold of a scrollable
                    // menu — that is reachable, not lost. Scroll it into view for
                    // the measurement. Coverage here is STRICT (no app-chrome
                    // exemption): the only thing that can legitimately cover the
                    // entry inside the open menu is a hostile pseudo-element on
                    // the menu's own content, which is exactly the attack.
                    && this._revealInScroll(appBtn, () =>
                        this._elementUsable(appBtn, { coverage: true })));
                if (!ok) return false;
            }
            if (dialog) {
                const ok = this._withProbeOpen(dialog, () => {
                    if (!this._elementUsable(dialog, {})) return false;
                    // A dialog that opens but offers no usable recovery PATH is
                    // still a lockout. Recovery is either Reset (one control), or
                    // editing (the textarea AND Apply together). Any single other
                    // control — Apply without the textarea, the textarea without
                    // Apply — is not a way out.
                    const usable = (id) => {
                        const el = document.getElementById(id);
                        return !!el && this._revealInScroll(el, () => this._elementUsable(el, {}));
                    };
                    // Reset is always visible in the dialog; the editor and Apply
                    // live in a collapsed <details>. Expanding Advanced is part of
                    // the recovery path, so open it for the measurement (restored
                    // in the same synchronous frame).
                    const editor = document.getElementById('appearance-custom-css-input');
                    const details = editor && editor.closest('details');
                    const wasOpen = details ? details.open : null;
                    if (details) details.open = true;
                    const canEdit = usable('appearance-custom-css-input') && usable('appearance-css-apply');
                    if (details) details.open = wasOpen;
                    return usable('appearance-reset') || canEdit;
                });
                if (!ok) return false;
            }
            return true;
        }

        /**
         * Scroll `el` into view within any scrollable ancestor, run `measure`,
         * then restore the scroll positions — all synchronously, so a control
         * that is reachable only by scrolling is judged reachable rather than
         * off-screen. Handles the 844x390 landscape case where the Appearance
         * entry begins below the menu's viewport.
         */
        _revealInScroll(el, measure) {
            const saved = [];
            let node = el.parentElement;
            while (node && node !== document.body) {
                if (node.scrollHeight > node.clientHeight + 1
                    || node.scrollWidth > node.clientWidth + 1) {
                    saved.push([node, node.scrollTop, node.scrollLeft]);
                }
                node = node.parentElement;
            }
            try {
                if (typeof el.scrollIntoView === 'function') {
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                }
                return measure();
            } finally {
                for (const [n, top, left] of saved) { n.scrollTop = top; n.scrollLeft = left; }
            }
        }

        /**
         * Reveal a modal for measurement and restore it in the same synchronous
         * frame (no paint). Transitions are disabled so a just-un-hidden modal
         * reports its settled opacity, not the transition's momentary 0.
         */
        _withProbeOpen(modal, measure) {
            const wasHidden = modal.classList.contains('hidden');
            const saved = modal.style.cssText;
            const wasInert = modal.inert;
            modal.classList.remove('hidden');
            modal.style.transition = 'none';
            // A hidden modal is left inert (see installModalInert), and an inert
            // subtree is not hit-testable — the coverage check would then see
            // straight through the open menu to whatever is behind it and call
            // the Appearance entry "covered". Clear it for the measurement.
            modal.inert = false;
            let result;
            try { result = measure(); } finally {
                modal.style.cssText = saved;
                modal.inert = wasInert;
                if (wasHidden) modal.classList.add('hidden');
            }
            return result;
        }

        /**
         * Is an element genuinely operable: rendered, opaque enough, accepting
         * pointer events, a real size, on-screen, and (when asked) not painted
         * over by something outside the app's own chrome.
         */
        _elementUsable(el, { coverage } = {}) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (parseFloat(cs.opacity) < 0.1 || cs.pointerEvents === 'none') return false;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            // On-screen is a TAPPABLE-AREA test, not "any pixel showing": a button
            // shoved so only a sliver remains in the viewport is not operable.
            // Callers that expect scroll-reachable content run this AFTER
            // scrollIntoView, so a genuinely reachable control has been brought
            // into view and passes, while a position:fixed off-screen element —
            // which scrolling cannot move — still fails.
            const vw = Math.min(window.innerWidth, r.right) - Math.max(0, r.left);
            const vh = Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top);
            if (vw < 8 || vh < 8) return false;
            if (coverage && this._coveredByForeign(el)) return false;
            return true;
        }

        /** Elements that are the app's own dismissible chrome, not user CSS. */
        _isAppChrome(node) {
            return !!(node && node.closest
                && node.closest('#loading-overlay, .modal, #tour-overlay'));
        }

        /**
         * Is the element's centre painted over by a NON-app element? Coverage by
         * the app's own chrome (an open modal, the loading overlay) does not
         * count — the user can dismiss it — but a user's overlay does.
         */
        _coveredByForeign(el) {
            const r = el.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
            const top = document.elementFromPoint(cx, cy);
            if (!top) return false;
            if (top === el || el.contains(top)) return false;   // el or its child on top
            // An ANCESTOR is on top: elementFromPoint returns the host of a
            // covering ::after (e.g. body::after, or #menu-modal .modal-content
            // ::after over the Appearance entry). A pseudo-element cannot be
            // dismissed, so this is always a lockout — even though the host is
            // "app chrome".
            if (top.contains(el)) return true;
            // A SEPARATE element is on top. The app's own dismissible chrome (an
            // open dialog covering the header) is fine; anything else is a
            // foreign overlay.
            return !this._isAppChrome(top);
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
            const ids = ['menu-btn', 'menu-modal', 'btn-appearance', 'app-header',
                'appearance-modal', 'appearance-custom-css-input',
                'appearance-css-apply', 'appearance-reset'];
            for (const id of ids) {
                const el = document.getElementById(id);
                if (!el || typeof el.getAnimations !== 'function') continue;
                let anims;
                try {
                    // A truly hidden modal is no longer rendered, so the browser
                    // quite correctly exposes no active CSS animation for it.
                    // Probe it open for one synchronous frame so hostile delayed
                    // keyframes are still visible to the recovery guard.
                    anims = el.classList.contains('modal') && el.classList.contains('hidden')
                        ? this._withProbeOpen(el, () => [...el.getAnimations({ subtree: false })])
                        : [...el.getAnimations({ subtree: false })];
                } catch { anims = []; }
                for (const anim of anims) {
                    // Transitions are transient and usually the app's own (a modal
                    // fading in passes through opacity 0). A transition TO a hidden
                    // state is caught by the delayed re-check instead. Only
                    // persistent keyframe animations are a standing lockout.
                    if (anim.constructor && anim.constructor.name === 'CSSTransition') continue;
                    const eff = anim.effect;
                    let timing = {};
                    try { timing = eff && eff.getComputedTiming ? eff.getComputedTiming() : {}; } catch { timing = {}; }
                    const persists = timing.iterations === Infinity
                        || timing.fill === 'forwards' || timing.fill === 'both';
                    if (!persists) continue;
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
                // No followUp: these are the two follow-up checks, they must not
                // schedule more. Initial + 900ms + 3000ms = exactly three.
                if (css.trim() && el) this._runEscapeCheck(css, el, false);
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
            window.setI18nText(note, 'appearance.cssQuarantined');
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

    /**
     * Hidden modals are removed from layout/painting by the shared `.hidden`
     * rule. `inert` additionally removes their descendants from focus and the
     * accessibility tree. Toggled from the class on every modal so no
     * individual show/hide call site has to remember the accessibility state.
     */
    function syncModalInert(m) {
        const hidden = m.classList.contains('hidden');
        m.inert = hidden;
        if (hidden) m.setAttribute('aria-hidden', 'true');
        else m.removeAttribute('aria-hidden');
    }
    function installModalInert() {
        const modals = document.querySelectorAll('.modal');
        const mo = new MutationObserver((muts) => {
            for (const mu of muts) {
                if (mu.attributeName === 'class') syncModalInert(mu.target);
            }
        });
        modals.forEach((m) => {
            syncModalInert(m);
            mo.observe(m, { attributes: true, attributeFilter: ['class'] });
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installModalInert, { once: true });
    } else {
        installModalInert();
    }

    // Apply before first paint where possible, so the app does not flash the
    // default theme and then jump to the chosen one.
    appearance.apply();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => appearance.apply(), { once: true });
    }
})();
