/**
 * notebook_vfs.js — Notebook Virtual Filesystem
 *
 * Mounts the current notebook's cells as a virtual filesystem at /nb/.
 * Each cell appears as a directory addressable by position (In[N]),
 * by name (user-assigned), or relatively (+N/-N from a context cell).
 *
 * Cell properties are exposed as dot-prefixed files:
 *   /nb/In[1]/.code      — source code
 *   /nb/In[1]/.output    — last execution output
 *   /nb/In[1]/.language  — cell language
 *   /nb/In[1]/.type      — "code" or "markdown"
 *   /nb/In[1]/.name      — user-assigned name (empty if unnamed)
 *   /nb/In[1]            — cell object reference (JSON)
 *
 * Loaded before app.js via index.html. Registered as window.notebookVFS.
 */

class NotebookVFS {
    constructor() {
        /** @type {string} Security settings keys in localStorage */
        this.SETTINGS_KEY = 'scirepl_nbvfs_settings';

        /** @type {number|null} Context cell index (0-based) for relative addressing */
        this._contextIndex = null;
    }

    // ── Settings ────────────────────────────────────────────────

    _getSettings() {
        try {
            const raw = localStorage.getItem(this.SETTINGS_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        return {
            crossNotebookRead: false,
            crossNotebookWrite: false,
            programmaticExecution: false,
            sameNotebookWrite: true,
            allowJavaScript: true,
        };
    }

    _saveSettings(settings) {
        localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
    }

    // ── Cell access ─────────────────────────────────────────────

    /**
     * Get the current cells array.
     * @returns {Array}
     */
    _getCells() {
        return window._cells || [];
    }

    /**
     * Set the context cell (for relative addressing).
     * Called before each cell execution with that cell's index.
     * @param {number} index — 0-based index in window._cells
     */
    setContext(index) {
        this._contextIndex = index;
    }

    /**
     * Resolve a cell identifier to a 0-based index.
     * Supports: In[N] (1-based position), named cells, relative (+N/-N), "." (context)
     * @param {string} ident
     * @returns {number|null} 0-based index or null if not found
     */
    _resolveCell(ident) {
        const cells = this._getCells();
        if (!cells.length) return null;

        // Relative: +N or -N (from context cell)
        if (/^[+-]\d+$/.test(ident)) {
            if (this._contextIndex === null) return null;
            const offset = parseInt(ident, 10);
            const target = this._contextIndex + offset;
            return (target >= 0 && target < cells.length) ? target : null;
        }

        // Self: "."
        if (ident === '.') {
            return this._contextIndex;
        }

        // Positional: In[N] (1-based)
        const posMatch = ident.match(/^In\[(\d+)\]$/);
        if (posMatch) {
            const pos = parseInt(posMatch[1], 10);
            return (pos >= 1 && pos <= cells.length) ? pos - 1 : null;
        }

        // Named cell lookup
        for (let i = 0; i < cells.length; i++) {
            if (cells[i].name && cells[i].name === ident) {
                return i;
            }
        }

        return null;
    }

    /**
     * Get a cell property value.
     * @param {number} index — 0-based
     * @param {string} prop — dot-prefixed property name
     * @returns {string|null}
     */
    _getCellProperty(index, prop) {
        const cells = this._getCells();
        if (index < 0 || index >= cells.length) return null;
        const cell = cells[index];

        switch (prop) {
            case '.code':
                return cell.code || '';
            case '.output':
                return cell.lastOutput || '';
            case '.language':
                return cell.language || 'python';
            case '.type':
                return cell.type || 'code';
            case '.name':
                return cell.name || '';
            default:
                return null;
        }
    }

    /**
     * Set a cell property value.
     * @param {number} index — 0-based
     * @param {string} prop — dot-prefixed property name
     * @param {string} value
     * @returns {boolean} success
     */
    _setCellProperty(index, prop, value) {
        const cells = this._getCells();
        if (index < 0 || index >= cells.length) return false;
        const cell = cells[index];
        const settings = this._getSettings();

        // Check write permission
        if (!settings.sameNotebookWrite && index !== this._contextIndex) {
            console.warn('[NotebookVFS] Write to other cells disabled by settings');
            return false;
        }

        switch (prop) {
            case '.code':
                cell.code = typeof value === 'string' ? value : new TextDecoder().decode(value);
                this._updateCellUI(index, 'code');
                return true;
            case '.language':
                cell.language = typeof value === 'string' ? value.trim() : new TextDecoder().decode(value).trim();
                this._updateCellUI(index, 'language');
                return true;
            case '.type':
                cell.type = typeof value === 'string' ? value.trim() : new TextDecoder().decode(value).trim();
                return true;
            case '.name':
                return this._setCellName(index, typeof value === 'string' ? value.trim() : new TextDecoder().decode(value).trim());
            case '.output':
                // Output is read-only (set by execution)
                console.warn('[NotebookVFS] .output is read-only');
                return false;
            default:
                return false;
        }
    }

    /**
     * Set a cell's name with validation.
     * @param {number} index — 0-based
     * @param {string} name
     * @returns {boolean} success
     */
    _setCellName(index, name) {
        const cells = this._getCells();
        if (index < 0 || index >= cells.length) return false;

        // Empty name = clear
        if (!name) {
            cells[index].name = '';
            this._updateCellUI(index, 'name');
            return true;
        }

        // Validate: no slashes, no dot prefix, not In[N] pattern
        if (name.includes('/') || name.startsWith('.') || /^In\[\d+\]$/.test(name)) {
            console.warn('[NotebookVFS] Invalid cell name:', name);
            return false;
        }

        // Validate: unique
        for (let i = 0; i < cells.length; i++) {
            if (i !== index && cells[i].name === name) {
                console.warn('[NotebookVFS] Cell name already in use:', name);
                return false;
            }
        }

        cells[index].name = name;
        this._updateCellUI(index, 'name');
        return true;
    }

    /**
     * Update cell UI after a property change.
     * @param {number} index — 0-based
     * @param {string} changedProp — which property changed
     */
    _updateCellUI(index, changedProp) {
        const cells = this._getCells();
        if (index < 0 || index >= cells.length) return;
        const cell = cells[index];

        if (changedProp === 'code' && cell.inputCard) {
            const pre = cell.inputCard.querySelector('pre');
            if (pre) {
                const code = pre.querySelector('code');
                if (code) {
                    code.textContent = cell.code;
                } else {
                    pre.textContent = cell.code;
                }
            }
        }

        if (changedProp === 'name' && cell.inputCard) {
            let label = cell.inputCard.querySelector('.cell-name-label');
            if (cell.name) {
                if (!label) {
                    label = document.createElement('span');
                    label.className = 'cell-name-label';
                    const cardLabel = cell.inputCard.querySelector('.card-label');
                    if (cardLabel) cardLabel.appendChild(label);
                }
                label.textContent = cell.name;
                label.title = 'Cell name: ' + cell.name;
            } else if (label) {
                label.remove();
            }
        }

        if (changedProp === 'language' && cell.inputCard) {
            const badge = cell.inputCard.querySelector('.lang-badge');
            if (badge) {
                badge.textContent = cell.language;
                badge.className = 'lang-badge lang-' + cell.language;
            }
            cell.inputCard.dataset.language = cell.language;
        }
    }

    // ── Cell creation / deletion ─────────────────────────────────

    /**
     * Create a new cell at the end of the notebook.
     * Called via `mkdir /nb/cell_name`.
     * @param {string} name — cell name (must not be In[N] pattern)
     * @returns {boolean} success
     */
    createCell(name) {
        const cells = this._getCells();

        // Validate name
        if (!name || name.includes('/') || name.startsWith('.')) {
            console.warn('[NotebookVFS] Invalid cell name for creation:', name);
            return false;
        }
        if (/^In\[\d+\]$/.test(name)) {
            console.warn('[NotebookVFS] Cannot create cell with In[N] name');
            return false;
        }
        // Check uniqueness
        for (const c of cells) {
            if (c.name === name) {
                console.warn('[NotebookVFS] Cell name already exists:', name);
                return false;
            }
        }

        // Create minimal cell object
        window._cellCounter = (window._cellCounter || cells.length) + 1;
        const cellId = window._cellCounter;
        const cell = {
            id: cellId,
            code: '',
            type: 'code',
            language: 'python',
            name: name,
            lastOutput: '',
            inputCard: null,
            outputCard: null
        };
        cells.push(cell);

        // Create DOM cards if app.js helpers are available
        if (window._appInternals && window._appInternals.createInputCard) {
            cell.inputCard = window._appInternals.createInputCard('', cellId, 'code', 'python');
            cell.outputCard = window._appInternals.createOutputCard(cellId, 'code');
            // Show the cell name label
            this._updateCellUI(cells.length - 1, 'name');
        }

        // Save session
        if (window._appInternals && window._appInternals.saveCellsToSession) {
            window._appInternals.saveCellsToSession();
        }

        console.log('[NotebookVFS] Created cell:', name, 'at position', cells.length);
        return true;
    }

    /**
     * Delete a cell from the notebook.
     * Called via `rm -r /nb/In[N]` or `rm -r /nb/cell_name`.
     * @param {string} ident — cell identifier
     * @returns {boolean} success
     */
    deleteCell(ident) {
        const index = this._resolveCell(ident);
        if (index === null) {
            console.warn('[NotebookVFS] Cell not found for deletion:', ident);
            return false;
        }

        const cells = this._getCells();
        const cell = cells[index];

        // Remove DOM cards
        if (cell.inputCard) cell.inputCard.remove();
        if (cell.outputCard) cell.outputCard.remove();

        // Remove from array
        cells.splice(index, 1);

        // Save session
        if (window._appInternals && window._appInternals.saveCellsToSession) {
            window._appInternals.saveCellsToSession();
        }

        console.log('[NotebookVFS] Deleted cell:', ident);
        return true;
    }

    // ── VFS path interface ──────────────────────────────────────

    /**
     * Check if a path is under /nb/.
     * @param {string} path — normalized path
     * @returns {boolean}
     */
    isNbPath(path) {
        return path === '/nb' || path.startsWith('/nb/');
    }

    /**
     * Parse a /nb/ path into components.
     * @param {string} path — normalized, must start with /nb/
     * @returns {{ cellIdent: string|null, property: string|null, isList: boolean }}
     */
    _parsePath(path) {
        // /nb or /nb/ → list cells
        if (path === '/nb' || path === '/nb/') {
            return { cellIdent: null, property: null, isList: true };
        }

        // Remove /nb/ prefix
        const rest = path.substring(4); // after "/nb/"
        const parts = rest.split('/').filter(Boolean);

        if (parts.length === 0) {
            return { cellIdent: null, property: null, isList: true };
        }

        const cellIdent = parts[0];

        if (parts.length === 1) {
            // /nb/In[1] or /nb/my_cell — cell reference
            return { cellIdent, property: null, isList: false };
        }

        if (parts.length === 2 && parts[1].startsWith('.')) {
            // /nb/In[1]/.code — cell property
            return { cellIdent, property: parts[1], isList: false };
        }

        // Deeper paths not supported yet
        return { cellIdent, property: null, isList: false };
    }

    /**
     * Read a /nb/ path. Returns content as string or Uint8Array, or null.
     * @param {string} path — normalized
     * @returns {string|Uint8Array|null}
     */
    readFile(path) {
        const parsed = this._parsePath(path);

        // List cells
        if (parsed.isList) {
            return this._listCells();
        }

        const index = this._resolveCell(parsed.cellIdent);
        if (index === null) return null;

        // Cell reference (no property) — return JSON object
        if (!parsed.property) {
            return this._cellToJSON(index);
        }

        // Cell property
        return this._getCellProperty(index, parsed.property);
    }

    /**
     * Write to a /nb/ path.
     * @param {string} path — normalized
     * @param {string|Uint8Array} content
     * @returns {boolean} success
     */
    writeFile(path, content) {
        const parsed = this._parsePath(path);
        if (parsed.isList || !parsed.cellIdent) return false;

        const index = this._resolveCell(parsed.cellIdent);
        if (index === null) return false;

        if (!parsed.property) {
            // Writing to bare cell path not supported (use .code, .name, etc.)
            console.warn('[NotebookVFS] Cannot write to bare cell path. Use .code, .name, etc.');
            return false;
        }

        return this._setCellProperty(index, parsed.property, content);
    }

    /**
     * Check if a /nb/ path exists.
     * @param {string} path — normalized
     * @returns {boolean}
     */
    exists(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) return true;  // /nb/ always exists

        const index = this._resolveCell(parsed.cellIdent);
        if (index === null) return false;

        if (!parsed.property) return true;  // cell exists

        // Check if property is valid
        return ['.code', '.output', '.language', '.type', '.name'].includes(parsed.property);
    }

    /**
     * Stat a /nb/ path.
     * @param {string} path — normalized
     * @returns {object|null}
     */
    stat(path) {
        const parsed = this._parsePath(path);

        if (parsed.isList) {
            return { isDir: true, isFile: false, size: 0, origin: 'notebook', created: 0, modified: 0 };
        }

        const index = this._resolveCell(parsed.cellIdent);
        if (index === null) return null;

        if (!parsed.property) {
            // Cell directory
            return { isDir: true, isFile: false, size: 0, origin: 'notebook', created: 0, modified: 0 };
        }

        // Property file
        const value = this._getCellProperty(index, parsed.property);
        if (value === null) return null;
        const size = typeof value === 'string' ? value.length : 0;
        return { isDir: false, isFile: true, size, origin: 'notebook', created: 0, modified: Date.now() };
    }

    /**
     * List directory contents for a /nb/ path.
     * @param {string} path — normalized
     * @returns {Array<string>|null}
     */
    listDir(path) {
        const parsed = this._parsePath(path);

        if (parsed.isList) {
            // List all cells
            const cells = this._getCells();
            const entries = [];
            for (let i = 0; i < cells.length; i++) {
                entries.push('In[' + (i + 1) + ']');
                if (cells[i].name) {
                    entries.push(cells[i].name);
                }
            }
            return entries;
        }

        const index = this._resolveCell(parsed.cellIdent);
        if (index === null) return null;

        if (!parsed.property) {
            // List cell properties
            return ['.code', '.output', '.language', '.type', '.name'];
        }

        return null;  // properties are files, not directories
    }

    /**
     * List directory for Rust/brush-wasm (returns JSON string).
     * @param {string} path — normalized
     * @returns {string|null}
     */
    vfs_list_dir(path) {
        const parsed = this._parsePath(path);

        if (parsed.isList) {
            const cells = this._getCells();
            const entries = [];
            for (let i = 0; i < cells.length; i++) {
                const name = 'In[' + (i + 1) + ']';
                entries.push({ name, size: 0, is_dir: true, modified: 0 });
                if (cells[i].name) {
                    entries.push({ name: cells[i].name, size: 0, is_dir: true, modified: 0 });
                }
            }
            return JSON.stringify(entries);
        }

        const index = this._resolveCell(parsed.cellIdent);
        if (index === null) return null;

        if (!parsed.property) {
            const props = ['.code', '.output', '.language', '.type', '.name'];
            const entries = props.map(p => {
                const val = this._getCellProperty(index, p);
                return { name: p, size: val ? val.length : 0, is_dir: false, modified: 0 };
            });
            return JSON.stringify(entries);
        }

        return null;
    }

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Return a JSON representation of all cells for /nb/ listing.
     */
    _listCells() {
        const cells = this._getCells();
        const list = cells.map((c, i) => ({
            position: i + 1,
            label: 'In[' + (i + 1) + ']',
            name: c.name || '',
            language: c.language || 'python',
            type: c.type || 'code',
        }));
        return JSON.stringify(list, null, 2);
    }

    /**
     * Return a JSON representation of a single cell.
     */
    _cellToJSON(index) {
        const cells = this._getCells();
        if (index < 0 || index >= cells.length) return null;
        const cell = cells[index];
        return JSON.stringify({
            position: index + 1,
            label: 'In[' + (index + 1) + ']',
            name: cell.name || '',
            code: cell.code || '',
            output: cell.lastOutput || '',
            language: cell.language || 'python',
            type: cell.type || 'code',
        }, null, 2);
    }
}

// Register globally
window.notebookVFS = new NotebookVFS();
console.log('[NotebookVFS] Initialized — /nb/ mount ready');
