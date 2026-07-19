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
     * Supports typed output sub-properties: .output.text, .output.html,
     * .output.json, .output.png
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
            case '.output.text':
                return cell.lastOutput || '';
            case '.output.html':
                return cell.lastOutputHtml || '';
            case '.output.json': {
                const text = cell.lastOutput || '';
                try {
                    JSON.parse(text);
                    return text;
                } catch (e) {
                    return null; // not valid JSON
                }
            }
            case '.output.png': {
                // Extract first image data URL from HTML output
                const html = cell.lastOutputHtml || '';
                const imgMatch = html.match(/src="(data:image\/png;base64,[^"]+)"/);
                return imgMatch ? imgMatch[1] : null;
            }
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
                if (window._appInternals && window._appInternals.setPreHighlighted) {
                    window._appInternals.setPreHighlighted(
                        pre, cell.code, cell.language || 'python', cell.type === 'markdown'
                    );
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

        if (['code', 'language'].includes(changedProp) &&
            cell.inputCard && window._appInternals?.updateSourceOnlyIndicator) {
            window._appInternals.updateSourceOnlyIndicator(
                cell.inputCard, cell.code, cell.type, cell.language || 'python'
            );
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

        if (parts.length === 3 && parts[1] === '.output' && parts[2].startsWith('.')) {
            // /nb/In[1]/.output/.text → typed output sub-property
            // Normalize: join as .output.text (strip leading dot from sub-property)
            const subProp = parts[2].substring(1); // remove leading dot
            return { cellIdent, property: '.output.' + subProp, isList: false };
        }

        // Deeper paths not supported
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
        const validProps = ['.code', '.output', '.language', '.type', '.name',
                           '.output.text', '.output.html', '.output.json', '.output.png'];
        return validProps.includes(parsed.property);
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

        // .output acts as both file and directory (has sub-properties)
        if (parsed.property === '.output') {
            const value = this._getCellProperty(index, '.output');
            const size = typeof value === 'string' ? value.length : 0;
            return { isDir: true, isFile: true, size, origin: 'notebook', created: 0, modified: Date.now() };
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

        if (parsed.property === '.output') {
            // .output is both a file and a directory with sub-properties
            return ['.text', '.html', '.json', '.png'];
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
                const isOutput = (p === '.output');
                return { name: p, size: val ? val.length : 0, is_dir: isOutput, modified: 0 };
            });
            return JSON.stringify(entries);
        }

        if (parsed.property === '.output') {
            // List output sub-properties
            const subs = ['text', 'html', 'json', 'png'];
            const entries = subs.map(s => {
                const val = this._getCellProperty(index, '.output.' + s);
                return { name: '.' + s, size: val ? val.length : 0, is_dir: false, modified: 0 };
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

// ══════════════════════════════════════════════════════════════
// WorkbookVFS — Cross-notebook access at /workbook/
// ══════════════════════════════════════════════════════════════

/**
 * Mounts all notebooks at /workbook/<Notebook Name>/In[N]/.code etc.
 * Reads cells from inactive notebooks via NotebookManager.
 * Gated by crossNotebookRead/crossNotebookWrite security settings.
 */
class WorkbookVFS {
    isWorkbookPath(path) {
        return path === '/workbook' || path.startsWith('/workbook/');
    }

    _parsePath(path) {
        if (path === '/workbook' || path === '/workbook/') {
            return { nbName: null, cellIdent: null, property: null, isList: true };
        }

        const rest = path.substring('/workbook/'.length);
        // Notebook names can contain spaces, so we split carefully.
        // Format: /workbook/Notebook Name/In[1]/.code
        // We try to match the notebook name against known notebooks.
        const nm = window.notebookManager;
        if (!nm) return { nbName: null, cellIdent: null, property: null, isList: false };

        const notebooks = nm.getNotebooks();
        let matched = null;
        let remaining = '';

        for (const nb of notebooks) {
            if (rest === nb.name || rest.startsWith(nb.name + '/')) {
                matched = nb;
                remaining = rest.substring(nb.name.length);
                break;
            }
        }

        if (!matched) {
            return { nbName: rest, cellIdent: null, property: null, isList: false };
        }

        if (!remaining || remaining === '/') {
            return { nbName: matched.name, cellIdent: null, property: null, isList: true, notebook: matched };
        }

        const parts = remaining.substring(1).split('/').filter(Boolean);
        const cellIdent = parts[0] || null;
        let property = null;

        if (parts.length >= 2 && parts[1].startsWith('.')) {
            property = parts[1];
            if (parts.length === 3 && parts[1] === '.output' && parts[2].startsWith('.')) {
                property = '.output.' + parts[2].substring(1);
            }
        }

        return { nbName: matched.name, cellIdent, property, isList: false, notebook: matched };
    }

    _getCells(nb) {
        if (!nb) return [];
        // Active notebook: use window._cells
        if (nb.isActive) return window._cells || [];
        return nb.cells || [];
    }

    _resolveCell(cells, ident) {
        if (!cells.length) return null;

        const posMatch = ident.match(/^In\[(\d+)\]$/);
        if (posMatch) {
            const pos = parseInt(posMatch[1], 10);
            return (pos >= 1 && pos <= cells.length) ? pos - 1 : null;
        }

        for (let i = 0; i < cells.length; i++) {
            if (cells[i].name && cells[i].name === ident) return i;
        }
        return null;
    }

    _getCellProp(cell, prop) {
        switch (prop) {
            case '.code': return cell.code || '';
            case '.output': return cell.lastOutput || '';
            case '.output.text': return cell.lastOutput || '';
            case '.output.html': return cell.lastOutputHtml || '';
            case '.output.json': {
                const t = cell.lastOutput || '';
                try { JSON.parse(t); return t; } catch (e) { return null; }
            }
            case '.language': return cell.language || 'python';
            case '.type': return cell.type || 'code';
            case '.name': return cell.name || '';
            default: return null;
        }
    }

    readFile(path) {
        const settings = window.notebookVFS ? window.notebookVFS._getSettings() : {};
        if (!settings.crossNotebookRead) {
            console.warn('[WorkbookVFS] Cross-notebook read disabled');
            return null;
        }

        const parsed = this._parsePath(path);
        const nm = window.notebookManager;
        if (!nm) return null;

        if (parsed.isList && !parsed.nbName) {
            // List all notebooks
            const list = nm.getNotebooks().map(nb => nb.name);
            return JSON.stringify(list, null, 2);
        }

        if (parsed.isList && parsed.notebook) {
            // List cells in a notebook
            const cells = this._getCells(parsed.notebook);
            const list = cells.map((c, i) => ({
                position: i + 1,
                label: 'In[' + (i + 1) + ']',
                name: c.name || '',
                language: c.language || 'python'
            }));
            return JSON.stringify(list, null, 2);
        }

        if (!parsed.notebook || !parsed.cellIdent) return null;

        const cells = this._getCells(parsed.notebook);
        const index = this._resolveCell(cells, parsed.cellIdent);
        if (index === null) return null;

        if (!parsed.property) {
            const cell = cells[index];
            return JSON.stringify({
                position: index + 1,
                label: 'In[' + (index + 1) + ']',
                name: cell.name || '',
                code: cell.code || '',
                output: cell.lastOutput || '',
                language: cell.language || 'python',
                type: cell.type || 'code'
            }, null, 2);
        }

        return this._getCellProp(cells[index], parsed.property);
    }

    writeFile(path, content) {
        const settings = window.notebookVFS ? window.notebookVFS._getSettings() : {};
        if (!settings.crossNotebookWrite) {
            console.warn('[WorkbookVFS] Cross-notebook write disabled');
            return false;
        }

        const parsed = this._parsePath(path);
        if (!parsed.notebook || !parsed.cellIdent || !parsed.property) return false;

        const cells = this._getCells(parsed.notebook);
        const index = this._resolveCell(cells, parsed.cellIdent);
        if (index === null) return false;

        // For active notebook, delegate to NotebookVFS
        if (parsed.notebook.isActive && window.notebookVFS) {
            return window.notebookVFS._setCellProperty(index, parsed.property, content);
        }

        // For inactive notebooks, modify the cell data directly
        const cell = cells[index];
        const value = typeof content === 'string' ? content : new TextDecoder().decode(content);
        switch (parsed.property) {
            case '.code': cell.code = value; return true;
            case '.language': cell.language = value.trim(); return true;
            case '.type': cell.type = value.trim(); return true;
            case '.name': cell.name = value.trim(); return true;
            default: return false;
        }
    }

    exists(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) return true;
        if (!parsed.notebook) return false;
        if (!parsed.cellIdent) return true;
        const cells = this._getCells(parsed.notebook);
        const index = this._resolveCell(cells, parsed.cellIdent);
        if (index === null) return false;
        if (!parsed.property) return true;
        return this._getCellProp(cells[index], parsed.property) !== null;
    }

    stat(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) {
            return { isDir: true, isFile: false, size: 0, origin: 'workbook', created: 0, modified: 0 };
        }
        if (!parsed.notebook) return null;
        if (!parsed.cellIdent) {
            return { isDir: true, isFile: false, size: 0, origin: 'workbook', created: 0, modified: 0 };
        }
        const cells = this._getCells(parsed.notebook);
        const index = this._resolveCell(cells, parsed.cellIdent);
        if (index === null) return null;
        if (!parsed.property) {
            return { isDir: true, isFile: false, size: 0, origin: 'workbook', created: 0, modified: 0 };
        }
        const val = this._getCellProp(cells[index], parsed.property);
        if (val === null) return null;
        return { isDir: false, isFile: true, size: val.length, origin: 'workbook', created: 0, modified: Date.now() };
    }

    listDir(path) {
        const parsed = this._parsePath(path);
        const nm = window.notebookManager;
        if (!nm) return null;

        if (parsed.isList && !parsed.nbName) {
            return nm.getNotebooks().map(nb => nb.name);
        }
        if (parsed.isList && parsed.notebook) {
            const cells = this._getCells(parsed.notebook);
            const entries = [];
            for (let i = 0; i < cells.length; i++) {
                entries.push('In[' + (i + 1) + ']');
                if (cells[i].name) entries.push(cells[i].name);
            }
            return entries;
        }
        if (parsed.notebook && parsed.cellIdent && !parsed.property) {
            return ['.code', '.output', '.language', '.type', '.name'];
        }
        return null;
    }

    vfs_list_dir(path) {
        const entries = this.listDir(path);
        if (!entries) return null;
        const parsed = this._parsePath(path);
        if (parsed.isList && !parsed.nbName) {
            return JSON.stringify(entries.map(name => ({ name, size: 0, is_dir: true, modified: 0 })));
        }
        if (parsed.isList && parsed.notebook) {
            return JSON.stringify(entries.map(name => ({ name, size: 0, is_dir: true, modified: 0 })));
        }
        if (parsed.notebook && parsed.cellIdent && !parsed.property) {
            return JSON.stringify(entries.map(name => ({ name, size: 0, is_dir: false, modified: 0 })));
        }
        return null;
    }
}

window.workbookVFS = new WorkbookVFS();

// ══════════════════════════════════════════════════════════════
// LocalStorageVFS — Expose localStorage at /local/
// ══════════════════════════════════════════════════════════════

/**
 * Mounts localStorage keys as files under /local/.
 * Read-only by default. Keys are files, values are content.
 * JSON values are pretty-printed when read.
 */
class LocalStorageVFS {
    isLocalPath(path) {
        return path === '/local' || path.startsWith('/local/');
    }

    _parsePath(path) {
        if (path === '/local' || path === '/local/') {
            return { key: null, isList: true };
        }
        const key = path.substring('/local/'.length);
        return { key: key || null, isList: false };
    }

    readFile(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i));
            }
            return JSON.stringify(keys, null, 2);
        }
        if (!parsed.key) return null;
        const value = localStorage.getItem(parsed.key);
        if (value === null) return null;
        // Try to pretty-print JSON values
        try {
            const obj = JSON.parse(value);
            return JSON.stringify(obj, null, 2);
        } catch (e) {
            return value;
        }
    }

    writeFile(path, content) {
        // Read-only for safety — writing could break app state
        console.warn('[LocalStorageVFS] /local/ is read-only');
        return false;
    }

    exists(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) return true;
        if (!parsed.key) return false;
        return localStorage.getItem(parsed.key) !== null;
    }

    stat(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) {
            return { isDir: true, isFile: false, size: 0, origin: 'local', created: 0, modified: 0 };
        }
        if (!parsed.key) return null;
        const value = localStorage.getItem(parsed.key);
        if (value === null) return null;
        return { isDir: false, isFile: true, size: value.length, origin: 'local', created: 0, modified: 0 };
    }

    listDir(path) {
        const parsed = this._parsePath(path);
        if (parsed.isList) {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i));
            }
            return keys;
        }
        return null;
    }

    vfs_list_dir(path) {
        const entries = this.listDir(path);
        if (!entries) return null;
        return JSON.stringify(entries.map(name => {
            const val = localStorage.getItem(name);
            return { name, size: val ? val.length : 0, is_dir: false, modified: 0 };
        }));
    }
}

window.localStorageVFS = new LocalStorageVFS();
