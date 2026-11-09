/**
 * kernels/python.js — Python kernel using Pyodide (WebAssembly).
 * Manages Pyodide initialization, prelude loading, stdout capture,
 * SymPy detection, and code execution.
 */

class PythonKernel {
    constructor() {
        this._pyodide = null;
        this._ready = false;
        this._packageIndex = null;
        this._syncedToPyodide = new Map(); // path → modified timestamp
    }

    static runtimeConfig() {
        return window.KERNEL_CONFIG?.languages?.python || {};
    }

    static primaryUrl() {
        const source = (PythonKernel.runtimeConfig().sources || [])
            .find((item) => item?.type === 'cdn' && item.url);
        if (!source) throw new Error('Python runtime source is missing from generated kernel_config.js');
        return source.url;
    }

    static configurePackageInstalls(pyodide, indexURL) {
        // Pyodide 0.27 reports wheel failures through errorCallback but resolves
        // loadPackage's promise. Micropip otherwise mistakes that for success.
        // Install before the first micropip import, which captures this public
        // function. Do not reinterpret requirements or eagerly import packages.
        if (!pyodide.loadPackage._scireplStrict) {
            const original = pyodide.loadPackage.bind(pyodide);
            const strict = async (names, options = {}) => {
                const errors = [];
                const result = await original(names, {
                    ...options,
                    errorCallback(message) {
                        errors.push(String(message));
                        if (typeof options.errorCallback === 'function') options.errorCallback(message);
                    },
                });
                if (errors.length) throw new Error('Python package download/install failed: '
                    + errors.slice(0, 3).map(message => message.replace(/:\s*$/, '')).join('; '));
                return result;
            };
            strict._scireplStrict = true;
            pyodide.loadPackage = strict;
        }
        pyodide.registerJsModule('_scirepl_package_network', {
            before_fetch: (url) => PythonKernel.requirePackageNetworkConsent(url),
            ensure_consent: async () => {
                const manager = window.kernelManager;
                if (typeof manager?.ensureNetworkConsent !== 'function'
                    || typeof manager?.hasCurrentPrivacyConsent !== 'function') {
                    throw new Error('Network disclosure is unavailable; Python package installation was not started.');
                }
                await manager.ensureNetworkConsent();
                if (!manager.hasCurrentPrivacyConsent()) throw new Error(window.t('kernelManager.privacyRequired'));
            },
            verify_builtin_dependencies: async (name, version) => {
                const manager = window.kernelManager;
                const index = manager?.getKernel('python')?.getPackageIndex?.();
                const resolver = window.PipResolver;
                if (!index || !resolver) return; // Custom runtimes retain their native package index semantics.
                const normalized = resolver.normName(name);
                const entries = resolver.indexLock(index);
                const root = entries[normalized];
                if (!root || root.version !== version) return;
                const loaded = new Set(Object.keys(pyodide.loadedPackages).map(resolver.normName));
                const files = new Set(resolver.resolveDepsOf(index, normalized, loaded));
                if (!files.size) return;
                // The root can be installed even though one lazy compiled
                // dependency failed. Native micropip then short-circuits on a
                // retry. Repair only this requested built-in's missing closure.
                const names = Object.entries(entries).filter(([, entry]) => files.has(entry.file_name)).map(([key]) => key);
                await pyodide.loadPackage(names);
            },
        });
        PythonKernel.installPackageFetchGuard(indexURL);
    }

