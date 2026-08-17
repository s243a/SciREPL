/**
 * math_mode.js — the Formula palette, context-aware.
 *
 * Composer contexts and their palettes:
 *   - Python code:  SymPy insertion palette (diff/integrate/solve/...)
 *   - Markdown:     LaTeX template palette ($...$ / $$...$$, KaTeX-rendered)
 *   - anything else: the Formula control hides and the palette closes
 *
 * Context is derived from the cell-type toggle (markdown-active) and the
 * language selector. Every site that changes either programmatically must
 * dispatch 'scirepl:composer-context-changed' (window.notifyComposerContextChanged)
 * so the palette can never desynchronize; as a belt-and-braces the palette
 * also re-derives context on its own toggle click and on direct selector /
 * cell-type interactions.
 */

const MATH_CURSOR_MARKER = '\u2038'; // ‸ — replaced by the caret position

class MathMode {
    constructor() {
        this.palette = document.getElementById('math-palette');
        this.toggleBtn = document.getElementById('math-mode-btn');
        this.input = document.getElementById('code-input');
        this.langSelector = document.getElementById('lang-selector');
        this.cellTypeToggle = document.getElementById('cell-type-toggle');

        this.init();
    }

    init() {
        this.toggleBtn.setAttribute('aria-controls', 'math-palette');
        this.toggleBtn.setAttribute('aria-expanded', 'false');
        // every listener is NAMED so destroy() can remove it — recreating
        // MathMode must never install duplicate handlers
        this._onToggleClick = () => {
            this.syncContext();               // never open a stale palette
            if (this.context() === null) return;
            this.setOpen(this.palette.classList.contains('hidden'));
        };
        this.toggleBtn.addEventListener('click', this._onToggleClick);

        this._onPaletteClick = (e) => {
            if (e.target.tagName !== 'BUTTON') return;
            const text = e.target.getAttribute('data-insert');
            if (!text) return;
            if (e.target.getAttribute('data-mode') === 'latex') this.insertLatex(text);
            else this.insertText(text);
        };
        this.palette.addEventListener('click', this._onPaletteClick);

        // Central synchronization: programmatic context changes announce
        // themselves; direct user interactions are covered as a fallback
        // (deferred a tick so the app's own handlers update state first).
        this._onContextChanged = () => this.syncContext();
        document.addEventListener('scirepl:composer-context-changed', this._onContextChanged);
        this._onLangChange = () => setTimeout(() => this.syncContext(), 0);
        if (this.langSelector) this.langSelector.addEventListener('change', this._onLangChange);
        this._onCellTypeClick = () => setTimeout(() => this.syncContext(), 0);
        if (this.cellTypeToggle) this.cellTypeToggle.addEventListener('click', this._onCellTypeClick);
        this._installGeometryObservers();
        this.syncContext();
    }

    /** Open/close the palette with all state kept in sync (class, button
     *  active state, aria-expanded, reserved layout space). The ONLY
     *  open/close path — appearance.js preference-driven closes call it
     *  via window.mathMode.setOpen(false). */
    setOpen(open) {
        this.palette.classList.toggle('hidden', !open);
        this.toggleBtn.classList.toggle('active', open);
        this.toggleBtn.setAttribute('aria-expanded', String(!!open));
        this.publishPaletteSpace();
    }

    /** 'python' | 'markdown' | null (no palette for this context). */
    context() {
        if (this.cellTypeToggle && this.cellTypeToggle.classList.contains('markdown-active')) return 'markdown';
        if (!this.langSelector || this.langSelector.value === 'python') return 'python';
        return null;
    }

    /** The sticky footer overlays the notebook scrollers (body is a block
     *  layout), so every ACTIVE scroller reserves its own MEASURED overlap
     *  as bottom padding — recomputed whenever the footer's geometry
     *  changes for any reason (palette open/close/context, textarea
     *  autosize, safe-inset updates, viewport resize, notebook switches).
     *  Layout invariants: test_math_palette.mjs. */
    publishPaletteSpace() {
        // tracked and coalesced: destroy() cancels the pending frame, so a
        // queued measurement can never run after teardown and re-attach
        // the disconnected ResizeObserver to a new scroller
        if (this._destroyed) return;
        if (this._pendingFrame) cancelAnimationFrame(this._pendingFrame);
        this._pendingFrame = requestAnimationFrame(() => {
            this._pendingFrame = null;
            if (!this._destroyed) this._measureFooterOverlay();
        });
    }

