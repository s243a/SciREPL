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
        this.toggleBtn.addEventListener('click', () => {
            this.syncContext();               // never open a stale palette
            if (this.context() === null) return;
            this.palette.classList.toggle('hidden');
            this.toggleBtn.classList.toggle('active');
            this.publishPaletteSpace();
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
        this.syncContext();
    }

    /** 'python' | 'markdown' | null (no palette for this context). */
    context() {
        if (this.cellTypeToggle && this.cellTypeToggle.classList.contains('markdown-active')) return 'markdown';
        if (!this.langSelector || this.langSelector.value === 'python') return 'python';
        return null;
    }

    /** The sticky footer overlays the #repl scroller (body is a block
     *  layout), so the scroller reserves the MEASURED overlap as bottom
     *  padding — however tall the footer currently is (palette open,
     *  closed, or context-switched). Measured after a frame so the new
     *  footer size has settled (layout invariant, test_math_palette.mjs). */
    publishPaletteSpace() {
        requestAnimationFrame(() => {
            const repl = document.getElementById('repl');
            const bar = document.getElementById('input-bar');
            if (!repl || !bar) return;
            const overlap = Math.max(0, repl.getBoundingClientRect().bottom - bar.getBoundingClientRect().top);
            document.documentElement.style.setProperty('--footer-overlay', Math.ceil(overlap) + 'px');
        });
    }

    /** Reflect the current composer context in the palette and its control. */
    syncContext() {
        const ctx = this.context();
        if (ctx === null) {
            this.toggleBtn.classList.add('lang-hidden');
            this.toggleBtn.classList.remove('active');
            this.palette.classList.add('hidden');
            this.publishPaletteSpace();
            return;
        }
        this.toggleBtn.classList.remove('lang-hidden');
        this.palette.dataset.context = ctx;
        this.publishPaletteSpace();
    }

    /** True when the caret sits inside a $...$ / $$...$$ math span: an odd
     *  number of unescaped '$' characters precedes it. */
    caretInsideMathSpan() {
        const before = this.input.value.slice(0, this.input.selectionStart);
        const dollars = (before.match(/(?<!\\)\$/g) || []).length;
        return dollars % 2 === 1;
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
