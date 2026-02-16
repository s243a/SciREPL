/**
 * app.js — Sci REPL main application.
 * Initializes Pyodide, manages the REPL loop, and handles card creation.
 * Supports editable cells — click a past input card to edit and re-run.
 */

(function () {
    'use strict';

    // ---- DOM refs ----
    const overlay = document.getElementById('loading-overlay');
    const badge = document.getElementById('status-badge');
    const repl = document.getElementById('repl');
    const input = document.getElementById('code-input');
    const runBtn = document.getElementById('run-btn');

    let pyodide = null;
    // Load cell counter from session
    let cellCounter = window.sessionManager ? window.sessionManager.session.cellCounter : 0;

    // Track all cells for export and re-evaluation
    // Each entry: { id, code, inputCard, outputCard }
    window._cells = [];

    // Initialize history navigation index
    if (window.sessionManager) {
        window.sessionManager.session.historyIndex = -1;
    }

    // ---- Initialize Pyodide ----

    async function initPyodide() {
        try {
            pyodide = await loadPyodide();

            // Load core packages
            await pyodide.loadPackage(['numpy', 'sympy']);

            // Fetch and run the prelude
            const preludeResp = await fetch('js/prelude.py');
            const preludeCode = await preludeResp.text();
            await pyodide.runPythonAsync(preludeCode);

            // Ready!
            overlay.classList.add('hidden');
            badge.textContent = 'ready';
            badge.className = 'ready';
            runBtn.disabled = false;
            input.focus();

        } catch (err) {
            badge.textContent = 'error';
            badge.className = 'error';
            overlay.querySelector('p').textContent = 'Failed to load Python';
            overlay.querySelector('.loading-sub').textContent = err.message;
            console.error('Pyodide init failed:', err);
        }
    }

    // ---- Card creation ----

    function createInputCard(code, cellId) {
        const card = document.createElement('div');
        card.className = 'card card-input';
        card.dataset.cellId = cellId;
        card.innerHTML = `
            <div class="card-label">
                <span class="prompt-icon">In [${cellId}]</span>
                <button class="cell-edit-btn" title="Edit & re-run">✎</button>
            </div>
            <pre>${escapeHtml(code)}</pre>
        `;
        // Click the edit button to enter edit mode
        card.querySelector('.cell-edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            enterEditMode(card, cellId);
        });
        repl.appendChild(card);
        return card;
    }

    function createOutputCard(cellId) {
        const card = document.createElement('div');
        card.className = 'card card-output';
        card.dataset.cellId = cellId;
        card.innerHTML = `
            <div class="card-label">
                <span>Out [${cellId}]</span>
            </div>
            <div class="card-body"></div>
        `;
        repl.appendChild(card);
        return card;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- Editable cells ----

    function enterEditMode(inputCard, cellId) {
        if (inputCard.classList.contains('editing')) return;
        inputCard.classList.add('editing');

        const pre = inputCard.querySelector('pre');
        const currentCode = pre.textContent;

        // Replace <pre> with a textarea
        const textarea = document.createElement('textarea');
        textarea.className = 'cell-editor';
        textarea.value = currentCode;
        textarea.spellcheck = false;
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('autocomplete', 'off');
        pre.replaceWith(textarea);

        // Auto-resize
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        });

        // Add run/cancel buttons
        const actions = document.createElement('div');
        actions.className = 'cell-edit-actions';
        actions.innerHTML = `
            <button class="cell-run-btn">▶ Run</button>
            <button class="cell-run-below-btn">▶▶ Run All Below</button>
            <button class="cell-cancel-btn">Cancel</button>
        `;
        inputCard.appendChild(actions);

        actions.querySelector('.cell-run-btn').addEventListener('click', () => {
            const newCode = textarea.value.trim();
            exitEditMode(inputCard, cellId, newCode, true);
        });

        actions.querySelector('.cell-run-below-btn').addEventListener('click', () => {
            const newCode = textarea.value.trim();
            exitEditMode(inputCard, cellId, newCode, false);
            if (newCode) runCellAndBelow(cellId, newCode);
        });

        actions.querySelector('.cell-cancel-btn').addEventListener('click', () => {
            exitEditMode(inputCard, cellId, currentCode, false);
        });

        // Shift+Enter or Ctrl+Enter to run from within editor
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey)) {
                e.preventDefault();
                const newCode = textarea.value.trim();
                exitEditMode(inputCard, cellId, newCode, true);
            }
            if (e.key === 'Escape') {
                exitEditMode(inputCard, cellId, currentCode, false);
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
            }
        });

        textarea.focus();
    }

    function exitEditMode(inputCard, cellId, code, shouldRun) {
        inputCard.classList.remove('editing');

        // Remove action buttons
        const actions = inputCard.querySelector('.cell-edit-actions');
        if (actions) actions.remove();

        // Replace textarea with pre
        const textarea = inputCard.querySelector('.cell-editor');
        const pre = document.createElement('pre');
        pre.textContent = code;
        if (textarea) textarea.replaceWith(pre);

        if (shouldRun && code) {
            reRunCell(cellId, code);
        }
    }

    async function reRunCell(cellId, code) {
        if (!pyodide) return;

        // Find the cell record
        const cell = window._cells.find(c => c.id === cellId);
        if (!cell) return;

        // Update stored code
        cell.code = code;

        // Update input card display
        const pre = cell.inputCard.querySelector('pre');
        if (pre) pre.textContent = code;

        // Clear and reuse the output card
        let outputCard = cell.outputCard;
        if (outputCard) {
            outputCard.classList.remove('card-error');
            const body = outputCard.querySelector('.card-body');
            if (body) body.innerHTML = '';
        } else {
            // Create a new output card after the input card
            outputCard = createOutputCard(cellId);
            cell.inputCard.after(outputCard);
            cell.outputCard = outputCard;
        }

        runBtn.disabled = true;
        badge.textContent = 'running…';
        badge.className = 'running';
        window._currentOutputCard = outputCard;

        try {
            await executeCode(code);

            // Clean up empty output cards
            const body = outputCard.querySelector('.card-body');
            if (body && body.children.length === 0) {
                outputCard.remove();
                cell.outputCard = null;
            }
        } catch (err) {
            try { pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`); } catch (_) { }
            window.renderText(err.message, true);
        }

        window._currentOutputCard = null;
        badge.textContent = 'ready';
        badge.className = 'ready';
        runBtn.disabled = false;
    }

    // ---- Run cell and all below ----

    async function runCellAndBelow(cellId, code) {
        const idx = window._cells.findIndex(c => c.id === cellId);
        if (idx === -1) return;

        // Update the target cell's code
        window._cells[idx].code = code;
        const pre = window._cells[idx].inputCard.querySelector('pre');
        if (pre) pre.textContent = code;

        // Run this cell and every cell after it, sequentially
        for (let i = idx; i < window._cells.length; i++) {
            await reRunCell(window._cells[i].id, window._cells[i].code);
        }
    }

    // Exposed for menu "Run All" button
    window.runAllCells = async function () {
        for (let i = 0; i < window._cells.length; i++) {
            await reRunCell(window._cells[i].id, window._cells[i].code);
        }
    };

    // ---- Execute code (shared between new cells and re-runs) ----

    async function executeCode(code) {
        // Capture stdout
        pyodide.runPython(`
import io, sys
_sci_repl_stdout = io.StringIO()
_sci_repl_old_stdout = sys.stdout
sys.stdout = _sci_repl_stdout
`);

        // Run the user's code
        let result = await pyodide.runPythonAsync(code);

        // Capture printed output
        pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`);
        const printed = pyodide.runPython(`_sci_repl_stdout.getvalue()`);

        // Show printed output
        if (printed && printed.length > 0) {
            window.renderText(printed, false);
        }

        // Check if code ends with semicolon (MATLAB/IPython-style suppression)
        const suppressOutput = code.trimEnd().endsWith(';');

        // Show return value (if not None, not already printed, and not suppressed)
        if (result !== undefined && result !== null && !suppressOutput) {
            // Check if it's a list of SymPy expressions
            const isSympyList = pyodide.runPython(`_is_sympy_list(${getResultVarRef(result)})`);

            if (isSympyList) {
                const tex = pyodide.runPython(`_sympy_list_to_latex(${getResultVarRef(result)})`);
                window.renderLatex(tex);
            } else {
                // Check if it's a single SymPy expression
                const isSympy = pyodide.runPython(`_is_sympy(${getResultVarRef(result)})`);

                if (isSympy) {
                    const tex = pyodide.runPython(`_sympy_to_latex(${getResultVarRef(result)})`);
                    window.renderLatex(tex);
                } else {
                    // Stringify the result
                    let resultStr = result.toString();

                    // Truncate if too long
                    const MAX_OUTPUT = 10000;
                    if (resultStr.length > MAX_OUTPUT) {
                        resultStr = resultStr.substring(0, MAX_OUTPUT) +
                            '\n... (output truncated, ' + resultStr.length + ' chars total)';
                    }

                    if (resultStr !== 'None' && resultStr !== '') {
                        window.renderText(resultStr, false);
                    }
                }
            }
        }
    }

    // ---- Run code (new cell from input bar) ----

    async function runCode() {
        const code = input.value.trim();
        if (!code || !pyodide) return;

        // Disable input while running
        runBtn.disabled = true;
        badge.textContent = 'running…';
        badge.className = 'running';

        cellCounter++;
        const cellId = cellCounter;

        // Create cards
        const inputCard = createInputCard(code, cellId);
        const outputCard = createOutputCard(cellId);
        window._currentOutputCard = outputCard;

        // Track this cell
        const cell = { id: cellId, code: code, inputCard: inputCard, outputCard: outputCard };
        window._cells.push(cell);

        try {
            await executeCode(code);

            // Save to history
            if (window.sessionManager) {
                window.sessionManager.addToHistory(code);
                window.sessionManager.session.historyIndex = -1;
                window.sessionManager.session.cellCounter = cellCounter;
                window.sessionManager.save();
            }

            // Clean up empty output cards
            const body = outputCard.querySelector('.card-body');
            if (body && body.children.length === 0) {
                outputCard.remove();
                cell.outputCard = null;
            }

        } catch (err) {
            // Restore stdout on error
            try {
                pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`);
            } catch (_) { }

            window.renderText(err.message, true);
        }

        // Reset state
        window._currentOutputCard = null;
        badge.textContent = 'ready';
        badge.className = 'ready';
        runBtn.disabled = false;

        // Clear input and scroll to bottom
        input.value = '';
        if (window.sessionManager) {
            window.sessionManager.session.historyIndex = -1;
        }
        input.style.height = 'auto';
        repl.scrollTop = repl.scrollHeight;
        input.focus();
    }

    /**
     * Get a reference to a Python result for introspection.
     * We stash the last result in a Python variable so we can check its type.
     */
    function getResultVarRef(result) {
        // Store the result in a Python variable for type checking
        pyodide.globals.set('_last_result', result);
        return '_last_result';
    }

    // ---- Auto-resize textarea ----

    function autoResize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    }

    // ---- Event listeners ----

    runBtn.addEventListener('click', runCode);

    input.addEventListener('keydown', (e) => {
        // Shift+Enter or Ctrl+Enter to run
        if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey)) {
            e.preventDefault();
            runCode();
        }
        // Up arrow: History back
        if (e.key === 'ArrowUp') {
            if (window.sessionManager) {
                const session = window.sessionManager.session;
                if (session.historyIndex < session.history.length - 1) {
                    e.preventDefault();
                    session.historyIndex++;
                    const idx = session.history.length - 1 - session.historyIndex;
                    if (idx >= 0) {
                        input.value = session.history[idx];
                        autoResize();
                    }
                }
            }
        }
        // Down arrow: History forward
        if (e.key === 'ArrowDown') {
            if (window.sessionManager) {
                const session = window.sessionManager.session;
                if (session.historyIndex > -1) {
                    e.preventDefault();
                    session.historyIndex--;
                    if (session.historyIndex === -1) {
                        input.value = ''; // Clear if back to "now"
                    } else {
                        const idx = session.history.length - 1 - session.historyIndex;
                        input.value = session.history[idx];
                    }
                    autoResize();
                }
            }
        }
        // Tab inserts spaces
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = input.selectionStart;
            const end = input.selectionEnd;
            input.value = input.value.substring(0, start) + '    ' + input.value.substring(end);
            input.selectionStart = input.selectionEnd = start + 4;
        }
    });

    input.addEventListener('input', autoResize);

    // ---- Help modal ----

    const helpBtn = document.getElementById('help-btn');
    const helpModal = document.getElementById('help-modal');
    const modalClose = helpModal.querySelector('.modal-close');

    helpBtn.addEventListener('click', () => {
        helpModal.classList.remove('hidden');
    });

    modalClose.addEventListener('click', () => {
        helpModal.classList.add('hidden');
    });

    // Close modal on backdrop click
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) {
            helpModal.classList.add('hidden');
        }
    });

    // ---- Start ----
    initPyodide();

})();