    // Micropip's Python HTTP hook handles arbitrary indexes/wheel URLs. This
    // additional boundary catches the compiled loader and direct loadPackage.
    // Pyodide also loads shared libraries as .zip/.tar (or other file types).
    // Cover its exact configured/active runtime directories, not arbitrary
    // archives on unrelated CDN paths. Local assets still need no consent.
    static installPackageFetchGuard(indexURL) {
        const roots = PythonKernel._packageFetchRoots ||= new Set();
        const sources = (PythonKernel.runtimeConfig().sources || [])
            .filter(source => source?.type === 'cdn' && source.url).map(source => source.url);
        if (indexURL) sources.push(indexURL);
        for (const source of sources) roots.add(new URL('.', new URL(source, document.baseURI)).href);
        if (window.fetch?._scireplPackageNetwork) return;
        const original = window.fetch;
        if (typeof original !== 'function') return;
        const guarded = async (input, init) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, document.baseURI);
            const runtimeAsset = [...roots].some(root => {
                const base = new URL(root);
                return url.origin === base.origin && url.pathname.startsWith(base.pathname);
            });
            if (/\.whl$/i.test(url.pathname) || runtimeAsset) await PythonKernel.requirePackageNetworkConsent(url.href);
            return original.call(window, input, init);
        };
        guarded._scireplPackageNetwork = true;
        window.fetch = guarded;
    }

    static async requirePackageNetworkConsent(input) {
        const url = new URL(String(input), document.baseURI);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
        const manager = window.kernelManager;
        if (typeof manager?.ensureNetworkConsent !== 'function'
            || typeof manager?.hasCurrentPrivacyConsent !== 'function') {
            throw new Error('Network disclosure is unavailable; Python package download was not started.');
        }
        await manager.ensureNetworkConsent();
        if (!manager.hasCurrentPrivacyConsent()) throw new Error(window.t('kernelManager.privacyRequired'));
    }

    async init() {
        if (this._ready) return;
        this._packageIndex = null;

        const km = window.kernelManager;

        // Dynamically load Pyodide script if not already available.
        // Track which source actually loaded so loadPyodide() resolves its
        // package files (numpy/sympy/stdlib) from the SAME location — the
        // bundled copy when offline, the CDN otherwise.
        const primary = PythonKernel.primaryUrl();
        let pyodideJsUrl = primary;
        if (typeof loadPyodide === 'undefined') {
            if (km) km.updateProgress(window.t('runtime.pythonDownloading'));
            if (km && km.loadKernelSource) {
                await km.loadKernelSource('python', primary, (url) =>
                    km._loadScript(url).then(() => { pyodideJsUrl = url; }));
            } else {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = primary;
                    script.onload = resolve;
                    script.onerror = () => reject(new Error(window.t('runtime.pyodideCdnFailed')));
                    document.body.appendChild(script);
                });
            }
        }

        if (km) km.updateProgress(window.t('runtime.pythonInitializing'));
        // Keep the core runtime and bundled wheels at the loader's indexURL.
        // Only the app's own partial bundle needs a separate package index:
        // Pyodide's browser loader does not fall back to CDN for missing wheels.
        const indexURL = pyodideJsUrl.replace(/[^/]*$/, '');
        const options = { indexURL };
        const config = PythonKernel.runtimeConfig();
        if (config.sources?.some(source => source.type === 'local' && source.url === pyodideJsUrl)) {
            const lockFileURL = new URL('scirepl-pyodide-lock.json', new URL(indexURL, document.baseURI)).href;
            try {
                const response = await fetch(lockFileURL);
                if (response.ok) {
                    const lock = await response.json();
                    if (lock.info?.version === config.version && lock.packages) {
                        options.lockFileURL = lockFileURL;
                        this._packageIndex = lock;
                    }
                }
            } catch (_) { /* An older bundle can still boot with its upstream index. */ }
            if (!this._packageIndex) {
                try {
                    const response = await fetch(new URL('pyodide-lock.json', new URL(indexURL, document.baseURI)));
                    if (response.ok) {
                        const lock = await response.json();
                        if (lock.info?.version === config.version && lock.packages) this._packageIndex = lock;
                    }
                } catch (_) { /* The installer will report unavailable package metadata. */ }
            }
        }
        this._pyodide = await loadPyodide(options);
        PythonKernel.configurePackageInstalls(this._pyodide, indexURL);
        await this._pyodide.loadPackage(['numpy', 'sympy']);
        await this._pyodide.loadPackage('micropip');

        if (km) km.updateProgress(window.t('runtime.loadingHelpers'));

        // Register the lazy inline backend before the prelude or user code can
        // import matplotlib. No plotting package is imported/downloaded here.
        const matplotlibBackendResp = await fetch('js/scirepl_matplotlib_backend.py');
        if (!matplotlibBackendResp.ok) throw new Error('Matplotlib inline backend could not be loaded');
        this._pyodide.FS.writeFile('/home/pyodide/scirepl_matplotlib_backend.py',
            await matplotlibBackendResp.text());

        // Load the prelude
        const preludeResp = await fetch('js/prelude.py');
        const preludeCode = await preludeResp.text();
        await this._pyodide.runPythonAsync(preludeCode);

        // Load SharedVFS bridge as an importable module
        const bridgeResp = await fetch('js/sharedfs.py');
        const bridgeCode = await bridgeResp.text();
        // Write sharedfs.py into Pyodide's filesystem so `import sharedfs` works
        this._pyodide.FS.writeFile('/home/pyodide/sharedfs.py', bridgeCode);

        // Create shared directories in Pyodide's filesystem
        try { this._pyodide.FS.mkdirTree('/shared/data'); } catch (_) { }
        try { this._pyodide.FS.mkdirTree('/shared/lib'); } catch (_) { }
        try { this._pyodide.FS.mkdirTree('/tmp'); } catch (_) { }

        // Sync Python modules from SharedVFS /shared/lib/python/ into Pyodide FS
        // so `import <module>` works natively
        this._syncSharedPythonModules();

        // Add the sync directory to sys.path
        await this._pyodide.runPythonAsync(`
import sys
_pkg_dir = '/home/pyodide/shared_lib_python'
if _pkg_dir not in sys.path:
    sys.path.insert(0, _pkg_dir)
del _pkg_dir
`);

        this._ready = true;
        if (km?.markRuntimeCacheComplete) {
            await km.markRuntimeCacheComplete('python');
        }
        if (km) km.hideDownloadModal();
    }

    isReady() {
        return this._ready;
    }

    getPackageIndex() {
        return this._packageIndex?.info?.version === this._pyodide?.version ? this._packageIndex : null;
    }

    getName() {
        return 'Python 3 (Pyodide)';
    }

    getLanguage() {
        return 'python';
    }

    getMemoryUsage() {
        if (!this._pyodide) return null;
        try {
            return this._pyodide._module.HEAPU8.buffer.byteLength;
        } catch (_) { return null; }
    }

    // ── SharedVFS Sync ──────────────────────────────────────────

    /**
     * Sync files from SharedVFS → Pyodide FS (before execution).
     * Only syncs files that are new or changed since last sync.
     */
    _syncToPyodide() {
        const vfs = window.sharedVFS;
        if (!vfs) return;
        const FS = this._pyodide.FS;

        for (const prefix of ['/shared', '/tmp']) {
            for (const [path, entry] of vfs._files) {
                if (!path.startsWith(prefix + '/')) continue;
                const lastSynced = this._syncedToPyodide.get(path);
                if (lastSynced && lastSynced >= entry.modified) continue;

                // Ensure parent directory exists
                const dir = path.substring(0, path.lastIndexOf('/'));
                try { FS.mkdirTree(dir); } catch (_) { /* exists */ }

                try {
                    if (entry.content instanceof Uint8Array) {
                        FS.writeFile(path, entry.content);
                    } else {
                        FS.writeFile(path, String(entry.content));
                    }
                    this._syncedToPyodide.set(path, entry.modified);
                } catch (e) {
                    console.warn('[PythonKernel] sync to Pyodide failed:', path, e);
                }
            }
        }
    }

    /**
     * Sync files from Pyodide FS → SharedVFS (after execution).
     * Walks /shared and /tmp, writes any new/changed files back.
     */
    _syncFromPyodide() {
        const vfs = window.sharedVFS;
        if (!vfs) return;
        const FS = this._pyodide.FS;

        let synced = 0;
        for (const prefix of ['/shared', '/tmp']) {
            synced += this._syncDirFromPyodide(prefix, FS, vfs);
        }
        if (synced > 0) {
            console.log('[PythonKernel] _syncFromPyodide:', synced, 'file(s) synced to SharedVFS');
        }
    }

    _syncDirFromPyodide(dirPath, FS, vfs) {
        let entries;
        try {
            entries = FS.readdir(dirPath).filter(n => n !== '.' && n !== '..');
        } catch (e) {
            console.log('[PythonKernel] _syncDir: cannot readdir', dirPath, e.message || e);
            return 0;
        }

        let count = 0;
        for (const name of entries) {
            const fullPath = dirPath + '/' + name;
            try {
                const stat = FS.stat(fullPath);
                if (FS.isDir(stat.mode)) {
                    count += this._syncDirFromPyodide(fullPath, FS, vfs);
                } else {
                    const data = FS.readFile(fullPath);
                    // Check if file differs from SharedVFS
                    const existing = vfs._files.get(fullPath);
                    if (existing) {
                        const existingBytes = existing.content instanceof Uint8Array
                            ? existing.content
                            : new TextEncoder().encode(String(existing.content));
                        if (existingBytes.length === data.length) {
                            let same = true;
                            for (let i = 0; i < data.length; i++) {
                                if (existingBytes[i] !== data[i]) { same = false; break; }
                            }
                            if (same) continue;
                        }
                    }
                    vfs.writeFile(fullPath, new Uint8Array(data), 'python');
                    this._syncedToPyodide.set(fullPath, Date.now());
                    count++;
                }
            } catch (e) {
                console.warn('[PythonKernel] _syncDir error on', fullPath, ':', e.message || e);
            }
        }
        return count;
    }

    /**
     * Execute Python code. Returns { stdout, result, error }.
     *
     * The `result` may be a raw Pyodide proxy object (for SymPy detection etc).
     * Callers should use the helper methods to check/render results.
     */
    async execute(code) {
        if (!this._ready) {
            throw new Error(window.t('kernel.pythonNotInitialized'));
        }

        const pyodide = this._pyodide;

        // Sync SharedVFS → Pyodide before execution
        this._syncToPyodide();

        // Redirect stdout
        pyodide.runPython(`
import io, sys
_sci_repl_stdout = io.StringIO()
_sci_repl_old_stdout = sys.stdout
sys.stdout = _sci_repl_stdout
`);

        let result, error;
        try {
            result = await pyodide.runPythonAsync(code);
        } catch (err) {
            error = err.message;
        }

        // Restore stdout and capture printed output
        try {
            pyodide.runPython(`sys.stdout = _sci_repl_old_stdout`);
        } catch (_) { }

        let stdout = '';
        try {
            stdout = pyodide.runPython(`_sci_repl_stdout.getvalue()`);
        } catch (_) { }

        // Sync Pyodide → SharedVFS after execution
        this._syncFromPyodide();

        if (error) {
            return { stdout, result: null, error };
        }

        // Check for output suppression (trailing ;)
        const suppressOutput = code.trimEnd().endsWith(';');

        // Format the result
        let formattedResult = null;
        if (result !== undefined && result !== null && !suppressOutput) {
            formattedResult = this._formatResult(result);
        }

        return { stdout, result: formattedResult, error: null };
    }

    /**
     * Format a Python result for display.
     * Returns { type: 'latex'|'text', content: string } or null.
     */
    _formatResult(result) {
        const pyodide = this._pyodide;

        try {
            pyodide.globals.set('_last_result', result);

            // Check SymPy list first
            const isSympyList = pyodide.runPython(`_is_sympy_list(_last_result)`);
            if (isSympyList) {
                const tex = pyodide.runPython(`_sympy_list_to_latex(_last_result)`);
                return { type: 'latex', content: tex };
            }

            // Check SymPy expression
            const isSympy = pyodide.runPython(`_is_sympy(_last_result)`);
            if (isSympy) {
                const tex = pyodide.runPython(`_sympy_to_latex(_last_result)`);
                return { type: 'latex', content: tex };
            }

            // Plain text
            let resultStr = result.toString();
            const MAX_OUTPUT = 10000;
            if (resultStr.length > MAX_OUTPUT) {
                resultStr = resultStr.substring(0, MAX_OUTPUT) +
                    '\n... (output truncated, ' + resultStr.length + ' chars total)';
            }

            if (resultStr !== 'None' && resultStr !== '') {
                return { type: 'text', content: resultStr };
            }
        } catch (e) {
            // If formatting fails, try basic toString
            try {
                const s = result.toString();
                if (s && s !== 'None') return { type: 'text', content: s };
            } catch (_) { }
        }

        return null;
    }

    /**
     * Copy .py files from SharedVFS /shared/lib/python/ into Pyodide's FS
     * so they are importable via `import <module>`.
     */
    _syncSharedPythonModules() {
        const vfs = window.sharedVFS;
        if (!vfs) return;

        const syncDir = '/home/pyodide/shared_lib_python';
        try { this._pyodide.FS.mkdir(syncDir); } catch (_) { /* exists */ }

        const entries = vfs.listDir('/shared/lib/python');
        if (!entries) return;

        for (const name of entries) {
            if (!name.endsWith('.py')) continue;
            const content = vfs.readFile('/shared/lib/python/' + name, 'utf8');
            if (content != null) {
                this._pyodide.FS.writeFile(syncDir + '/' + name, content);
            }
        }
    }

    /**
     * Get the raw Pyodide instance (for advanced usage like bridge functions).
     */
    getPyodide() {
        return this._pyodide;
    }

    /**
     * VFS adapter — exposes Pyodide's Emscripten FS with the same interface
     * as PrologVFS so the Files & Storage panel can browse it.
     */
    getVFS() {
        if (!this._pyodide) return null;
        if (this._vfs) return this._vfs;

        const FS = this._pyodide.FS;
        this._vfs = {
            getTree(basePath, depth) {
                basePath = basePath || '/shared';
                depth = depth || 0;
                const MAX_DEPTH = 5;
                const entries = [];
                if (depth > MAX_DEPTH) return entries;

                let items;
                try {
                    items = FS.readdir(basePath).filter(n => n !== '.' && n !== '..');
                } catch (_) {
                    return entries;
                }

                for (const name of items) {
                    const fullPath = basePath + '/' + name;
                    try {
                        const stat = FS.stat(fullPath);
                        const isDir = FS.isDir(stat.mode);
                        entries.push({
                            path: fullPath,
                            name,
                            type: isDir ? 'dir' : 'file',
                            size: isDir ? 0 : stat.size,
                            depth
                        });
                        if (isDir) {
                            entries.push(...this.getTree(fullPath, depth + 1));
                        }
                    } catch (_) { }
                }
                return entries;
            },

            readFile(path, encoding) {
                return FS.readFile(path, { encoding: encoding || 'utf8' });
            },

            writeFile(path, content) {
                // Ensure parent dir exists
                const dir = path.substring(0, path.lastIndexOf('/'));
                if (dir) try { FS.mkdirTree(dir); } catch (_) { }
                FS.writeFile(path, content);
            },

            removeFile(path) {
                try { FS.unlink(path); } catch (e) {
                    console.warn('PythonVFS removeFile:', e.message);
                }
            }
        };
        return this._vfs;
    }

    async destroy() {
        this._pyodide = null;
        this._ready = false;
    }
}

PythonKernel.displayName = 'Python';

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('python', PythonKernel);
}