    _measureFooterOverlay() {
        const bar = document.getElementById('input-bar');
        if (!bar) return;
        this._publishFooterBudget(bar);
        const barTop = bar.getBoundingClientRect().top;
        const appBody = document.getElementById('app-body');
        const clipBottom = appBody ? appBody.getBoundingClientRect().bottom : Infinity;
        for (const scroller of document.querySelectorAll('#repl, .repl-container')) {
            if (!this._observedScrollers.has(scroller)) {
                this._observedScrollers.add(scroller);
                this._resizeObserver.observe(scroller);
            }
            if (scroller.offsetParent === null) continue;   // hidden notebook
            // Clamp to the scroller's VISIBLE bottom (#app-body clips it).
            // Without the clamp, the padding this sets can grow the
            // scroller's own border box, which grows the next measurement —
            // a feedback loop that inflated the reservation on every
            // visual-viewport pan event while the footer was lifted.
            const visibleBottom = Math.min(scroller.getBoundingClientRect().bottom, clipBottom);
            const overlap = Math.max(0, visibleBottom - barTop);
            scroller.style.setProperty('--footer-overlay-local', Math.ceil(overlap) + 'px');
        }
    }

    /** Budget the footer's interior so its CONTENT always ends above the
     *  bottom safe-area boundary (innerHeight - inset): the composer is
     *  capped first (min one line), the palette gets the leftover (it
     *  collapses to a scrollable strip — or nothing — before composer or
     *  Run may enter the unsafe region), and a small notebook slice is
     *  reserved whenever physically possible. The inset is derived from the
     *  bar's RESOLVED padding, so Capacitor vars and env() both count. */
    _publishFooterBudget(bar) {
        const header = document.getElementById('app-header');
        const paletteOpen = this.palette && !this.palette.classList.contains('hidden');
        const cs = getComputedStyle(bar);
        const pads = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const gap = parseFloat(cs.rowGap || cs.gap) || 8;
        // usable vertical band: from whichever is lower of the header
        // bottom and the visual viewport's top (a pan that scrolls the
        // header AWAY frees its space — the palette can then restore),
        // down to the visual viewport's bottom
        const vv0 = window.visualViewport;
        const vvTop = vv0 ? vv0.offsetTop : 0;
        const vvBottom = vv0
            ? Math.min(window.innerHeight, vv0.offsetTop + vv0.height)
            : window.innerHeight;
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        const usableTop = Math.max(headerBottom, vvTop);
        // measured minimum row height: the non-composer children (control
        // stack, Run) set the floor — at narrow widths the controls are
        // taller than the composer's single line
        const controls = document.getElementById('input-controls');
        const runBtn = document.getElementById('run-btn');
        const rowMin = Math.max(44,
            controls ? controls.getBoundingClientRect().height : 0,
            runBtn ? runBtn.getBoundingClientRect().height : 0);
        // one FULL palette button row, in border-box pixels of the palette
        const palCs = this.palette ? getComputedStyle(this.palette) : null;
        const palChrome = palCs
            ? (parseFloat(palCs.paddingTop) || 0) + (parseFloat(palCs.paddingBottom) || 0)
                + (parseFloat(palCs.borderTopWidth) || 0) + (parseFloat(palCs.borderBottomWidth) || 0)
            : 9;
        const PALETTE_ROW = 36 + palChrome;
        const band = Math.max(0, vvBottom - usableTop);
        const minContent = rowMin + (paletteOpen ? gap + PALETTE_ROW : 0);
        const leftover = band - pads - minContent;
        const notebookReserve = Math.max(0, Math.min(40, leftover));
        const content = Math.max(0, band - pads - notebookReserve);
        const rowCap = Math.min(200, Math.max(rowMin, content - (paletteOpen ? gap + PALETTE_ROW : 0)));
        const input = this.input;
        const naturalRow = Math.max(rowMin,
            input ? Math.min(input.scrollHeight || 44, 200) : 44);
        const rowH = Math.min(naturalRow, rowCap);
        const paletteCap = paletteOpen ? Math.max(0, content - rowH - gap) : 0;
        // DELIBERATE collapse: when not even one full button row fits, the
        // palette hides entirely instead of showing a clipped, unhittable
        // strip; it reappears automatically when space returns. The
        // DESIRED-open state lives in the 'hidden' class (untouched here);
        // the toggle control must reflect what the user actually SEES:
        // while collapsed, aria-expanded is false and the button is not
        // presented as an active control.
        if (this.palette) {
            const collapsed = paletteOpen && paletteCap < PALETTE_ROW;
            // keyboard focus must never silently drop to <body>: if a
            // palette button is focused as the palette collapses, move
            // focus to the Formula toggle (the control that re-opens it)
            if (collapsed && !this.palette.classList.contains('space-collapsed')
                && this.palette.contains(document.activeElement) && this.toggleBtn) {
                this.toggleBtn.focus();
            }
            this.palette.classList.toggle('space-collapsed', collapsed);
            if (this.toggleBtn) {
                const effectiveOpen = paletteOpen && !collapsed;
                this.toggleBtn.classList.toggle('active', effectiveOpen);
                this.toggleBtn.setAttribute('aria-expanded', String(effectiveOpen));
            }
        }
        bar.style.setProperty('--sci-composer-max', rowCap + 'px');
        bar.style.setProperty('--sci-palette-max', paletteOpen ? paletteCap + 'px' : '32vh');
        // visual-viewport-only keyboard: the layout viewport (and the
        // sticky footer pinned to its bottom) does not shrink, so LIFT the
        // footer above the overlaid keyboard by the covered amount — and
        // shrink the app body by the SAME amount, so the notebook scroller
        // genuinely ends at the lifted footer's top and maximum scroll can
        // always reveal the last content (padding alone cannot push
        // content above the scroller's own top edge).
        const vv = window.visualViewport;
        const lift = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
        bar.style.transform = lift > 0 ? `translateY(-${lift}px)` : '';
        const appBody = document.getElementById('app-body');
        if (appBody) appBody.style.setProperty('--sci-vv-lift', lift + 'px');
    }

