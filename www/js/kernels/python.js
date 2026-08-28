/**
 * kernels/python.js — Python kernel using Pyodide (WebAssembly).
 * Manages Pyodide initialization, prelude loading, stdout capture,
 * SymPy detection, and code execution.
 */

class PythonKernel {
    constructor() {
        this._pyodide = null;
        this._ready = false;
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

    async init() {
        if (this._ready) return;

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
        // indexURL = directory containing pyodide.js, so package wheels load from
        // the same source (local vendor dir or CDN) that served the loader.
        const indexURL = pyodideJsUrl.replace(/[^/]*$/, '');
        this._pyodide = await loadPyodide({ indexURL });
        await this._pyodide.loadPackage(['numpy', 'sympy']);
        await this._pyodide.loadPackage('micropip');

        if (km) km.updateProgress(window.t('runtime.loadingHelpers'));

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

        // Capture the genuine globals dictionary and trusted helpers before
        // user code can shadow names such as globals, str, or json. Calling
        // this later reads bounded dictionary KEYS only: no dir(obj), repr,
        // value access, or user-defined descriptor can run while refreshing
        // the completion snapshot.
        this._completionNames = this._pyodide.runPython(`
(lambda _g=globals(), _dumps=__import__('json').dumps,
        _islice=__import__('itertools').islice,
        _type=type, _str=str, _len=len, _list=list:
  lambda: _dumps(_list(_islice(
    (_n for _n in _g
      if _type(_n) is _str and _len(_n) <= 128 and _str.isidentifier(_n)),
    4096)), ensure_ascii=False)
)()
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

    /** Cached-completion refresh hook. Never called from the typing path. */
    completionSymbols() {
        if (!this._ready || !this._completionNames) return [];
        return JSON.parse(String(this._completionNames()));
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
        if (this._completionNames && typeof this._completionNames.destroy === 'function') {
            this._completionNames.destroy();
        }
        this._completionNames = null;
        this._pyodide = null;
        this._ready = false;
    }
}

PythonKernel.displayName = 'Python';

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('python', PythonKernel);
}
