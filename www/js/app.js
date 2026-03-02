/**
 * app.js — Sci REPL main application.
 * Initializes language kernels via KernelManager, manages the REPL loop,
 * and handles card creation. Supports editable cells, markdown/code cell
 * types, and multiple languages (Python, Prolog).
 */

(function () {
    'use strict';

    // ---- DOM refs ----
    const overlay = document.getElementById('loading-overlay');
    const badge = document.getElementById('status-badge');
    const input = document.getElementById('code-input');
    const runBtn = document.getElementById('run-btn');
    const cellTypeToggle = document.getElementById('cell-type-toggle');
    const langSelector = document.getElementById('lang-selector');

    // Cell counter on window for notebook switching
    if (window._cellCounter === undefined) {
        window._cellCounter = window.sessionManager ? window.sessionManager.session.cellCounter : 0;
    }

    // Restore draft input immediately (before Pyodide loads)
    try {
        const draftInput = sessionStorage.getItem('scirepl_draft_input');
        if (draftInput && input) {
            input.value = draftInput;
            sessionStorage.removeItem('scirepl_draft_input');
        }
    } catch (e) { /* sessionStorage unavailable */ }

    /**
     * Get the active REPL container element.
     * Uses NotebookManager's active notebook container if available,
     * otherwise falls back to the default #repl element.
     */
    function getRepl() {
        if (window.notebookManager) {
            const nb = window.notebookManager.getActiveNotebook();
            if (nb && nb.replContainer) return nb.replContainer;
        }
        return document.getElementById('repl');
    }

    // Current input bar cell type: 'code' or 'markdown'
    let currentCellType = 'code';

    // Track all cells for export and re-evaluation
    // Each entry: { id, code, type: 'code'|'markdown', language: 'python'|'prolog', inputCard, outputCard }
    if (!window._cells) window._cells = [];

    if (window.sessionManager) {
        window.sessionManager.session.historyIndex = -1;
    }

    // ---- Language selector ----

    function getCurrentLanguage() {
        return langSelector ? langSelector.value : 'python';
    }

    if (langSelector) {
        langSelector.addEventListener('change', () => {
            const lang = langSelector.value;
            if (window.kernelManager) {
                window.kernelManager.setLanguage(lang);
            }
            // Update visual styling
            const activeClasses = { prolog: 'prolog-active', bash: 'bash-active', javascript: 'javascript-active', r: 'r-active' };
            langSelector.className = activeClasses[lang] || '';
            // Update placeholder
            if (currentCellType === 'code') {
                const placeholders = { prolog: 'Type Prolog here…', bash: 'Type Bash here…', javascript: 'Type JavaScript here…', r: 'Type R here…' };
                input.placeholder = placeholders[lang] || 'Type Python here…';
            }
        });
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
            const lang = getCurrentLanguage();
            const ph = { prolog: 'Type Prolog here…', bash: 'Type Bash here…', javascript: 'Type JavaScript here…', r: 'Type R here…' };
            input.placeholder = ph[lang] || 'Type Python here…';
        }
    });

    // ---- Initialize default kernel (Python) ----

    async function initDefaultKernel() {
        try {
            const km = window.kernelManager;
            if (!km) throw new Error('KernelManager not loaded');

            // Python is the default — init it now
            await km.ensureReady('python');

            overlay.classList.add('hidden');
            badge.textContent = 'ready';
            badge.className = 'ready';
            runBtn.disabled = false;

            // Restore saved cells
            await restoreSession();

            input.focus();

        } catch (err) {
            badge.textContent = 'error';
            badge.className = 'error';
            overlay.querySelector('p').textContent = 'Failed to load Python';
            overlay.querySelector('.loading-sub').textContent = err.message;
            console.error('Kernel init failed:', err);
        }
    }

    // ---- Markdown rendering ----

    /**
     * Render markdown text to HTML with KaTeX math support.
     * Supports $inline$ and $$display$$ math blocks.
     */
    function renderMarkdown(text) {
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

        let html = marked.parse(processed);

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

    function createInputCard(code, cellId, cellType, language) {
        const card = document.createElement('div');
        const isMarkdown = cellType === 'markdown';
        card.className = 'card card-input' + (isMarkdown ? ' card-markdown' : '');
        card.dataset.cellId = cellId;
        card.dataset.cellType = cellType;
        card.dataset.language = language || 'python';

        const typeLabel = isMarkdown ? 'Md' : 'In';
        const langBadge = !isMarkdown
            ? ` <span class="lang-badge lang-${language || 'python'}">${language || 'python'}</span>`
            : '';
        card.draggable = true;
        card.innerHTML = `
            <div class="card-label">
                <span class="cell-drag-handle" title="Drag to reorder">⠿</span>
                <span class="prompt-icon">${typeLabel} [${cellId}]</span>${langBadge}
                <button class="cell-move-btn cell-move-up" title="Move up">▲</button>
                <button class="cell-move-btn cell-move-down" title="Move down">▼</button>
                <button class="cell-edit-btn" title="Edit & re-run">✎</button>
                <button class="cell-delete-btn" title="Delete cell">✕</button>
            </div>
            <pre${isMarkdown ? ' class="md-source"' : ''}>${isMarkdown ? escapeHtml(code) : '<code>' + highlightCode(code, language) + '</code>'}</pre>
        `;
        card.querySelector('.cell-edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            enterEditMode(card, cellId);
        });
        card.querySelector('.cell-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCell(cellId);
        });
        card.querySelector('.cell-move-up').addEventListener('click', (e) => {
            e.stopPropagation();
            moveCellUp(cellId);
        });
        card.querySelector('.cell-move-down').addEventListener('click', (e) => {
            e.stopPropagation();
            moveCellDown(cellId);
        });

        // Drag-and-drop: only allow drag from the handle
        // Track whether mousedown/touchstart originated on the handle
        let _dragFromHandle = false;
        card.querySelector('.cell-drag-handle').addEventListener('mousedown', () => {
            _dragFromHandle = true;
        });
        card.addEventListener('dragstart', (e) => {
            if (!_dragFromHandle) {
                e.preventDefault();
                return;
            }
            _dragFromHandle = false;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(cellId));
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            _dragFromHandle = false;
            card.classList.remove('dragging');
            _clearDragIndicators();
        });

        getRepl().appendChild(card);
        return card;
    }

    function createOutputCard(cellId, cellType) {
        const card = document.createElement('div');
        const isMarkdown = cellType === 'markdown';
        card.className = 'card card-output' + (isMarkdown ? ' card-markdown-output' : '');
        card.dataset.cellId = cellId;

        if (isMarkdown) {
            card.innerHTML = `<div class="card-body markdown-body"></div>`;
        } else {
            card.innerHTML = `
                <div class="card-label">
                    <span>Out [${cellId}]</span>
                </div>
                <div class="card-body"></div>
            `;
        }
        getRepl().appendChild(card);
        return card;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /** Syntax-highlight code using highlight.js if available. Falls back to escapeHtml. */
    function highlightCode(code, language) {
        if (typeof window.hljs !== 'undefined') {
            const langMap = { python: 'python', javascript: 'javascript', r: 'r', bash: 'bash', prolog: 'prolog' };
            const hljsLang = langMap[language];
            if (hljsLang && window.hljs.getLanguage(hljsLang)) {
                try { return window.hljs.highlight(code, { language: hljsLang }).value; } catch (e) { /* fall through */ }
            }
        }
        return escapeHtml(code);
    }

    /** Set the code content of an input card's <pre>, applying syntax highlighting. */
    function setPreHighlighted(pre, code, language, isMarkdown) {
        if (isMarkdown) {
            pre.textContent = code;
        } else {
            pre.innerHTML = '<code>' + highlightCode(code, language) + '</code>';
        }
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
        const cellLang = cell ? (cell.language || 'python') : 'python';
        actions.innerHTML = `
            <button class="cell-type-switch-btn">${cellType === 'markdown' ? 'Md' : 'Code'}</button>
            <select class="cell-lang-switch" title="Cell language">
                <option value="python"${cellLang === 'python' ? ' selected' : ''}>Py</option>
                <option value="r"${cellLang === 'r' ? ' selected' : ''}>R</option>
                <option value="prolog"${cellLang === 'prolog' ? ' selected' : ''}>PL</option>
                <option value="bash"${cellLang === 'bash' ? ' selected' : ''}>Sh</option>
                <option value="javascript"${cellLang === 'javascript' ? ' selected' : ''}>JS</option>
            </select>
            <button class="cell-lang-apply-all" title="Apply language to all code cells">All→</button>
            <button class="cell-run-btn">▶ Run</button>
            <button class="cell-run-below-btn">▶▶ Run All Below</button>
            <button class="cell-cancel-btn">Cancel</button>
        `;
        inputCard.appendChild(actions);

        // Cell language switch
        const langSwitch = actions.querySelector('.cell-lang-switch');
        function updateCellLangBadge(targetCell, newLang) {
            targetCell.language = newLang;
            targetCell.inputCard.dataset.language = newLang;
            const existingBadge = targetCell.inputCard.querySelector('.lang-badge');
            if (existingBadge) existingBadge.remove();
            const labelSpan = targetCell.inputCard.querySelector('.prompt-icon');
            if (labelSpan) {
                const badge = document.createElement('span');
                badge.className = 'lang-badge lang-' + newLang;
                badge.textContent = newLang;
                labelSpan.insertAdjacentElement('afterend', badge);
            }
        }
        langSwitch.addEventListener('change', () => {
            if (cell) updateCellLangBadge(cell, langSwitch.value);
        });

        // Apply language to all code cells (skip cells with %% magic)
        actions.querySelector('.cell-lang-apply-all').addEventListener('click', () => {
            const newLang = langSwitch.value;
            for (const c of window._cells) {
                if (c.type === 'markdown') continue;
                if (c.code && c.code.match(/^%%\w+/)) continue;
                updateCellLangBadge(c, newLang);
            }
            // Also update the main language selector
            if (langSelector) langSelector.value = newLang;
            if (window.kernelManager) window.kernelManager.setLanguage(newLang);
            saveCellsToSession();
        });

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

        inputCard.classList.toggle('card-markdown', cellType === 'markdown');

        const textarea = inputCard.querySelector('.cell-editor');
        const pre = document.createElement('pre');
        if (cellType === 'markdown') pre.className = 'md-source';
        const language = cell ? cell.language : (inputCard.dataset.language || 'python');
        setPreHighlighted(pre, code, language, cellType === 'markdown');
        if (textarea) textarea.replaceWith(pre);

        // Update label
        const label = inputCard.querySelector('.prompt-icon');
        if (label) label.textContent = `${cellType === 'markdown' ? 'Md' : 'In'} [${cellId}]`;

        if (shouldRun && code) {
            reRunCell(cellId, code);
        }
    }

    // ---- Delete cell ----

    function deleteCell(cellId) {
        const idx = window._cells.findIndex(c => c.id === cellId);
        if (idx === -1) return;
        const cell = window._cells[idx];
        if (cell.inputCard) cell.inputCard.remove();
        if (cell.outputCard) cell.outputCard.remove();
        window._cells.splice(idx, 1);
        saveCellsToSession();
    }

    // ---- Move cell up/down ----

    function moveCellUp(cellId) {
        const idx = window._cells.findIndex(c => c.id === cellId);
        if (idx <= 0) return;
        const prevCell = window._cells[idx - 1];
        _moveCellDOM(cellId, prevCell.id, true);
    }

    function moveCellDown(cellId) {
        const idx = window._cells.findIndex(c => c.id === cellId);
        if (idx === -1 || idx >= window._cells.length - 1) return;
        const nextCell = window._cells[idx + 1];
        _moveCellDOM(cellId, nextCell.id, false);
    }

    // ---- Drag-and-drop cell reordering ----

    let _dragCellId = null;

    function _clearDragIndicators() {
        document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
            el.classList.remove('drag-over-top', 'drag-over-bottom');
        });
    }

    function _getDropTarget(e) {
        // Find the closest .card-input that is not the one being dragged
        const target = e.target.closest('.card-input');
        if (!target || target.classList.contains('dragging')) return null;
        return target;
    }

    // Attach drag events to the REPL container via delegation
    function _initDragDrop(container) {
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            _clearDragIndicators();
            const target = _getDropTarget(e);
            if (!target) return;
            const rect = target.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (e.clientY < midY) {
                target.classList.add('drag-over-top');
            } else {
                target.classList.add('drag-over-bottom');
            }
        });

        container.addEventListener('dragleave', (e) => {
            const target = e.target.closest('.card-input');
            if (target) {
                target.classList.remove('drag-over-top', 'drag-over-bottom');
            }
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            _clearDragIndicators();
            const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const target = _getDropTarget(e);
            if (!target || isNaN(draggedId)) return;

            const targetId = parseInt(target.dataset.cellId, 10);
            if (draggedId === targetId) return;

            const rect = target.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertBefore = e.clientY < midY;

            _moveCellDOM(draggedId, targetId, insertBefore);
        });
    }

    function _moveCellDOM(draggedId, targetId, insertBefore) {
        const cells = window._cells;
        const fromIdx = cells.findIndex(c => c.id === draggedId);
        const toIdx = cells.findIndex(c => c.id === targetId);
        if (fromIdx === -1 || toIdx === -1) return;

        // Remove from array
        const [cell] = cells.splice(fromIdx, 1);

        // Calculate new index (adjusted after removal)
        let newIdx = cells.findIndex(c => c.id === targetId);
        if (!insertBefore) newIdx++;
        cells.splice(newIdx, 0, cell);

        // Reorder DOM elements
        const repl = getRepl();
        const targetCell = cells.find(c => c.id === targetId);
        if (insertBefore) {
            repl.insertBefore(cell.inputCard, targetCell.inputCard);
        } else {
            // Insert after target's output card (or input card if no output)
            const afterEl = targetCell.outputCard || targetCell.inputCard;
            repl.insertBefore(cell.inputCard, afterEl.nextSibling);
        }
        // Move output card right after its input card
        if (cell.outputCard) {
            repl.insertBefore(cell.outputCard, cell.inputCard.nextSibling);
        }

        saveCellsToSession();
    }

    // Initialize drag-drop on the REPL wrapper (catches all notebook containers)
    _initDragDrop(document.getElementById('repl-wrapper') || document.getElementById('repl'));

    // ---- Execute code via kernel manager ----

    /**
     * Execute code using the appropriate kernel.
     * Renders output (stdout, result, errors) to the current output card.
     */
    async function executeCode(code, language) {
        language = language || 'python';
        const km = window.kernelManager;

        if (!km) throw new Error('KernelManager not available');

        // Handle %pip install magic (Jupyter-compatible)
        const pipMatch = code.match(/^%pip\s+install\s+(.+)$/m);
        if (pipMatch && language === 'python') {
            const packages = pipMatch[1].trim().split(/\s+/);
            const pkgList = packages.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ');
            return executePythonLegacy(`await pip_install(${pkgList})`);
        }

        // Handle %install magic for R packages (webR WASM repo)
        const rInstallMatch = code.match(/^%install\s+(.+)$/m);
        if (rInstallMatch && language === 'r') {
            const packages = rInstallMatch[1].trim().split(/\s+/);
            const kernel = km._instances && km._instances['r'];
            if (kernel && kernel.installPackages) {
                const msg = await kernel.installPackages(packages);
                return { stdout: msg, result: null, error: null };
            }
        }

        // Handle %%language magic commands (e.g., %%bash, %%python, %%prolog)
        // Strips the magic line and routes to the specified kernel.
        const magicMatch = code.match(/^%%(\w+)\s*\n([\s\S]*)$/);
        if (magicMatch) {
            const magicLang = magicMatch[1].toLowerCase();
            let magicCode = magicMatch[2];
            if (km._registry && km._registry[magicLang]) {
                return executeCode(magicCode, magicLang);
            }
        }

        // For Python, use the legacy bridge approach for plot/table/latex rendering
        if (language === 'python') {
            return executePythonLegacy(code);
        }

        // For other languages, use the kernel manager's standard execute
        const result = await km.execute(code, language);

        // Render stdout
        if (result.stdout && result.stdout.length > 0) {
            window.renderText(result.stdout, false);
        }

        // Render error
        if (result.error) {
            window.renderText(result.error, true);
        }

        // Render plot images (e.g. from R kernel)
        if (result.images && result.images.length > 0) {
            const container = window._currentOutputCard;
            if (container) {
                const body = container.querySelector('.card-body');
                for (const imgUrl of result.images) {
                    const img = document.createElement('img');
                    img.src = imgUrl;
                    img.style.maxWidth = '100%';
                    img.style.borderRadius = '6px';
                    img.style.marginTop = '8px';
                    body.appendChild(img);
                }
            }
        }

        // Render formatted result
        if (result.result) {
            if (result.result.type === 'latex') {
                window.renderLatex(result.result.content);
            } else if (result.result.type === 'text') {
                window.renderText(result.result.content, false);
            }
        }
    }

    /**
     * Execute Python code using the legacy Pyodide approach.
     * This preserves the existing bridge functions (renderPlot, etc.)
     * that Python calls directly via the js module.
     */
    async function executePythonLegacy(code) {
        const km = window.kernelManager;
        const kernel = km.getKernel('python');
        const pyodide = kernel.getPyodide();

        if (!pyodide) throw new Error('Python kernel not ready');

        // Redirect stdout
        pyodide.runPython(`
import io, sys
_sci_repl_stdout = io.StringIO()
_sci_repl_old_stdout = sys.stdout
sys.stdout = _sci_repl_stdout
`);

        let result = await pyodide.runPythonAsync(code);

        // Auto-setup matplotlib hook if matplotlib was imported
        try {
            pyodide.runPython(`
if 'matplotlib' in sys.modules and not getattr(sys.modules.get('matplotlib'), '_scirepl_hooked', False):
    _setup_matplotlib_hook()
    sys.modules['matplotlib']._scirepl_hooked = True
`);
        } catch(e) { /* matplotlib not imported or hook failed, ignore */ }

        pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`);
        const printed = pyodide.runPython(`_sci_repl_stdout.getvalue()`);

        if (printed && printed.length > 0) {
            window.renderText(printed, false);
        }

        const suppressOutput = code.trimEnd().endsWith(';');

        if (result !== undefined && result !== null && !suppressOutput) {
            pyodide.globals.set('_last_result', result);

            const isSympyList = pyodide.runPython(`_is_sympy_list(_last_result)`);
            if (isSympyList) {
                const tex = pyodide.runPython(`_sympy_list_to_latex(_last_result)`);
                window.renderLatex(tex);
            } else {
                const isSympy = pyodide.runPython(`_is_sympy(_last_result)`);
                if (isSympy) {
                    const tex = pyodide.runPython(`_sympy_to_latex(_last_result)`);
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

    // ---- Re-run a cell ----

    async function reRunCell(cellId, code) {
        const cell = window._cells.find(c => c.id === cellId);
        if (!cell) return;

        cell.code = code;

        const pre = cell.inputCard.querySelector('pre');
        if (pre) setPreHighlighted(pre, code, cell.language || 'python', cell.type === 'markdown');

        if (cell.type === 'markdown') {
            reRenderMarkdownCell(cell);
            saveCellsToSession();
            return;
        }

        // Code cell — needs a kernel
        const language = cell.language || 'python';
        const km = window.kernelManager;

        if (!km || !km.isReady(language)) {
            // Try to init the kernel on demand
            try {
                badge.textContent = 'loading ' + language + '…';
                badge.className = 'running';
                await km.ensureReady(language);
            } catch (err) {
                window.renderText('Failed to load ' + language + ': ' + err.message, true);
                badge.textContent = 'ready';
                badge.className = 'ready';
                return;
            }
        }

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
            await executeCode(code, language);

            const body = outputCard.querySelector('.card-body');
            if (body && body.children.length === 0) {
                outputCard.remove();
                cell.outputCard = null;
            }
        } catch (err) {
            if (language === 'python') {
                const kernel = km.getKernel('python');
                const pyodide = kernel.getPyodide();
                if (pyodide) {
                    try { pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`); } catch (_) { }
                }
            }
            window.renderText(err.message, true);
        }

        window._currentOutputCard = null;
        badge.textContent = 'ready';
        badge.className = 'ready';
        runBtn.disabled = false;
        saveCellsToSession();
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

        const pre = cell.inputCard.querySelector('pre');
        if (pre) pre.style.display = 'none';
    }

    // ---- Run cell and all below ----

    async function runCellAndBelow(cellId, code) {
        const idx = window._cells.findIndex(c => c.id === cellId);
        if (idx === -1) return;

        window._cells[idx].code = code;
        const pre = window._cells[idx].inputCard.querySelector('pre');
        if (pre) setPreHighlighted(pre, code, window._cells[idx].language || 'python', window._cells[idx].type === 'markdown');

        for (let i = idx; i < window._cells.length; i++) {
            await reRunCell(window._cells[i].id, window._cells[i].code);
        }
    }

    window.runAllCells = async function () {
        for (let i = 0; i < window._cells.length; i++) {
            await reRunCell(window._cells[i].id, window._cells[i].code);
        }
    };

    // Expose cell operations for testing and external use
    window.deleteCell = deleteCell;
    window.moveCellUp = moveCellUp;
    window.moveCellDown = moveCellDown;

    // ---- Restore session ----

    async function restoreSession() {
        if (!window.sessionManager) return;

        // Restore SharedVFS before any cells execute (so bash/prolog can access shared files)
        window.sessionManager.restoreSharedState();

        // Restore multi-notebook state (tabs) if available
        if (window.notebookManager && window.notebookManager.hasStoredState()) {
            const activeCells = window.notebookManager.restoreState();
            if (activeCells && activeCells.length > 0) {
                // restoreState populates window._cells and renders the tab bar.
                // Now re-render the active notebook's cells as cards.
                badge.textContent = 'restoring…';
                badge.className = 'running';
                let prologStateRestored = false;

                // Clear any DOM cells from the default init, then populate from restored state
                const repl = getRepl();
                const existingCards = repl.querySelectorAll('.cell-card');
                existingCards.forEach(c => c.remove());

                const cellDefs = activeCells.map(c => ({
                    code: c.code, type: c.type, language: c.language || 'python'
                }));
                window._cells.length = 0;
                window._cellCounter = 0;

                for (const saved of cellDefs) {
                    window._cellCounter++;
                    const cellId = window._cellCounter;
                    const language = saved.language || 'python';

                    const inputCard = createInputCard(saved.code, cellId, saved.type, language);
                    const outputCard = createOutputCard(cellId, saved.type);

                    const cell = {
                        id: cellId,
                        code: saved.code,
                        type: saved.type,
                        language: language,
                        inputCard: inputCard,
                        outputCard: outputCard
                    };
                    window._cells.push(cell);

                    if (saved.type === 'markdown') {
                        const body = outputCard.querySelector('.card-body');
                        body.innerHTML = renderMarkdown(saved.code);
                        const pre = inputCard.querySelector('pre');
                        if (pre) pre.style.display = 'none';
                    }
                }

                // Update the active notebook's state
                const active = window.notebookManager.getActiveNotebook();
                if (active) {
                    active.cells = window._cells;
                    active.cellCounter = window._cellCounter;
                }

                // Restore Prolog VFS files from IndexedDB so modules are available
                // when the user runs cells (without needing to re-import the package)
                const hasPrologCells = cellDefs.some(c => c.language === 'prolog');
                if (hasPrologCells) {
                    const km = window.kernelManager;
                    if (km) {
                        try {
                            await km.ensureReady('prolog');
                            await window.sessionManager.restorePrologState();
                        } catch (e) {
                            console.warn('Failed to restore Prolog VFS on notebook restore:', e);
                        }
                    }
                }

                badge.textContent = 'ready';
                badge.className = 'ready';
                getRepl().scrollTop = getRepl().scrollHeight;
                return;
            }
        }

        const savedCells = window.sessionManager.getSavedCells();
        if (savedCells.length === 0) return;

        badge.textContent = 'restoring…';
        badge.className = 'running';
        let prologStateRestored = false;

        for (const saved of savedCells) {
            window._cellCounter++;
            const cellId = window._cellCounter;
            const language = saved.language || 'python';

            const inputCard = createInputCard(saved.code, cellId, saved.type, language);
            const outputCard = createOutputCard(cellId, saved.type);

            const cell = {
                id: cellId,
                code: saved.code,
                type: saved.type,
                language: language,
                inputCard: inputCard,
                outputCard: outputCard
            };
            window._cells.push(cell);

            if (saved.type === 'markdown') {
                const body = outputCard.querySelector('.card-body');
                body.innerHTML = renderMarkdown(saved.code);
                const pre = inputCard.querySelector('pre');
                if (pre) pre.style.display = 'none';
            } else {
                // Ensure the kernel for this language is ready
                const km = window.kernelManager;
                if (km) {
                    try {
                        await km.ensureReady(language);
                        // Restore Prolog VFS state on first Prolog cell
                        if (language === 'prolog' && !prologStateRestored) {
                            prologStateRestored = true;
                            await window.sessionManager.restorePrologState();
                        }
                    } catch (err) {
                        window._currentOutputCard = outputCard;
                        window.renderText('Failed to load ' + language + ': ' + err.message, true);
                        window._currentOutputCard = null;
                        continue;
                    }
                }

                window._currentOutputCard = outputCard;
                try {
                    await executeCode(saved.code, language);
                    const body = outputCard.querySelector('.card-body');
                    if (body && body.children.length === 0) {
                        outputCard.remove();
                        cell.outputCard = null;
                    }
                } catch (err) {
                    if (language === 'python') {
                        const kernel = km.getKernel('python');
                        const pyodide = kernel.getPyodide();
                        if (pyodide) {
                            try { pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`); } catch (_) { }
                        }
                    }
                    window.renderText(err.message, true);
                }
                window._currentOutputCard = null;
            }
        }

        // Update session manager cell counter
        window.sessionManager.session.cellCounter = window._cellCounter;
        window.sessionManager.save();

        badge.textContent = 'ready';
        badge.className = 'ready';
        getRepl().scrollTop = getRepl().scrollHeight;
    }

    // ---- Auto-save: beforeunload + periodic timer ----

    window.addEventListener('beforeunload', () => {
        if (window._clearingSession) return; // Skip save during Clear History
        // Save main input draft
        try {
            if (input && input.value.trim()) {
                sessionStorage.setItem('scirepl_draft_input', input.value);
            } else {
                sessionStorage.removeItem('scirepl_draft_input');
            }
        } catch (e) { /* sessionStorage unavailable */ }

        // Commit any in-progress cell edit
        const editor = document.querySelector('.cell-editor');
        if (editor) {
            const card = editor.closest('.card-input');
            const cellId = card ? parseInt(card.dataset.cellId) : -1;
            const cell = (window._cells || []).find(c => c.id === cellId);
            if (cell) cell.code = editor.value.trim();
        }

        saveCellsToSession();
    });

    // Periodic auto-save every 30 seconds (commits in-progress cell edits)
    setInterval(() => {
        const editor = document.querySelector('.cell-editor');
        if (editor) {
            const card = editor.closest('.card-input');
            const cellId = card ? parseInt(card.dataset.cellId) : -1;
            const cell = (window._cells || []).find(c => c.id === cellId);
            if (cell && editor.value.trim() !== cell.code) {
                cell.code = editor.value.trim();
                saveCellsToSession();
            }
        }
    }, 30000);

    // ---- Save cells to session ----

    function saveCellsToSession() {
        if (window.sessionManager) {
            window.sessionManager.session.cellCounter = window._cellCounter;
            window.sessionManager.saveCells(window._cells);
            // Also save Prolog VFS state if kernel is active
            window.sessionManager.savePrologState();
            // Save SharedVFS state for cross-kernel file persistence
            window.sessionManager.saveSharedState();
        }
        // Also save multi-notebook state if applicable
        if (window.notebookManager && window.notebookManager.hasMultipleNotebooks()) {
            window.notebookManager.saveState();
        }
    }

    // ---- Render Jupyter outputs from .ipynb import ----

    /**
     * Render pre-existing Jupyter outputs into an output card using bridge.js
     * rendering functions. This allows imported .ipynb notebooks to display
     * their outputs without re-executing the code.
     */
    window.renderJupyterOutputs = function (outputs, outputCard) {
        window._currentOutputCard = outputCard;
        try {
            for (const out of outputs) {
                const otype = out.output_type;
                if (otype === 'stream') {
                    const text = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
                    window.renderText(text, out.name === 'stderr');
                } else if (otype === 'error') {
                    const tb = Array.isArray(out.traceback) ? out.traceback.join('\n') : (out.evalue || 'Error');
                    window.renderText(tb, true);
                } else if (otype === 'execute_result' || otype === 'display_data') {
                    const data = out.data || {};
                    if (data['text/latex']) {
                        // Extract TeX — may be wrapped in $\displaystyle ...$
                        let tex = Array.isArray(data['text/latex']) ? data['text/latex'].join('') : data['text/latex'];
                        tex = tex.replace(/^\$\\displaystyle\s*/, '').replace(/\$$/, '');
                        window.renderLatex(tex);
                    } else if (data['image/png']) {
                        const base64 = Array.isArray(data['image/png']) ? data['image/png'].join('') : data['image/png'];
                        window.renderImage('data:image/png;base64,' + base64);
                    } else if (data['image/svg+xml']) {
                        const svg = Array.isArray(data['image/svg+xml']) ? data['image/svg+xml'].join('') : data['image/svg+xml'];
                        const body = outputCard.querySelector('.card-body');
                        if (body) {
                            const div = document.createElement('div');
                            div.innerHTML = svg;
                            body.appendChild(div);
                        }
                    } else if (data['text/html']) {
                        const html = Array.isArray(data['text/html']) ? data['text/html'].join('') : data['text/html'];
                        const body = outputCard.querySelector('.card-body');
                        if (body) {
                            const div = document.createElement('div');
                            div.innerHTML = html;
                            body.appendChild(div);
                        }
                    } else if (data['text/plain']) {
                        const text = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain'];
                        window.renderText(text, false);
                    }
                }
            }
        } finally {
            window._currentOutputCard = null;
        }
    };

    // ---- Import cells from .ipynb ----

    window.importCells = async function (cellDefs) {
        const km = window.kernelManager;
        if (!km) return;

        badge.textContent = 'importing…';
        badge.className = 'running';
        runBtn.disabled = true;

        for (const def of cellDefs) {
            window._cellCounter++;
            const cellId = window._cellCounter;
            const language = def.language || 'python';

            const inputCard = createInputCard(def.code, cellId, def.type, language);
            const outputCard = createOutputCard(cellId, def.type);

            const cell = {
                id: cellId,
                code: def.code,
                type: def.type,
                language: language,
                inputCard: inputCard,
                outputCard: outputCard
            };
            window._cells.push(cell);

            if (def.type === 'markdown') {
                const body = outputCard.querySelector('.card-body');
                body.innerHTML = renderMarkdown(def.code);
                const pre = inputCard.querySelector('pre');
                if (pre) pre.style.display = 'none';
            } else if (def.outputs && def.outputs.length > 0) {
                // Render pre-existing Jupyter outputs without re-executing
                window.renderJupyterOutputs(def.outputs, outputCard);
            } else {
                // No cached outputs — execute as before
                try {
                    await km.ensureReady(language);
                } catch (err) {
                    window._currentOutputCard = outputCard;
                    window.renderText('Failed to load ' + language + ': ' + err.message, true);
                    window._currentOutputCard = null;
                    continue;
                }

                window._currentOutputCard = outputCard;
                try {
                    await executeCode(def.code, language);
                    const body = outputCard.querySelector('.card-body');
                    if (body && body.children.length === 0) {
                        outputCard.remove();
                        cell.outputCard = null;
                    }
                } catch (err) {
                    if (language === 'python') {
                        const kernel = km.getKernel('python');
                        const pyodide = kernel.getPyodide();
                        if (pyodide) {
                            try { pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`); } catch (_) { }
                        }
                    }
                    window.renderText(err.message, true);
                }
                window._currentOutputCard = null;
            }
        }

        saveCellsToSession();
        badge.textContent = 'ready';
        badge.className = 'ready';
        runBtn.disabled = false;
        getRepl().scrollTop = getRepl().scrollHeight;
    };

    // ---- Run from input bar (new cell) ----

    async function runCode() {
        const code = input.value.trim();
        if (!code) return;

        const language = getCurrentLanguage();
        const km = window.kernelManager;

        // Markdown cells don't need a kernel
        if (currentCellType === 'code') {
            if (!km || !km.isReady(language)) {
                // Try to init on demand
                try {
                    runBtn.disabled = true;
                    badge.textContent = 'loading ' + language + '…';
                    badge.className = 'running';
                    await km.ensureReady(language);
                } catch (err) {
                    badge.textContent = 'error';
                    badge.className = 'error';
                    alert('Failed to load ' + language + ': ' + err.message);
                    runBtn.disabled = false;
                    badge.textContent = 'ready';
                    badge.className = 'ready';
                    return;
                }
            }
        }

        runBtn.disabled = true;
        window._cellCounter++;
        const cellId = window._cellCounter;

        const inputCard = createInputCard(code, cellId, currentCellType, language);
        const outputCard = createOutputCard(cellId, currentCellType);

        const cell = {
            id: cellId,
            code: code,
            type: currentCellType,
            language: language,
            inputCard: inputCard,
            outputCard: outputCard
        };
        window._cells.push(cell);

        if (currentCellType === 'markdown') {
            const body = outputCard.querySelector('.card-body');
            body.innerHTML = renderMarkdown(code);

            const pre = inputCard.querySelector('pre');
            if (pre) pre.style.display = 'none';

            saveCellsToSession();
        } else {
            badge.textContent = 'running…';
            badge.className = 'running';
            window._currentOutputCard = outputCard;

            try {
                await executeCode(code, language);

                if (window.sessionManager) {
                    window.sessionManager.addToHistory(code);
                    window.sessionManager.session.historyIndex = -1;
                }
                saveCellsToSession();

                const body = outputCard.querySelector('.card-body');
                if (body && body.children.length === 0) {
                    outputCard.remove();
                    cell.outputCard = null;
                }
            } catch (err) {
                if (language === 'python') {
                    const kernel = km.getKernel('python');
                    const pyodide = kernel.getPyodide();
                    if (pyodide) {
                        try { pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`); } catch (_) { }
                    }
                }
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
        getRepl().scrollTop = getRepl().scrollHeight;
        input.focus();
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

    // ---- Search within notebook (Ctrl+F) ----

    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');
    const searchPrevBtn = document.getElementById('search-prev-btn');
    const searchNextBtn = document.getElementById('search-next-btn');
    const searchCloseBtn = document.getElementById('search-close-btn');
    const searchReplaceToggle = document.getElementById('search-replace-toggle');
    const searchReplaceRow = document.getElementById('search-replace-row');
    const replaceInput = document.getElementById('replace-input');
    const replaceOneBtn = document.getElementById('replace-one-btn');
    const replaceAllBtn = document.getElementById('replace-all-btn');

    let _searchMatches = [];  // [{ cellIndex, cell, positions: [startIdx, ...] }, ...]
    let _searchFlatMatches = [];  // [{ cellIndex, cell, posIndex }, ...]
    let _searchCurrentIdx = -1;

    function openSearch() {
        searchBar.classList.remove('hidden');
        searchInput.focus();
        searchInput.select();
        runSearch();
    }

    function closeSearch() {
        searchBar.classList.add('hidden');
        searchReplaceRow.classList.add('hidden');
        clearSearchHighlights();
        _searchMatches = [];
        _searchFlatMatches = [];
        _searchCurrentIdx = -1;
        searchCount.textContent = '';
    }

    function runSearch() {
        clearSearchHighlights();
        const query = searchInput.value;
        _searchMatches = [];
        _searchFlatMatches = [];
        _searchCurrentIdx = -1;

        if (!query) {
            searchCount.textContent = '';
            return;
        }

        const queryLower = query.toLowerCase();
        const cells = window._cells || [];

        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const codeLower = cell.code.toLowerCase();
            const positions = [];
            let idx = 0;
            while ((idx = codeLower.indexOf(queryLower, idx)) !== -1) {
                positions.push(idx);
                idx += queryLower.length;
            }
            if (positions.length > 0) {
                _searchMatches.push({ cellIndex: i, cell, positions });
                cell.inputCard.classList.add('search-match');
                for (let p = 0; p < positions.length; p++) {
                    _searchFlatMatches.push({ cellIndex: i, cell, posIndex: p, startIdx: positions[p] });
                }
            }
        }

        if (_searchFlatMatches.length > 0) {
            _searchCurrentIdx = 0;
            goToCurrentMatch();
        }
        updateSearchCount();
    }

    function updateSearchCount() {
        if (_searchFlatMatches.length === 0) {
            searchCount.textContent = searchInput.value ? '0 results' : '';
        } else {
            searchCount.textContent = `${_searchCurrentIdx + 1}/${_searchFlatMatches.length}`;
        }
    }

    function goToCurrentMatch() {
        // Remove previous current highlight
        document.querySelectorAll('.search-current').forEach(el => el.classList.remove('search-current'));
        removeTextHighlights();

        if (_searchCurrentIdx < 0 || _searchCurrentIdx >= _searchFlatMatches.length) return;

        const match = _searchFlatMatches[_searchCurrentIdx];
        match.cell.inputCard.classList.add('search-current');
        match.cell.inputCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Apply text-level highlights in the current cell's <pre><code> or <pre>
        applyTextHighlights(match.cell, searchInput.value, match.startIdx);
        updateSearchCount();
    }

    function applyTextHighlights(cell, query, currentStartIdx) {
        const pre = cell.inputCard.querySelector('pre');
        if (!pre) return;

        const codeEl = pre.querySelector('code') || pre;
        const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        const queryLower = query.toLowerCase();
        let globalOffset = 0;

        for (const textNode of textNodes) {
            const text = textNode.textContent;
            const textLower = text.toLowerCase();
            const parts = [];
            let lastIdx = 0;
            let searchIdx = 0;

            while ((searchIdx = textLower.indexOf(queryLower, searchIdx)) !== -1) {
                if (searchIdx > lastIdx) {
                    parts.push({ text: text.slice(lastIdx, searchIdx), highlight: false });
                }
                const isCurrent = (globalOffset + searchIdx) === currentStartIdx;
                parts.push({
                    text: text.slice(searchIdx, searchIdx + query.length),
                    highlight: true,
                    isCurrent
                });
                lastIdx = searchIdx + query.length;
                searchIdx = lastIdx;
            }

            if (parts.length > 0) {
                if (lastIdx < text.length) {
                    parts.push({ text: text.slice(lastIdx), highlight: false });
                }
                const frag = document.createDocumentFragment();
                for (const part of parts) {
                    if (part.highlight) {
                        const mark = document.createElement('mark');
                        mark.className = part.isCurrent ? 'search-hl search-hl-current' : 'search-hl';
                        mark.textContent = part.text;
                        frag.appendChild(mark);
                    } else {
                        frag.appendChild(document.createTextNode(part.text));
                    }
                }
                textNode.replaceWith(frag);
            }

            globalOffset += text.length;
        }
    }

    function removeTextHighlights() {
        document.querySelectorAll('.card-input mark.search-hl').forEach(mark => {
            const parent = mark.parentNode;
            mark.replaceWith(document.createTextNode(mark.textContent));
            if (parent) parent.normalize();
        });
    }

    function clearSearchHighlights() {
        removeTextHighlights();
        document.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));
        document.querySelectorAll('.search-current').forEach(el => el.classList.remove('search-current'));
    }

    function searchNext() {
        if (_searchFlatMatches.length === 0) return;
        _searchCurrentIdx = (_searchCurrentIdx + 1) % _searchFlatMatches.length;
        goToCurrentMatch();
    }

    function searchPrev() {
        if (_searchFlatMatches.length === 0) return;
        _searchCurrentIdx = (_searchCurrentIdx - 1 + _searchFlatMatches.length) % _searchFlatMatches.length;
        goToCurrentMatch();
    }

    function replaceCurrentMatch() {
        if (_searchCurrentIdx < 0 || _searchCurrentIdx >= _searchFlatMatches.length) return;

        const match = _searchFlatMatches[_searchCurrentIdx];
        const query = searchInput.value;
        const replacement = replaceInput.value;
        if (!query) return;

        // Replace in cell.code (case-preserving position)
        const cell = match.cell;
        cell.code = cell.code.slice(0, match.startIdx) + replacement + cell.code.slice(match.startIdx + query.length);

        // Re-render the card's code
        const pre = cell.inputCard.querySelector('pre');
        if (pre) setPreHighlighted(pre, cell.code, cell.language || 'python', cell.type === 'markdown');

        saveCellsToSession();
        runSearch();
    }

    function replaceAllMatches() {
        const query = searchInput.value;
        const replacement = replaceInput.value;
        if (!query) return;

        const affectedCells = new Set();
        // Replace from end to start to preserve indices
        for (let i = _searchFlatMatches.length - 1; i >= 0; i--) {
            const match = _searchFlatMatches[i];
            match.cell.code = match.cell.code.slice(0, match.startIdx) + replacement + match.cell.code.slice(match.startIdx + query.length);
            affectedCells.add(match.cell);
        }

        for (const cell of affectedCells) {
            const pre = cell.inputCard.querySelector('pre');
            if (pre) setPreHighlighted(pre, cell.code, cell.language || 'python', cell.type === 'markdown');
        }

        saveCellsToSession();
        runSearch();
    }

    // Wire search bar events
    if (searchInput) {
        searchInput.addEventListener('input', () => runSearch());
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); searchPrev(); }
            else if (e.key === 'Enter') { e.preventDefault(); searchNext(); }
            else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
        });
    }
    if (replaceInput) {
        replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
        });
    }
    if (searchNextBtn) searchNextBtn.addEventListener('click', searchNext);
    if (searchPrevBtn) searchPrevBtn.addEventListener('click', searchPrev);
    if (searchCloseBtn) searchCloseBtn.addEventListener('click', closeSearch);
    if (searchReplaceToggle) {
        searchReplaceToggle.addEventListener('click', () => {
            searchReplaceRow.classList.toggle('hidden');
            if (!searchReplaceRow.classList.contains('hidden')) replaceInput.focus();
        });
    }
    if (replaceOneBtn) replaceOneBtn.addEventListener('click', replaceCurrentMatch);
    if (replaceAllBtn) replaceAllBtn.addEventListener('click', replaceAllMatches);

    // Mobile search button in header
    const searchHeaderBtn = document.getElementById('search-btn');
    if (searchHeaderBtn) searchHeaderBtn.addEventListener('click', openSearch);

    // Global keyboard handler: Ctrl+F to open search, Escape to close
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            openSearch();
        } else if (e.key === 'Escape' && !searchBar.classList.contains('hidden')) {
            e.preventDefault();
            closeSearch();
        }
    });

    // ---- Expose internal functions for NotebookManager / PackageLoader ----
    window._appInternals = {
        createInputCard: createInputCard,
        createOutputCard: createOutputCard,
        executeCode: executeCode,
        renderMarkdown: renderMarkdown,
        saveCellsToSession: saveCellsToSession,
        getRepl: getRepl,
        getCurrentLanguage: getCurrentLanguage,
        escapeHtml: escapeHtml,
        highlightCode: highlightCode,
        setPreHighlighted: setPreHighlighted
    };

    // ---- Start ----
    // Pyodide is loaded dynamically after privacy acceptance.
    // window._startApp is called by the privacy script in index.html
    // once the Pyodide <script> has loaded.
    window._startApp = function () {
        // Initialize notebook manager
        if (window.notebookManager) {
            window.notebookManager.init();
        }
        initDefaultKernel();
    };

    // If Pyodide was already loaded (returning user, script loaded before app.js),
    // start immediately.
    if (typeof loadPyodide !== 'undefined') {
        if (window.notebookManager) {
            window.notebookManager.init();
        }
        initDefaultKernel();
    }

})();