    _installGeometryObservers() {
        this._observedScrollers = new Set();
        this._resizeObserver = new ResizeObserver(() => this._measureFooterOverlay());
        const bar = document.getElementById('input-bar');
        if (bar) this._resizeObserver.observe(bar);
        this._onViewportChange = () => this._measureFooterOverlay();
        window.addEventListener('resize', this._onViewportChange);
        this._attachVisualViewportListeners();
        // composer growth may be CAPPED (bar size unchanged -> no resize
        // event), and safe-area insets arrive as style mutations on the
        // document element — both must re-run the budget
        this._onComposerInput = () => this.publishPaletteSpace();
        if (this.input) this.input.addEventListener('input', this._onComposerInput);
        this._insetObserver = new MutationObserver(() => this.publishPaletteSpace());
        this._insetObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
        this._measureFooterOverlay();
    }

    /** Subscribe to the CURRENT window.visualViewport — both 'resize' and
     *  'scroll', because the footer lift depends on offsetTop, which
     *  changes on visual-viewport PANNING without any resize. Re-invoked
     *  by tests that substitute the visual viewport. */
    _attachVisualViewportListeners() {
        if (this._vvTarget && this._vvTarget.removeEventListener) {
            this._vvTarget.removeEventListener('resize', this._onViewportChange);
            this._vvTarget.removeEventListener('scroll', this._onViewportChange);
        }
        this._vvTarget = window.visualViewport || null;
        if (this._vvTarget && this._vvTarget.addEventListener) {
            this._vvTarget.addEventListener('resize', this._onViewportChange);
            this._vvTarget.addEventListener('scroll', this._onViewportChange);
        }
    }

