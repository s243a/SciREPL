/**
 * kernels/r.js — R kernel using webR (WebAssembly).
 * Provides a full R environment with plotting support,
 * SharedVFS integration, and package installation.
 *
 * Lazy-loaded from CDN (~50+ MB) on first use.
 * User is prompted before download.
 */

class RKernel {
    constructor() {
        this._webr = null;
        this._ready = false;
        this._loading = false;
        /** Track files synced to webR so we can detect changes */
        this._syncedToWebR = new Map(); // path → modified timestamp
    }

    static displayName = 'R';

    async init() {
        if (this._ready) return;
        if (this._loading) {
            while (this._loading) {
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }

        const km = window.kernelManager;
        this._loading = true;
        try {
            if (km) km.updateProgress('Downloading R runtime...');
            const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');

            if (km) km.updateProgress('Initializing R environment...');
            this._webr = new WebR();
            await this._webr.init();

            // Create shared directories in webR's filesystem
            await this._mkdirSafe('/shared');
            await this._mkdirSafe('/shared/data');
            await this._mkdirSafe('/shared/lib');
            await this._mkdirSafe('/tmp');

            if (km) km.updateProgress('Configuring packages...');
            // Enable install.packages() to work with webR's WASM repo
            await this._webr.evalRVoid('webr::shim_install()');
            console.log('[RKernel] install.packages() shimmed');

            if (km) km.updateProgress('Loading helpers...');
            // Load SharedVFS helper functions
            await this._loadSharedFSHelpers();

            this._ready = true;
            if (km) km.hideDownloadModal();
            console.log('[RKernel] Ready (webR)');

            // Offer to pre-install popular packages (non-blocking)
            this._offerPrewarm();
        } catch (err) {
            if (km) km.hideDownloadModal();
            console.error('[RKernel] Init failed:', err);
            throw err;
        } finally {
            this._loading = false;
        }
    }

    /**
     * Load the R SharedVFS convenience functions into the R session.
     */
    async _loadSharedFSHelpers() {
        try {
            const resp = await fetch('js/r_prelude.R');
            const code = await resp.text();
            await this._webr.evalRVoid(code);
            console.log('[RKernel] R prelude loaded (SharedVFS + plotly)');
        } catch (e) {
            console.warn('[RKernel] Failed to load r_prelude.R:', e);
        }
    }

    isReady() {
        return this._ready;
    }

    getMemoryUsage() {
        // webR runs in a web worker — direct heap access is limited
        if (!this._webr) return null;
        return null;
    }

    getName() {
        return 'R (webR)';
    }

    getLanguage() {
        return 'r';
    }

    // ── SharedVFS Sync ──────────────────────────────────────────

    /**
     * Create a directory in webR's FS, ignoring "already exists" errors.
     */
    async _mkdirSafe(path) {
        try {
            await this._webr.FS.mkdir(path);
        } catch (e) {
            // Ignore EEXIST
        }
    }

    /**
     * Recursively collect all file paths from SharedVFS under a prefix.
     */
    _collectSharedFiles(prefix) {
        const vfs = window.sharedVFS;
        if (!vfs) return [];
        const files = [];
        // Walk the SharedVFS internal file map
        for (const [path, entry] of vfs._files) {
            if (path.startsWith(prefix + '/')) {
                files.push({ path, content: entry.content, modified: entry.modified });
            }
        }
        return files;
    }

    /**
     * Sync files from SharedVFS → webR's Emscripten FS (before execution).
     * Only syncs files that are new or changed since last sync.
     */
    async _syncToWebR() {
        const vfs = window.sharedVFS;
        if (!vfs) return;

        for (const prefix of ['/shared', '/tmp']) {
            const files = this._collectSharedFiles(prefix);
            for (const { path, content, modified } of files) {
                const lastSynced = this._syncedToWebR.get(path);
                if (lastSynced && lastSynced >= modified) continue;

                // Ensure parent dirs exist in webR FS
                const parts = path.split('/');
                for (let i = 2; i < parts.length; i++) {
                    await this._mkdirSafe(parts.slice(0, i).join('/'));
                }

                // Write file into webR FS
                let data;
                if (content instanceof Uint8Array) {
                    data = content;
                } else {
                    data = new TextEncoder().encode(String(content));
                }
                await this._webr.FS.writeFile(path, data);
                this._syncedToWebR.set(path, modified);
            }
        }
    }

    /**
     * Sync NotebookVFS cell properties into webR's FS as files.
     * Creates /nb/In[N]/.code, .output, .language, .type, .name for each cell.
     * This allows R code to use readLines("/nb/In[1]/.code") etc.
     */
    async _syncNbToWebR() {
        const nbvfs = window.notebookVFS;
        if (!nbvfs) return;

        const cells = window._cells || [];
        if (cells.length === 0) return;

        // Ensure /nb directory exists
        await this._mkdirSafe('/nb');

        const props = ['.code', '.output', '.language', '.type', '.name'];

        for (let i = 0; i < cells.length; i++) {
            const label = 'In[' + (i + 1) + ']';
            const cellDir = '/nb/' + label;
            await this._mkdirSafe(cellDir);

            for (const prop of props) {
                const value = nbvfs._getCellProperty(i, prop);
                if (value !== null) {
                    const data = new TextEncoder().encode(value);
                    await this._webr.FS.writeFile(cellDir + '/' + prop, data);
                }
            }

            // Also create named alias directory if cell has a name
            if (cells[i].name) {
                const namedDir = '/nb/' + cells[i].name;
                await this._mkdirSafe(namedDir);
                for (const prop of props) {
                    const value = nbvfs._getCellProperty(i, prop);
                    if (value !== null) {
                        const data = new TextEncoder().encode(value);
                        await this._webr.FS.writeFile(namedDir + '/' + prop, data);
                    }
                }
            }
        }
    }

    /**
     * Sync files from webR's Emscripten FS → SharedVFS (after execution).
     * Walks /shared and /tmp in webR, writes any new/changed files back.
     */
    async _syncFromWebR() {
        const vfs = window.sharedVFS;
        if (!vfs) return;

        for (const prefix of ['/shared', '/tmp']) {
            await this._syncDirFromWebR(prefix, vfs);
        }
    }

    /**
     * Recursively sync a directory from webR FS back to SharedVFS.
     */
    async _syncDirFromWebR(dirPath, vfs) {
        let entries;
        try {
            entries = await this._webr.evalRString(
                `paste(list.files("${dirPath}", full.names = TRUE, recursive = TRUE), collapse = "\\n")`
            );
        } catch (e) {
            return; // Directory might not exist
        }

        if (!entries || entries.trim() === '') return;

        for (const filePath of entries.split('\n')) {
            if (!filePath) continue;
            try {
                const data = await this._webr.FS.readFile(filePath);
                // Check if this file differs from what's in SharedVFS
                const existing = vfs.readFile(filePath);
                if (existing instanceof Uint8Array) {
                    if (existing.length === data.length) {
                        let same = true;
                        for (let i = 0; i < data.length; i++) {
                            if (existing[i] !== data[i]) { same = false; break; }
                        }
                        if (same) continue;
                    }
                } else if (existing !== null) {
                    const existingBytes = new TextEncoder().encode(String(existing));
                    if (existingBytes.length === data.length) {
                        let same = true;
                        for (let i = 0; i < data.length; i++) {
                            if (existingBytes[i] !== data[i]) { same = false; break; }
                        }
                        if (same) continue;
                    }
                }
                // File is new or changed — write to SharedVFS
                vfs.writeFile(filePath, new Uint8Array(data), 'r');
                this._syncedToWebR.set(filePath, Date.now());
            } catch (e) {
                // Skip files that can't be read (directories, special files)
            }
        }
    }

    // ── Package Installation ────────────────────────────────────

    /**
     * Install R packages from the webR WASM repository.
     * @param {string[]} packageNames
     * @returns {string} Status messages
     */
    async installPackages(packageNames) {
        if (!this._ready) await this.init();

        const messages = [];
        for (const pkg of packageNames) {
            try {
                messages.push(`Installing ${pkg}...`);
                await this._webr.installPackages([pkg]);
                messages.push(`  Installed ${pkg}`);
                // Auto-apply dark theme when ggplot2 is installed
                if (pkg === 'ggplot2') {
                    try {
                        await this._webr.evalRVoid('.scirepl_setup_ggplot2()');
                        await this._webr.evalRVoid('assign(".scirepl_ggplot2_themed", TRUE, envir=globalenv())');
                        messages.push('  SciREPL dark theme applied');
                    } catch (e) { /* theme setup is best-effort */ }
                }
            } catch (e) {
                messages.push(`  Failed to install ${pkg}: ${e.message || e}`);
            }
        }
        return messages.join('\n');
    }

    // ── Execute ─────────────────────────────────────────────────

    /**
     * Execute R code. Returns { stdout, result, error, images }.
     */
    async execute(code) {
        if (!this._ready) await this.init();

        const trimmed = code.trim();
        if (!trimmed) {
            return { stdout: '', result: null, error: null };
        }

        try {
            // Sync SharedVFS → webR before execution
            await this._syncToWebR();
            // Sync NotebookVFS cell properties into webR FS
            await this._syncNbToWebR();

            const shelter = await new this._webr.Shelter();
            // Prepend dark-theme par() so base R plots are legible on dark UI
            const darkPar = `par(bg="#0d1117", fg="#c9d1d9", col="#58a6ff", col.axis="#8b949e", col.lab="#c9d1d9", col.main="#e6edf3", col.sub="#8b949e")\n`;
            // Auto-apply ggplot2 dark theme if ggplot2 is loaded
            const ggTheme = `if (requireNamespace("ggplot2", quietly=TRUE) && !exists(".scirepl_ggplot2_themed", envir=globalenv())) { .scirepl_setup_ggplot2(); assign(".scirepl_ggplot2_themed", TRUE, envir=globalenv()) }\n`;
            const capture = await shelter.captureR(darkPar + ggTheme + trimmed, {
                withAutoprint: true,
                captureStreams: true,
                captureConditions: false,
                captureGraphics: {
                    width: 504,
                    height: 504
                }
            });

            // Collect stdout/stderr
            let stdout = '';
            for (const msg of capture.output) {
                if (msg.type === 'stdout' || msg.type === 'stderr') {
                    stdout += msg.data + '\n';
                }
            }

            // Convert result to displayable value
            let result = null;
            if (capture.result && capture.result.type !== 'null') {
                try {
                    const jsVal = await capture.result.toJs();
                    if (jsVal && jsVal.values !== undefined) {
                        const vals = jsVal.values;
                        if (Array.isArray(vals) && vals.length === 1) {
                            result = { type: 'text', content: String(vals[0]) };
                        } else if (Array.isArray(vals)) {
                            result = { type: 'text', content: vals.join(' ') };
                        }
                    }
                } catch (e) {
                    // Non-convertible result (e.g. environment), skip
                }
            }

            // Handle plot images
            let images = [];
            if (capture.images && capture.images.length > 0) {
                for (const img of capture.images) {
                    try {
                        const canvas = new OffscreenCanvas(img.width, img.height);
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        const blob = await canvas.convertToBlob({ type: 'image/png' });
                        const url = URL.createObjectURL(blob);
                        images.push(url);
                    } catch (e) {
                        console.warn('[RKernel] Failed to render plot:', e);
                    }
                }
            }

            shelter.purge();

            // Extract and render Plotly directives from stdout
            const plotlyRegex = /__SCIREPL_PLOTLY__ (.*?) __END_PLOTLY__/g;
            let plotlyMatch;
            while ((plotlyMatch = plotlyRegex.exec(stdout)) !== null) {
                try {
                    window.renderPlot(plotlyMatch[1]);
                } catch (e) {
                    console.warn('[RKernel] Plotly render failed:', e);
                }
            }
            // Remove plotly markers from displayed stdout
            stdout = stdout.replace(/__SCIREPL_PLOTLY__ .*? __END_PLOTLY__\n?/g, '');

            // Sync webR → SharedVFS after execution
            await this._syncFromWebR();

            return {
                stdout: stdout.trimEnd(),
                result,
                error: null,
                images
            };
        } catch (e) {
            return {
                stdout: '',
                result: null,
                error: e.message || String(e)
            };
        }
    }

    /**
     * Offer to pre-install popular R packages after init.
     * Shows a non-blocking prompt in the REPL output area.
     */
    async _offerPrewarm() {
        const pref = localStorage.getItem('scirepl_r_prewarm');
        if (pref === 'no') return;       // user said "don't ask again"
        if (pref === 'yes') {
            // Auto-install without prompting
            this._doPrewarm();
            return;
        }

        // Show prompt card in output area
        const repl = document.getElementById('repl');
        if (!repl) return;

        const card = document.createElement('div');
        card.className = 'card card-output';
        card.innerHTML = `
            <div class="card-body" style="text-align:center; padding:12px;">
                <p style="margin:0 0 10px; color:var(--text-secondary); font-size:13px;">
                    Install recommended R packages? <strong>ggplot2</strong> and <strong>dplyr</strong>
                    enable visualization and data wrangling.
                </p>
                <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
                    <button class="vfs-btn" data-action="install" style="background:var(--accent);color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;">Install</button>
                    <button class="vfs-btn" data-action="skip" style="padding:6px 16px;border-radius:6px;cursor:pointer;">Skip</button>
                    <button class="vfs-btn" data-action="never" style="padding:6px 16px;border-radius:6px;cursor:pointer;font-size:11px;">Don't ask again</button>
                </div>
            </div>
        `;

        repl.appendChild(card);
        card.scrollIntoView({ behavior: 'smooth' });

        card.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (!action) return;
            card.remove();
            if (action === 'install') {
                localStorage.setItem('scirepl_r_prewarm', 'yes');
                this._doPrewarm();
            } else if (action === 'never') {
                localStorage.setItem('scirepl_r_prewarm', 'no');
            }
            // 'skip' just removes the card, doesn't persist preference
        });
    }

    /**
     * Install ggplot2 + dplyr in the background.
     */
    async _doPrewarm() {
        const badge = document.getElementById('status-badge');
        if (badge) {
            badge.textContent = 'installing R packages...';
            badge.className = 'running';
        }
        try {
            await this.installPackages(['ggplot2', 'dplyr']);
            console.log('[RKernel] Pre-warm complete (ggplot2, dplyr)');
        } catch (e) {
            console.warn('[RKernel] Pre-warm failed:', e);
        }
        if (badge) {
            badge.textContent = 'ready';
            badge.className = 'ready';
        }
    }

    destroy() {
        if (this._webr) {
            this._webr = null;
        }
        this._ready = false;
        this._syncedToWebR.clear();
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('r', RKernel);
}
