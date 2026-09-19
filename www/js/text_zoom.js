/**
 * text_zoom.js — expose the platform text zoom to CSS.
 *
 * Android WebView applies the system font scale to text rendering: computed
 * font sizes report the zoomed value, but `em`/`px` lengths resolve against
 * the unzoomed size, so a 28px icon circle stays 28px while its 14px glyph
 * paints at 21px (measured on a Galaxy S24 at font scale 1.5; see
 * docs/HEADER_TEXT_ZOOM.md). This measures the factor from a probe element
 * and publishes it as `--ui-text-zoom`, which the header controls multiply
 * into their box sizes. Desktop browsers report 1.
 */
(function () {
    'use strict';
    const PROP = '--ui-text-zoom';
    const PROBE_PX = 16;
    let frame = 0;
    let applied = 1;

    function measure() {
        const probe = document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;font-size:' + PROBE_PX
            + 'px;line-height:1;visibility:hidden;pointer-events:none;';
        probe.textContent = 'x';
        (document.body || document.documentElement).appendChild(probe);
        const computed = parseFloat(getComputedStyle(probe).fontSize) || PROBE_PX;
        probe.remove();
        const factor = computed / PROBE_PX;
        return Number.isFinite(factor) && factor > 0 ? Math.round(factor * 100) / 100 : 1;
    }

    function apply(factor) {
        applied = factor;
        const root = document.documentElement;
        if (Math.abs(factor - 1) < 0.02) root.style.removeProperty(PROP);
        else root.style.setProperty(PROP, String(factor));
        document.dispatchEvent(new CustomEvent('scirepl:text-zoom', { detail: { factor } }));
    }

    function refresh() {
        frame = 0;
        apply(measure());
    }

    function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(refresh);
    }

    function bind() {
        refresh();
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
    else bind();

    window.uiTextZoom = { PROP, measure, factor: () => applied, apply, refresh: schedule };
})();
