/**
 * notebook_manager.js — Manages multiple notebooks in SciREPL.
 * Each notebook has its own cell array, cell counter, and REPL container.
 * The active notebook's cells are bridged to window._cells for backward
 * compatibility with app.js.
 */

class Notebook {
    constructor(opts) {
        opts = opts || {};
        this.id = opts.id || ('nb-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6));
        this.name = opts.name || 'Notebook 1';
        this.description = opts.description || '';
        this.kernelLanguage = opts.kernelLanguage || null; // null = infer from cells
        this.catalogId = opts.catalogId || null;
        this.catalogRevision = opts.catalogRevision ?? null;
        this.cells = opts.cells || [];
        this.cellCounter = opts.cellCounter || 0;
        this.replContainer = null; // DOM element
        this.isActive = false;
    }

    /**
     * Create a detached REPL container for this notebook.
     */
    createContainer() {
        const el = document.createElement('main');
        el.id = 'repl-' + this.id;
        el.className = 'repl-container';
        el.style.display = 'none';
        return el;
    }

    /**
     * Serialize for persistence (strips DOM refs).
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            kernelLanguage: this.kernelLanguage,
            catalogId: this.catalogId,
            catalogRevision: this.catalogRevision,
            cellCounter: this.cellCounter,
            cells: this.cells.map(c => ({
                code: c.code,
                type: c.type,
                language: c.language || 'python',
                name: c.name || '',
                lastOutput: c.lastOutput || '',
                lastOutputHtml: c.lastOutputHtml || ''
            }))
        };
    }

    static fromJSON(data) {
        return new Notebook({
            id: data.id,
            name: data.name,
            description: data.description,
            kernelLanguage: data.kernelLanguage,
            catalogId: data.catalogId,
            catalogRevision: data.catalogRevision,
            cellCounter: data.cellCounter,
            cells: data.cells || []
        });
    }
}

class NotebookManager {
    constructor() {
        this._notebooks = [];
        this._activeIndex = -1;
        this._uiMode = 'auto'; // 'auto' | 'dropdown' | 'sidebar' | 'tabs'
        this._initialized = false;
    }

    /**
     * Initialize the notebook manager.
     * Wraps existing window._cells into a default notebook if no saved state.
     */
    init() {
        if (this._initialized) return;
        this._initialized = true;

        // Check for saved multi-notebook state
        if (window.sessionManager) {
            const saved = window.sessionManager.getSavedNotebooks();
            if (saved && saved.length > 0) {
                this._uiMode = window.sessionManager.session.notebookUIMode || 'auto';
                // Notebooks will be restored by restoreState() called from app.js
                return;
            }
        }

        // No saved notebooks — create a default wrapping current state
        const defaultNb = new Notebook({
            id: 'default',
            name: 'Notebook 1',
            cells: [],
            cellCounter: window._cellCounter || 0
        });
        this._notebooks.push(defaultNb);
        this._activeIndex = 0;
        defaultNb.isActive = true;

        // Bind to existing REPL element
        const existingRepl = document.getElementById('repl');
        if (existingRepl) {
            defaultNb.replContainer = existingRepl;
        }
    }

    // ---- Notebook lifecycle ----

    createNotebook(opts) {
        opts = opts || {};
        const nb = new Notebook(opts);
        this._notebooks.push(nb);

        // Create DOM container
        const wrapper = document.getElementById('repl-wrapper');
        if (wrapper) {
            nb.replContainer = nb.createContainer();
            wrapper.appendChild(nb.replContainer);
        }

        this.renderSelector();
        return nb;
    }

    removeNotebook(id) {
        const idx = this._notebooks.findIndex(n => n.id === id);
        if (idx === -1) return;

        // Don't remove the last notebook
        if (this._notebooks.length <= 1) return;

        const nb = this._notebooks[idx];

        // If removing active, switch to another first
        if (idx === this._activeIndex) {
            const newIdx = idx > 0 ? idx - 1 : 1;
            this.switchTo(this._notebooks[newIdx].id);
        }

        // Remove DOM container
        if (nb.replContainer && nb.replContainer.parentNode) {
            nb.replContainer.parentNode.removeChild(nb.replContainer);
        }

        this._notebooks.splice(idx, 1);

        // Adjust active index
        this._activeIndex = this._notebooks.findIndex(n => n.isActive);

        this.renderSelector();
        this.saveState();
    }

    renameNotebook(id, newName) {
        const nb = this._notebooks.find(n => n.id === id);
        if (!nb || !newName || !newName.trim()) return;
        nb.name = newName.trim();
        this.renderSelector();
        this.saveState();
    }

    getNotebook(id) {
        return this._notebooks.find(n => n.id === id) || null;
    }

    getNotebooks() {
        return this._notebooks;
    }

    getActiveNotebook() {
        if (this._activeIndex >= 0 && this._activeIndex < this._notebooks.length) {
            return this._notebooks[this._activeIndex];
        }
        return null;
    }

    /**
     * Check if there are multiple notebooks.
     */
    hasMultipleNotebooks() {
        return this._notebooks.length > 1;
    }

    // ---- Switching ----

    switchTo(id) {
        const target = this.getNotebook(id);
        if (!target) return;

        const current = this.getActiveNotebook();
        if (current && current.id === id) return; // Already active

        // Save current state
        if (current) {
            current.cells = window._cells ? [...window._cells] : [];
            current.cellCounter = window._cellCounter || 0;
            current.isActive = false;
            if (current.replContainer) {
                current.replContainer.style.display = 'none';
            }
        }

        // Activate target
        const targetIdx = this._notebooks.indexOf(target);
        this._activeIndex = targetIdx;
        target.isActive = true;

        // Ensure container exists
        if (!target.replContainer) {
            const wrapper = document.getElementById('repl-wrapper');
            if (wrapper) {
                target.replContainer = target.createContainer();
                wrapper.appendChild(target.replContainer);
            }
        }
        if (target.replContainer) {
            target.replContainer.style.display = '';
        }

        // Swap global state
        window._cells = target.cells;
        window._cellCounter = target.cellCounter;

        // Update language selector to notebook's default kernel
        if (target.kernelLanguage) {
            const langSel = document.getElementById('lang-selector');
            if (langSel) {
                langSel.value = target.kernelLanguage;
                langSel.dispatchEvent(new Event('change'));
            }
        }

        this.renderSelector();
        this.saveState();
    }

    // ---- Package integration ----

    /**
     * Load notebooks from a parsed manifest and file contents.
     * @param {Object} manifest — parsed scirepl.json
     * @param {Map<string, string>} fileMap — path → content from archive
     */
    async loadFromManifest(manifest, fileMap) {
        if (!manifest.notebooks || manifest.notebooks.length === 0) return;

        const createdNotebooks = [];

        for (const nbDef of manifest.notebooks) {
            const content = fileMap.get(nbDef.file);
            if (!content) {
                console.warn('Notebook file not found in package:', nbDef.file);
                continue;
            }

            try {
                const parsed = JSON.parse(content);

                // Handle .srwb files — delegate to fileIO.importSrwb
                // importSrwb fully renders the notebook (DOM cards, switching, saving),
                // so we do NOT add it to createdNotebooks — that would cause
                // _populateCells to re-process and destroy the already-rendered content.
                if (nbDef.type === 'srwb' || parsed.format === 'srwb') {
                    if (window.fileIO && window.fileIO.importSrwb) {
                        window.fileIO.importSrwb(content);
                    } else {
                        console.warn('fileIO.importSrwb not available for:', nbDef.file);
                    }
                    continue;
                }

                // Handle .ipynb files
                const nb = this.createNotebook({
                    name: nbDef.name || nbDef.file.replace('.ipynb', ''),
                    description: nbDef.description || '',
                    kernelLanguage: nbDef.kernel || null
                });

                const cells = this._extractCellsFromIpynb(parsed, nbDef.kernel);
                nb.cells = cells.map((c, i) => ({
                    ...c,
                    id: i + 1
                }));
                nb.cellCounter = cells.length;
                createdNotebooks.push(nb);
            } catch (e) {
                console.warn('Failed to parse notebook:', nbDef.file, e);
            }
        }

        // Switch to the first created notebook
        if (createdNotebooks.length > 0) {
            this.switchTo(createdNotebooks[0].id);
        }

        return createdNotebooks;
    }

    /**
     * Extract cells from a parsed .ipynb object.
     */
    _extractCellsFromIpynb(nb, defaultKernel) {
        const cells = [];

        // Detect notebook-level language
        let notebookLang = defaultKernel || 'python';
        if (nb.metadata && nb.metadata.kernelspec) {
            const ks = nb.metadata.kernelspec;
            if (ks.language === 'prolog' || ks.name === 'swipl') {
                notebookLang = 'prolog';
            }
        }
        if (nb.metadata && nb.metadata.language_info) {
            if (nb.metadata.language_info.name === 'prolog') {
                notebookLang = 'prolog';
            }
        }

        if (!nb.cells) return cells;

        for (const cell of nb.cells) {
            let source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            if (!source.trim()) continue;

            let cellLang = notebookLang;
            if (cell.metadata && cell.metadata.scirepl_language) {
                cellLang = cell.metadata.scirepl_language;
            }

            // Detect %%language magic at top of code cells
            if (cell.cell_type !== 'markdown') {
                const magicMatch = source.match(/^%%(\w+)\s*\n/);
                if (magicMatch) {
                    cellLang = magicMatch[1].toLowerCase();
                }
            }

            cells.push({
                code: source,
                type: cell.cell_type === 'markdown' ? 'markdown' : 'code',
                language: cellLang
            });
        }

        return cells;
    }

    // ---- Persistence ----

    saveState() {
        if (!window.sessionManager) return;
        const notebooks = this._notebooks.map(nb => {
            // For active notebook, grab live state
            if (nb.isActive) {
                nb.cells = window._cells ? [...window._cells] : [];
                nb.cellCounter = window._cellCounter || 0;
            }
            return nb.toJSON();
        });
        const activeId = this.getActiveNotebook() ? this.getActiveNotebook().id : null;
        window.sessionManager.saveNotebooks(notebooks, activeId);
        this._syncToSharedVFS(notebooks);
    }

    /**
     * Sync notebooks to SharedVFS as .srwb files under /shared/notebooks/.
     * Each notebook is written as a separate JSON file.
     */
    _syncToSharedVFS(notebooks) {
        const vfs = window.sharedVFS;
        if (!vfs) return;

        const dir = '/shared/notebooks';
        try { vfs.mkdirTree(dir); } catch (_) { }

        // Track which filenames we write so we can clean up stale ones
        const written = new Set();

        for (const nb of notebooks) {
            const safeName = (nb.name || 'notebook').replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
            const shortId = (nb.id || '').replace(/^nb-/, '').substring(0, 8);
            const filename = safeName + (shortId ? '_' + shortId : '') + '.srwb';
            const filepath = dir + '/' + filename;
            written.add(filename);

            const srwb = {
                format: 'srwb',
                format_version: '1.0',
                exported_at: new Date().toISOString(),
                notebook: nb
            };

            try {
                vfs.writeFile(filepath, JSON.stringify(srwb, null, 2), 'notebook-sync');
            } catch (e) {
                console.warn('[NotebookManager] Failed to sync', filepath, e);
            }
        }

        // Remove .srwb files that no longer correspond to any notebook
        try {
            const existing = vfs.listDir(dir);
            for (const name of existing) {
                if (name.endsWith('.srwb') && !written.has(name)) {
                    vfs.unlink(dir + '/' + name);
                }
            }
        } catch (_) { }
    }

    /**
     * Check if there's stored multi-notebook state.
     */
    hasStoredState() {
        if (!window.sessionManager) return false;
        const saved = window.sessionManager.getSavedNotebooks();
        return saved && saved.length > 0;
    }

    /**
     * Restore notebooks from persistence.
     * Returns the array of cell definitions for the active notebook (for app.js to render).
     */
    restoreState() {
        if (!window.sessionManager) return null;
        const savedNotebooks = window.sessionManager.getSavedNotebooks();
        const activeId = window.sessionManager.session.activeNotebookId;

        if (!savedNotebooks || savedNotebooks.length === 0) return null;

        this._notebooks = [];
        const wrapper = document.getElementById('repl-wrapper');
        const existingRepl = document.getElementById('repl');

        for (let i = 0; i < savedNotebooks.length; i++) {
            const nb = Notebook.fromJSON(savedNotebooks[i]);

            if (i === 0 && existingRepl) {
                // First notebook uses the existing REPL element
                nb.replContainer = existingRepl;
            } else if (wrapper) {
                nb.replContainer = nb.createContainer();
                wrapper.appendChild(nb.replContainer);
            }

            this._notebooks.push(nb);
        }

        // Activate the right notebook
        let targetIdx = this._notebooks.findIndex(n => n.id === activeId);
        if (targetIdx === -1) targetIdx = 0;

        // Hide all containers except the active one
        for (let i = 0; i < this._notebooks.length; i++) {
            this._notebooks[i].isActive = (i === targetIdx);
            if (this._notebooks[i].replContainer) {
                this._notebooks[i].replContainer.style.display = (i === targetIdx) ? '' : 'none';
            }
        }

        this._activeIndex = targetIdx;
        const active = this._notebooks[targetIdx];
        window._cells = active.cells;
        window._cellCounter = active.cellCounter;

        if (active.kernelLanguage) {
            const langSel = document.getElementById('lang-selector');
            if (langSel) {
                langSel.value = active.kernelLanguage;
                langSel.dispatchEvent(new Event('change'));
            }
        }

        this.renderSelector();

        // Return the active notebook's saved cells for app.js to render
        return active.cells;
    }

    // ---- UI ----

    setUIMode(mode) {
        this._uiMode = mode;
        if (window.sessionManager) {
            window.sessionManager.session.notebookUIMode = mode;
            window.sessionManager.save();
        }
        this.renderSelector();
    }

    getUIMode() {
        return this._uiMode;
    }

    getEffectiveMode() {
        if (this._uiMode !== 'auto') return this._uiMode;
        return window.innerWidth >= 768 ? 'sidebar' : 'dropdown';
    }

    /**
     * Render the appropriate notebook selector UI.
     */
    renderSelector() {
        const container = document.getElementById('notebook-selector-container');
        const sidebar = document.getElementById('notebook-sidebar');

        // Clear
        if (container) container.innerHTML = '';
        if (sidebar) sidebar.classList.add('hidden');

        // Single notebook — no selector needed
        if (this._notebooks.length <= 1) return;

        const mode = this.getEffectiveMode();

        switch (mode) {
            case 'dropdown':
                if (container) this._renderDropdown(container);
                break;
            case 'sidebar':
                if (sidebar) this._renderSidebar(sidebar);
                break;
            case 'tabs':
                if (container) this._renderTabs(container);
                break;
        }
    }

    _renderDropdown(container) {
        const select = document.createElement('select');
        select.id = 'notebook-dropdown';
        select.className = 'notebook-dropdown';

        for (const nb of this._notebooks) {
            const opt = document.createElement('option');
            opt.value = nb.id;
            opt.textContent = nb.name;
            if (nb.isActive) opt.selected = true;
            select.appendChild(opt);
        }

        select.addEventListener('change', () => {
            this.switchTo(select.value);
        });

        const renameBtn = document.createElement('button');
        renameBtn.className = 'notebook-add-btn';
        renameBtn.textContent = '\u270E';
        renameBtn.title = 'Rename Notebook';
        renameBtn.addEventListener('click', () => {
            const active = this.getActiveNotebook();
            if (!active) return;
            const newName = prompt('Rename notebook:', active.name);
            if (newName) this.renameNotebook(active.id, newName);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'notebook-add-btn';
        deleteBtn.textContent = '\u00D7';
        deleteBtn.title = 'Delete Notebook';
        deleteBtn.style.color = 'var(--red, #f85149)';
        deleteBtn.addEventListener('click', () => {
            const active = this.getActiveNotebook();
            if (!active) return;
            if (this._notebooks.length <= 1) {
                alert('Cannot delete the last notebook.');
                return;
            }
            if (confirm('Delete "' + active.name + '"?')) {
                this.removeNotebook(active.id);
            }
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'notebook-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'New Notebook';
        addBtn.addEventListener('click', () => {
            const nb = this.createNotebook({
                name: 'Notebook ' + (this._notebooks.length + 1)
            });
            this.switchTo(nb.id);
        });

        container.appendChild(select);
        container.appendChild(renameBtn);
        container.appendChild(deleteBtn);
        container.appendChild(addBtn);
    }

    /**
     * Replace a name element with an inline input for renaming.
     */
    _startInlineRename(nameEl, nbId) {
        const nb = this.getNotebook(nbId);
        if (!nb) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'nb-rename-input';
        input.value = nb.name;
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.renameNotebook(nbId, input.value);
            } else if (e.key === 'Escape') {
                this.renderSelector();
            }
        });
        input.addEventListener('blur', () => {
            this.renameNotebook(nbId, input.value);
        });
        nameEl.replaceWith(input);
        input.focus();
        input.select();
    }

    _renderSidebar(sidebar) {
        sidebar.classList.remove('hidden');

        const list = sidebar.querySelector('#sidebar-notebook-list');
        if (!list) return;
        list.innerHTML = '';

        for (const nb of this._notebooks) {
            const item = document.createElement('div');
            item.className = 'sidebar-notebook-item' + (nb.isActive ? ' active' : '');

            const langBadge = nb.kernelLanguage
                ? `<span class="lang-badge lang-${nb.kernelLanguage}">${nb.kernelLanguage}</span>`
                : '';

            item.innerHTML = `
                <span class="sidebar-nb-name">${nb.name}</span>
                ${langBadge}
            `;

            // Double-click to rename
            const nameSpan = item.querySelector('.sidebar-nb-name');
            if (nameSpan) {
                nameSpan.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    this._startInlineRename(nameSpan, nb.id);
                });
            }

            item.addEventListener('click', () => this.switchTo(nb.id));

            // Close button (don't show for last notebook)
            if (this._notebooks.length > 1) {
                const closeBtn = document.createElement('button');
                closeBtn.className = 'sidebar-nb-close';
                closeBtn.textContent = '\u00D7';
                closeBtn.title = 'Close notebook';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('Close "' + nb.name + '"?')) {
                        this.removeNotebook(nb.id);
                    }
                });
                item.appendChild(closeBtn);
            }

            list.appendChild(item);
        }

        // Add button at the bottom
        const addBtn = document.createElement('button');
        addBtn.className = 'sidebar-add-btn';
        addBtn.textContent = '+ New Notebook';
        addBtn.addEventListener('click', () => {
            const nb = this.createNotebook({
                name: 'Notebook ' + (this._notebooks.length + 1)
            });
            this.switchTo(nb.id);
        });
        list.appendChild(addBtn);
    }

    _renderTabs(container) {
        const tabBar = document.createElement('div');
        tabBar.className = 'notebook-tab-bar';

        for (const nb of this._notebooks) {
            const tab = document.createElement('div');
            tab.className = 'notebook-tab' + (nb.isActive ? ' active' : '');

            const langBadge = nb.kernelLanguage
                ? `<span class="lang-badge lang-${nb.kernelLanguage}">${nb.kernelLanguage}</span>`
                : '';

            tab.innerHTML = `<span class="tab-name">${nb.name}</span> ${langBadge}`;

            // Double-click to rename
            const tabName = tab.querySelector('.tab-name');
            if (tabName) {
                tabName.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    this._startInlineRename(tabName, nb.id);
                });
            }

            tab.addEventListener('click', () => this.switchTo(nb.id));

            // Close button
            if (this._notebooks.length > 1) {
                const closeBtn = document.createElement('button');
                closeBtn.className = 'tab-close';
                closeBtn.textContent = '\u00D7';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('Close "' + nb.name + '"?')) {
                        this.removeNotebook(nb.id);
                    }
                });
                tab.appendChild(closeBtn);
            }

            tabBar.appendChild(tab);
        }

        // Add tab
        const addTab = document.createElement('div');
        addTab.className = 'notebook-tab notebook-tab-add';
        addTab.textContent = '+';
        addTab.title = 'New Notebook';
        addTab.addEventListener('click', () => {
            const nb = this.createNotebook({
                name: 'Notebook ' + (this._notebooks.length + 1)
            });
            this.switchTo(nb.id);
        });
        tabBar.appendChild(addTab);

        container.appendChild(tabBar);
    }
}

// Listen for responsive changes in auto mode
window.addEventListener('load', () => {
    if (window.notebookManager && window.notebookManager.getUIMode() === 'auto') {
        const mql = window.matchMedia('(min-width: 768px)');
        mql.addEventListener('change', () => {
            if (window.notebookManager) window.notebookManager.renderSelector();
        });
    }
});

// Export singleton
window.notebookManager = new NotebookManager();
