/**
 * app.js — Sci REPL main application.
 * Initializes Pyodide, manages the REPL loop, and handles card creation.
 * Supports editable cells and markdown/code cell types.
 */

(function () {
    'use strict';

    // ---- DOM refs ----
    const overlay = document.getElementById('loading-overlay');
    const badge = document.getElementById('status-badge');
    const repl = document.getElementById('repl');
    const input = document.getElementById('code-input');
    const runBtn = document.getElementById('run-btn');
    const cellTypeToggle = document.getElementById('cell-type-toggle');

    let pyodide = null;
    let cellCounter = window.sessionManager ? window.sessionManager.session.cellCounter : 0;

    // Current input bar cell type: 'code' or 'markdown'
    let currentCellType = 'code';

    // Track all cells for export and re-evaluation
    // Each entry: { id, code, type: 'code'|'markdown', inputCard, outputCard }
    window._cells = [];

    if (window.sessionManager) {
        window.sessionManager.session.historyIndex = -1;
    }

    // ---- Cell type toggle ----

    cellTypeToggle.addEventListener('click', () => {
        if (currentCellType === 'code') {
            currentCellType = 'markdown';
            cellTypeToggle.textContent = 'Md';
            cellTypeToggle.classList.add('markdown-active');
            input.placeholder = 'Type Markdown here… (supports $LaTeX$)';
        } else {
            currentCellType = 'code';
            cellTypeToggle.textContent = 'Code';
            cellTypeToggle.classList.remove('markdown-active');
            input.placeholder = 'Type Python here…';
        }
    });

    // ---- Initialize Pyodide ----

    async function initPyodide() {
        try {
            pyodide = await loadPyodide();
            await pyodide.loadPackage(['numpy', 'sympy']);

            const preludeResp = await fetch('js/prelude.py');
            const preludeCode = await preludeResp.text();
            await pyodide.runPythonAsync(preludeCode);

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

    // ---- Markdown rendering ----

    /**
     * Render markdown text to HTML with KaTeX math support.
     * Supports $inline$ and $$display$$ math blocks.
     */
    function renderMarkdown(text) {
        // Protect math blocks from marked's HTML escaping
        const mathBlocks = [];

        // Replace $$...$$ display math
        let processed = text.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
            const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
            mathBlocks.push({ tex: tex.trim(), display: true });
            return id;
        });

        // Replace $...$ inline math (not greedy, no newlines)
        processed = processed.replace(/\$([^\$\n]+?)\$/g, (match, tex) => {
            const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
            mathBlocks.push({ tex: tex.trim(), display: false });
            return id;
        });

        // Render markdown
        let html = marked.parse(processed);

        // Restore math blocks with KaTeX rendering
        mathBlocks.forEach((block, i) => {
            const placeholder = `%%MATH_BLOCK_${i}%%`;
            let rendered;
            try {
                rendered = katex.renderToString(block.tex, {
                    throwOnError: false,
                    displayMode: block.display
                });
            } catch (e) {
                rendered = `<code>${block.tex}</code>`;
            }
            html = html.replace(placeholder, rendered);
        });

        return html;
    }

    // ---- Card creation ----

    function createInputCard(code, cellId, cellType) {
        const card = document.createElement('div');
        const isMarkdown = cellType === 'markdown';
        card.className = 'card card-input' + (isMarkdown ? ' card-markdown' : '');
        card.dataset.cellId = cellId;
        card.dataset.cellType = cellType;

        const typeLabel = isMarkdown ? 'Md' : 'In';
        card.innerHTML = `
            <div class="card-label">
                <span class="prompt-icon">${typeLabel} [${cellId}]</span>
                <button class="cell-edit-btn" title="Edit & re-run">✎</button>
            </div>
            <pre${isMarkdown ? ' class="md-source"' : ''}>${escapeHtml(code)}</pre>
        `;
        card.querySelector('.cell-edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            enterEditMode(card, cellId);
        });
        repl.appendChild(card);
        return card;
    }

    function createOutputCard(cellId, cellType) {
        const card = document.createElement('div');
        const isMarkdown = cellType === 'markdown';
        card.className = 'card card-output' + (isMarkdown ? ' card-markdown-output' : '');
        card.dataset.cellId = cellId;

        if (isMarkdown) {
            // Markdown output has no label, just rendered content
            card.innerHTML = `<div class="card-body markdown-body"></div>`;
        } else {
            card.innerHTML = `
                <div class="card-label">
                    <span>Out [${cellId}]</span>
                </div>
                <div class="card-body"></div>
            `;
        }
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

        const cell = window._cells.find(c => c.id === cellId);
        const cellType = cell ? cell.type : 'code';

        const pre = inputCard.querySelector('pre');
        const currentCode = pre.textContent;

        const textarea = document.createElement('textarea');
        textarea.className = 'cell-editor';
        textarea.value = currentCode;
        textarea.spellcheck = cellType === 'markdown';
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('autocomplete', 'off');
        pre.replaceWith(textarea);

        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        });

        const actions = document.createElement('div');
        actions.className = 'cell-edit-actions';
        actions.innerHTML = `
            <button class="cell-type-switch-btn">${cellType === 'markdown' ? 'Md' : 'Code'}</button>
            <button class="cell-run-btn">▶ Run</button>
            <button class="cell-run-below-btn">▶▶ Run All Below</button>
            <button class="cell-cancel-btn">Cancel</button>
        `;
        inputCard.appendChild(actions);

        // Type switch button
        const typeSwitch = actions.querySelector('.cell-type-switch-btn');
        typeSwitch.addEventListener('click', () => {
            if (cell) {
                cell.type = cell.type === 'markdown' ? 'code' : 'markdown';
                typeSwitch.textContent = cell.type === 'markdown' ? 'Md' : 'Code';
                typeSwitch.classList.toggle('markdown-active', cell.type === 'markdown');
                textarea.spellcheck = cell.type === 'markdown';
            }
        });
        typeSwitch.classList.toggle('markdown-active', cellType === 'markdown');

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

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey)) {
                e.preventDefault();
                exitEditMode(inputCard, cellId, textarea.value.trim(), true);
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

        const actions = inputCard.querySelector('.cell-edit-actions');
        if (actions) actions.remove();

        const cell = window._cells.find(c => c.id === cellId);
        const cellType = cell ? cell.type : 'code';

        // Update card classes to reflect current type
        inputCard.classList.toggle('card-markdown', cellType === 'markdown');

        const textarea = inputCard.querySelector('.cell-editor');
        const pre = document.createElement('pre');
        if (cellType === 'markdown') pre.className = 'md-source';
        pre.textContent = code;
        if (textarea) textarea.replaceWith(pre);

        // Update label
        const label = inputCard.querySelector('.prompt-icon');
        if (label) label.textContent = `${cellType === 'markdown' ? 'Md' : 'In'} [${cellId}]`;

        if (shouldRun && code) {
            reRunCell(cellId, code);
        }
    }

    // ---- Re-run a cell ----

    async function reRunCell(cellId, code) {
        const cell = window._cells.find(c => c.id === cellId);
        if (!cell) return;

        cell.code = code;

        const pre = cell.inputCard.querySelector('pre');
        if (pre) pre.textContent = code;

        if (cell.type === 'markdown') {
            reRenderMarkdownCell(cell);
            return;
        }

        // Code cell — needs Pyodide
        if (!pyodide) return;

        let outputCard = cell.outputCard;
        if (outputCard) {
            outputCard.classList.remove('card-error', 'card-markdown-output');
            const body = outputCard.querySelector('.card-body');
            if (body) {
                body.innerHTML = '';
                body.classList.remove('markdown-body');
            }
        } else {
            outputCard = createOutputCard(cellId, 'code');
            cell.inputCard.after(outputCard);
            cell.outputCard = outputCard;
        }

        runBtn.disabled = true;
        badge.textContent = 'running…';
        badge.className = 'running';
        window._currentOutputCard = outputCard;

        try {
            await executeCode(code);

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

    function reRenderMarkdownCell(cell) {
        let outputCard = cell.outputCard;
        if (outputCard) {
            const body = outputCard.querySelector('.card-body');
            if (body) body.innerHTML = '';
            outputCard.className = 'card card-output card-markdown-output';
        } else {
            outputCard = createOutputCard(cell.id, 'markdown');
            cell.inputCard.after(outputCard);
            cell.outputCard = outputCard;
        }

        const body = outputCard.querySelector('.card-body');
        if (!body) return;
        body.className = 'card-body markdown-body';
        body.innerHTML = renderMarkdown(cell.code);

        // Hide the source <pre> since the rendered output replaces it visually
        const pre = cell.inputCard.querySelector('pre');
        if (pre) pre.style.display = 'none';
    }

    // ---- Run cell and all below ----

    async function runCellAndBelow(cellId, code) {
        const idx = window._cells.findIndex(c => c.id === cellId);
        if (idx === -1) return;

        window._cells[idx].code = code;
        const pre = window._cells[idx].inputCard.querySelector('pre');
        if (pre) pre.textContent = code;

        for (let i = idx; i < window._cells.length; i++) {
            await reRunCell(window._cells[i].id, window._cells[i].code);
        }
    }

    window.runAllCells = async function () {
        for (let i = 0; i < window._cells.length; i++) {
            await reRunCell(window._cells[i].id, window._cells[i].code);
        }
    };

    // ---- Execute code (shared between new cells and re-runs) ----

    async function executeCode(code) {
        pyodide.runPython(`
import io, sys
_sci_repl_stdout = io.StringIO()
_sci_repl_old_stdout = sys.stdout
sys.stdout = _sci_repl_stdout
`);

        let result = await pyodide.runPythonAsync(code);

        pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`);
        const printed = pyodide.runPython(`_sci_repl_stdout.getvalue()`);

        if (printed && printed.length > 0) {
            window.renderText(printed, false);
        }

        const suppressOutput = code.trimEnd().endsWith(';');

        if (result !== undefined && result !== null && !suppressOutput) {
            const isSympyList = pyodide.runPython(`_is_sympy_list(${getResultVarRef(result)})`);

            if (isSympyList) {
                const tex = pyodide.runPython(`_sympy_list_to_latex(${getResultVarRef(result)})`);
                window.renderLatex(tex);
            } else {
                const isSympy = pyodide.runPython(`_is_sympy(${getResultVarRef(result)})`);

                if (isSympy) {
                    const tex = pyodide.runPython(`_sympy_to_latex(${getResultVarRef(result)})`);
                    window.renderLatex(tex);
                } else {
                    let resultStr = result.toString();

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

    // ---- Run from input bar (new cell) ----

    async function runCode() {
        const code = input.value.trim();
        if (!code) return;

        // Markdown cells don't need Pyodide
        if (currentCellType === 'code' && !pyodide) return;

        runBtn.disabled = true;
        cellCounter++;
        const cellId = cellCounter;

        const inputCard = createInputCard(code, cellId, currentCellType);
        const outputCard = createOutputCard(cellId, currentCellType);

        const cell = {
            id: cellId,
            code: code,
            type: currentCellType,
            inputCard: inputCard,
            outputCard: outputCard
        };
        window._cells.push(cell);

        if (currentCellType === 'markdown') {
            // Render markdown immediately
            const body = outputCard.querySelector('.card-body');
            body.innerHTML = renderMarkdown(code);

            // Hide source pre
            const pre = inputCard.querySelector('pre');
            if (pre) pre.style.display = 'none';
        } else {
            badge.textContent = 'running…';
            badge.className = 'running';
            window._currentOutputCard = outputCard;

            try {
                await executeCode(code);

                if (window.sessionManager) {
                    window.sessionManager.addToHistory(code);
                    window.sessionManager.session.historyIndex = -1;
                    window.sessionManager.session.cellCounter = cellCounter;
                    window.sessionManager.save();
                }

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
        }

        runBtn.disabled = false;
        input.value = '';
        if (window.sessionManager) {
            window.sessionManager.session.historyIndex = -1;
        }
        input.style.height = 'auto';
        repl.scrollTop = repl.scrollHeight;
        input.focus();
    }

    function getResultVarRef(result) {
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
        if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey)) {
            e.preventDefault();
            runCode();
        }
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
        if (e.key === 'ArrowDown') {
            if (window.sessionManager) {
                const session = window.sessionManager.session;
                if (session.historyIndex > -1) {
                    e.preventDefault();
                    session.historyIndex--;
                    if (session.historyIndex === -1) {
                        input.value = '';
                    } else {
                        const idx = session.history.length - 1 - session.historyIndex;
                        input.value = session.history[idx];
                    }
                    autoResize();
                }
            }
        }
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

    helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
    modalClose.addEventListener('click', () => helpModal.classList.add('hidden'));
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.classList.add('hidden');
    });

    // ---- Start ----
    initPyodide();

})();
