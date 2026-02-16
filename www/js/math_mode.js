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

        // If text looks like "func()", put cursor inside parens
        if (text.endsWith('()')) {
            newCursorPos -= 1;
        } else if (text.endsWith('(, x)')) {
            // For diff/integrate helpers, move before comma
            newCursorPos -= 4;
        } else if (text === 'Matrix([[]])') {
            // Inside inner brackets
            newCursorPos -= 3;
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
