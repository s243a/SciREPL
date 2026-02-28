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

        // Prompt user before downloading the large runtime
        const proceed = await this._confirmDownload();
        if (!proceed) {
            throw new Error('R runtime download cancelled by user');
        }

        this._loading = true;
        try {
            const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');
            this._webr = new WebR();
            await this._webr.init();

            // Create shared directories in webR's filesystem
            await this._mkdirSafe('/shared');
            await this._mkdirSafe('/shared/data');
            await this._mkdirSafe('/shared/lib');
            await this._mkdirSafe('/tmp');

            // Enable install.packages() to work with webR's WASM repo
            await this._webr.evalRVoid('webr::shim_install()');
            console.log('[RKernel] install.packages() shimmed');

            // Load SharedVFS helper functions
            await this._loadSharedFSHelpers();

            this._ready = true;
            console.log('[RKernel] Ready (webR)');
        } catch (err) {
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
            const resp = await fetch('js/r_sharedfs.R');
            const code = await resp.text();
            await this._webr.evalRVoid(code);
            console.log('[RKernel] SharedVFS helpers loaded');
        } catch (e) {
            console.warn('[RKernel] Failed to load r_sharedfs.R:', e);
        }
    }

    /**
     * Prompt the user before downloading the ~50 MB webR runtime.
     * Returns true if user confirms, false if cancelled.
     */
    async _confirmDownload() {
        return new Promise(resolve => {
            const confirmed = confirm(
                'The R runtime (webR) requires a ~50 MB download.\n\n' +
                'It will be cached by the browser for future use.\n\n' +
                'Download now?'
            );
            resolve(confirmed);
        });
    }

    isReady() {
        return this._ready;
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

            const shelter = await new this._webr.Shelter();
            const capture = await shelter.captureR(trimmed, {
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
