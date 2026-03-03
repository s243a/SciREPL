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

    async init() {
        if (this._ready) return;

        // loadPyodide must be available globally (loaded by index.html)
        if (typeof loadPyodide === 'undefined') {
            throw new Error('Pyodide script not loaded. Accept privacy policy first.');
        }

        this._pyodide = await loadPyodide();
        await this._pyodide.loadPackage(['numpy', 'sympy']);
        await this._pyodide.loadPackage('micropip');

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

        for (const prefix of ['/shared', '/tmp']) {
            this._syncDirFromPyodide(prefix, FS, vfs);
        }
    }

    _syncDirFromPyodide(dirPath, FS, vfs) {
        let entries;
        try {
            entries = FS.readdir(dirPath).filter(n => n !== '.' && n !== '..');
        } catch (_) {
            return;
        }

        for (const name of entries) {
            const fullPath = dirPath + '/' + name;
            try {
                const stat = FS.stat(fullPath);
                if (FS.isDir(stat.mode)) {
                    this._syncDirFromPyodide(fullPath, FS, vfs);
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
                }
            } catch (_) {
                // Skip inaccessible entries
            }
        }
    }

    /**
     * Execute Python code. Returns { stdout, result, error }.
     *
     * The `result` may be a raw Pyodide proxy object (for SymPy detection etc).
     * Callers should use the helper methods to check/render results.
     */
    async execute(code) {
        if (!this._ready) {
            throw new Error('Python kernel not initialized');
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
