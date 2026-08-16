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
        this.toggleBtn.addEventListener('click', () => {
            this.syncContext();               // never open a stale palette
            if (this.context() === null) return;
            this.setOpen(this.palette.classList.contains('hidden'));
        });

        this.palette.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') return;
            const text = e.target.getAttribute('data-insert');
            if (!text) return;
            if (e.target.getAttribute('data-mode') === 'latex') this.insertLatex(text);
            else this.insertText(text);
        });

        // Central synchronization: programmatic context changes announce
        // themselves; direct user interactions are covered as a fallback
        // (deferred a tick so the app's own handlers update state first).
        document.addEventListener('scirepl:composer-context-changed', () => this.syncContext());
        if (this.langSelector) this.langSelector.addEventListener('change', () => setTimeout(() => this.syncContext(), 0));
        if (this.cellTypeToggle) this.cellTypeToggle.addEventListener('click', () => setTimeout(() => this.syncContext(), 0));
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
        requestAnimationFrame(() => this._measureFooterOverlay());
    }

    _measureFooterOverlay() {
        const bar = document.getElementById('input-bar');
        if (!bar) return;
        const barTop = bar.getBoundingClientRect().top;
        for (const scroller of document.querySelectorAll('#repl, .repl-container')) {
            if (!this._observedScrollers.has(scroller)) {
                this._observedScrollers.add(scroller);
                this._resizeObserver.observe(scroller);
            }
            if (scroller.offsetParent === null) continue;   // hidden notebook
            const overlap = Math.max(0, scroller.getBoundingClientRect().bottom - barTop);
            scroller.style.setProperty('--footer-overlay-local', Math.ceil(overlap) + 'px');
        }
    }

    _installGeometryObservers() {
        this._observedScrollers = new Set();
        this._resizeObserver = new ResizeObserver(() => this._measureFooterOverlay());
        const bar = document.getElementById('input-bar');
        if (bar) this._resizeObserver.observe(bar);
        window.addEventListener('resize', () => this._measureFooterOverlay());
        if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this._measureFooterOverlay());
        this._measureFooterOverlay();
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
