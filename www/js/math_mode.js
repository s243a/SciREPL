/**
 * math_mode.js — Handles Math Mode UI interactions.
 */

class MathMode {
    constructor() {
        this.palette = document.getElementById('math-palette');
        this.toggleBtn = document.getElementById('math-mode-btn');
        this.input = document.getElementById('code-input');

        this.init();
    }

    init() {
        // Toggle palette visibility
        this.toggleBtn.addEventListener('click', () => {
            this.palette.classList.toggle('hidden');
            this.toggleBtn.classList.toggle('active');
        });

        // Contextual visibility: the palette inserts SymPy calls, which only
        // mean something in Python cells. Hide the button (and close the
        // palette) for other composer languages. Future direction: per-
        // language palettes and numeric-vs-symbolic context awareness.
        this.langSelector = document.getElementById('lang-selector');
        if (this.langSelector) {
            this.langSelector.addEventListener('change', () => this.syncLanguage());
            this.syncLanguage();
        }

        // Handle palette button clicks
        this.palette.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') {
                const text = e.target.getAttribute('data-insert');
                if (text) {
                    this.insertText(text);
                }
            }
        });
    }

    /** Show the palette control only for languages it applies to. */
    syncLanguage() {
        const applies = !this.langSelector || this.langSelector.value === 'python';
        this.toggleBtn.classList.toggle('lang-hidden', !applies);
        if (!applies) {
            this.palette.classList.add('hidden');
            this.toggleBtn.classList.remove('active');
        }
    }

    /**
     * Insert text into the code input at the cursor position.
     */
    insertText(text) {
        const start = this.input.selectionStart;
        const end = this.input.selectionEnd;
        const value = this.input.value;

        // Insert text
        this.input.value = value.substring(0, start) + text + value.substring(end);

        // Move cursor inside parentheses if they exist, or to end
        let newCursorPos = start + text.length;

        // Place cursor at the first comma or inside empty parens/quotes
        const firstComma = text.indexOf(',');
        if (text.endsWith('()')) {
            newCursorPos -= 1;
        } else if (text === "symbols('')") {
            newCursorPos -= 2; // Inside quotes
        } else if (text === 'Matrix([[]])') {
            newCursorPos -= 3; // Inside inner brackets
        } else if (firstComma !== -1) {
            // For patterns like "diff(, x)" or "limit(, x, oo)" — cursor before first comma
            newCursorPos = start + firstComma;
        }

        this.input.selectionStart = this.input.selectionEnd = newCursorPos;
        this.input.focus();

        // Trigger resize
        const event = new Event('input', { bubbles: true });
        this.input.dispatchEvent(event);
    }
}

// Initialize
window.mathMode = new MathMode();