    /** Lifecycle cleanup: detach EVERY listener and observer, so a
     *  destroyed-then-recreated MathMode never doubles handlers. */
    destroy() {
        this._destroyed = true;
        if (this._pendingFrame) { cancelAnimationFrame(this._pendingFrame); this._pendingFrame = null; }
        window.removeEventListener('resize', this._onViewportChange);
        if (this._vvTarget && this._vvTarget.removeEventListener) {
            this._vvTarget.removeEventListener('resize', this._onViewportChange);
            this._vvTarget.removeEventListener('scroll', this._onViewportChange);
        }
        this._vvTarget = null;
        if (this.input && this._onComposerInput) this.input.removeEventListener('input', this._onComposerInput);
        if (this.toggleBtn && this._onToggleClick) this.toggleBtn.removeEventListener('click', this._onToggleClick);
        if (this.palette && this._onPaletteClick) this.palette.removeEventListener('click', this._onPaletteClick);
        if (this._onContextChanged) document.removeEventListener('scirepl:composer-context-changed', this._onContextChanged);
        if (this.langSelector && this._onLangChange) this.langSelector.removeEventListener('change', this._onLangChange);
        if (this.cellTypeToggle && this._onCellTypeClick) this.cellTypeToggle.removeEventListener('click', this._onCellTypeClick);
        if (this._insetObserver) this._insetObserver.disconnect();
        if (this._resizeObserver) this._resizeObserver.disconnect();
    }

    /** Reflect the current composer context in the palette and its control. */
    syncContext() {
        const ctx = this.context();
        if (ctx === null) {
            this.toggleBtn.classList.add('lang-hidden');
            this.setOpen(false);
            return;
        }
        this.toggleBtn.classList.remove('lang-hidden');
        this.palette.dataset.context = ctx;
        this.publishPaletteSpace();
    }

    /** True when the caret sits inside a math span — delegated to the ONE
     *  shared tokenizer (md_math.js) the renderer also uses, so the palette
     *  and the rendered output can never disagree about what is math:
     *  escaped '\$', inline code spans (any backtick run length), fenced
     *  code blocks, and '$' vs '$$' as distinct tokens are all honored. */
    caretInsideMathSpan() {
        const state = window.MdMath.stateAt(this.input.value, this.input.selectionStart);
        return state === 'inline' || state === 'display';
    }

    /** Insert a LaTeX template. Outside a math span the template is wrapped
     *  in $...$; inside one it is inserted bare (never nest delimiters).
     *  The marker character marks the caret position. */
    insertLatex(template) {
        const inside = this.caretInsideMathSpan();
        let text = inside ? template : '$' + template + '$';
        let caretAt = text.indexOf(MATH_CURSOR_MARKER);
        text = text.replace(MATH_CURSOR_MARKER, '');
        if (caretAt === -1) caretAt = text.length;
        this.replaceSelection(text, caretAt);
    }

    /** Insert Python palette text with the historical cursor conventions. */
    insertText(text) {
        let caretAt = text.length;
        const firstComma = text.indexOf(',');
        if (text.endsWith('()')) caretAt = text.length - 1;
        else if (text === "symbols('')") caretAt = text.length - 2;
        else if (text === 'Matrix([[]])') caretAt = text.length - 3;
        else if (firstComma !== -1) caretAt = firstComma;
        this.replaceSelection(text, caretAt);
    }

    replaceSelection(text, caretAt) {
        const start = this.input.selectionStart;
        const end = this.input.selectionEnd;
        const value = this.input.value;
        this.input.value = value.substring(0, start) + text + value.substring(end);
        this.input.selectionStart = this.input.selectionEnd = start + caretAt;
        this.input.focus();
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// Any code that changes the composer language or cell type programmatically
// calls this (or dispatches the event directly).
window.notifyComposerContextChanged = function () {
    document.dispatchEvent(new Event('scirepl:composer-context-changed'));
};

// Initialize
window.mathMode = new MathMode();
