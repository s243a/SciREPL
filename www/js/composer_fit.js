/**
 * composer_fit.js — keep the code field usable when the Run label is long.
 *
 * Six locales translate "Run" to ten or eleven characters, and Run is the one
 * element of the composer row that never shrinks, so on a 360px phone in
 * Russian the code field was left with about seven characters per line. When
 * the field would fall under a minimum width, Run keeps only its icon; its
 * translated label stays in the DOM (font-size 0) so the accessible name is
 * unchanged. Appearance lets the user force either form.
 *
 * Preference: localStorage `scirepl_run_button` = auto (default) | compact | full.
 */
(function () {
    'use strict';

    const KEY = 'scirepl_run_button';
    const MODES = ['auto', 'compact', 'full'];
    const MIN_INPUT_PX = 160;
    const MIN_INPUT_FRACTION = 0.45;
    const CLASS = 'run-compact';
    let frame = 0;
    let observer = null;

    function getMode() {
        try {
            const value = localStorage.getItem(KEY);
            return MODES.includes(value) ? value : 'auto';
        } catch (_) { return 'auto'; }
    }

    function setMode(mode) {
        if (!MODES.includes(mode)) mode = 'auto';
        try { localStorage.setItem(KEY, mode); } catch (_) { /* private mode */ }
        syncSelect();
        refresh();
    }

    function elements() {
        const bar = document.getElementById('input-bar');
        const input = document.getElementById('code-input');
        const run = document.getElementById('run-btn');
        const row = bar ? (bar.querySelector('.input-row') || bar) : null;
        return bar && input && run && row ? { bar, input, run, row } : null;
    }

    /** Decide with the full label applied, then apply the class if needed. */
    function refresh() {
        frame = 0;
        const el = elements();
        if (!el) return false;
        const mode = getMode();
        el.bar.classList.remove(CLASS);
        let compact = mode === 'compact';
        if (mode === 'auto') {
            const rowWidth = el.row.getBoundingClientRect().width;   // forces layout, no paint
            const inputWidth = el.input.getBoundingClientRect().width;
            if (rowWidth > 0) {
                compact = inputWidth < Math.max(MIN_INPUT_PX, rowWidth * MIN_INPUT_FRACTION);
            }
        }
        if (compact) el.bar.classList.add(CLASS);
        return compact;
    }

    function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(refresh);
    }

    function syncSelect() {
        const select = document.getElementById('appearance-run-button');
        if (select && select.value !== getMode()) select.value = getMode();
    }

    function bind() {
        const select = document.getElementById('appearance-run-button');
        if (select && !select.dataset.bound) {
            select.dataset.bound = '1';
            select.value = getMode();
            select.addEventListener('change', () => setMode(select.value));
        }
        const el = elements();
        if (el && typeof ResizeObserver === 'function' && !observer) {
            // The row's own width rarely changes; the label growing on a locale
            // switch changes the button and the field.
            observer = new ResizeObserver(schedule);
            observer.observe(el.row);
            observer.observe(el.run);
            observer.observe(el.input);
        }
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);
        document.addEventListener('i18n:changed', schedule);
        schedule();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }

    window.composerFit = {
        KEY, MODES, MIN_INPUT_PX, MIN_INPUT_FRACTION,
        getMode, setMode, refresh, schedule,
        isCompact: () => !!document.getElementById('input-bar')?.classList.contains(CLASS)
    };
})();
