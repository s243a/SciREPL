/**
 * kernels/bash.js — Bash kernel using brush-wasm (WebAssembly).
 * Provides a bash-compatible shell with declare -A, arithmetic,
 * functions, pipes between builtins, and all standard bash features.
 *
 * Loads brush_wasm.wasm (~4.3 MB) on first use.
 */

class BashKernel {
    constructor() {
        this._shell = null;
        this._ready = false;
        this._loading = false;
        this._module = null;
    }

    static displayName = 'Bash';

    async init() {
        if (this._ready) return;
        if (this._loading) {
            while (this._loading) {
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }

        this._loading = true;
        try {
            // Load the ES module via dynamic import
            const module = await import('../../vendor/brush/brush_wasm.js');
            this._module = module;

            // Initialize the WASM binary
            const initFn = module.default || module.__wbg_init;
            await initFn();

            // Create a persistent shell instance
            this._shell = await module.BrushShell.create();
            this._ready = true;
            console.log('[BashKernel] Ready (brush-wasm)');
        } catch (err) {
            console.error('[BashKernel] Init failed:', err);
            throw err;
        } finally {
            this._loading = false;
        }
    }

    isReady() {
        return this._ready;
    }

    getName() {
        return 'Bash (WASM)';
    }

    getLanguage() {
        return 'bash';
    }

    /**
     * Resolve `source <path>` commands by reading from Prolog VFS and inlining.
     * Only needed for /user/ paths (not shared paths — those are handled
     * natively via SharedVFS + Rust VFS hooks).
     */
    _resolveBashSources(code) {
        const prologKernel = window.kernelManager &&
            window.kernelManager._instances &&
            window.kernelManager._instances.prolog;
        if (!prologKernel) return code;
        const swipl = prologKernel.getSwipl && prologKernel.getSwipl();
        if (!swipl || !swipl.FS) return code;

        let prologWd = '/';
        try {
            const r = swipl.prolog.query("working_directory(D, D).").once();
            if (r.D) prologWd = String(r.D).replace(/\/$/, '');
        } catch (e) { /* use default */ }

        return code.replace(/^(\s*)(source|\.)\s+([^\s;#]+)/gm, (match, indent, cmd, filePath) => {
            let absPath = filePath;
            if (!filePath.startsWith('/')) {
                absPath = prologWd + '/' + filePath;
            }
            const parts = absPath.split('/');
            const resolved = [];
            for (const p of parts) {
                if (p === '..') resolved.pop();
                else if (p !== '' && p !== '.') resolved.push(p);
            }
            absPath = '/' + resolved.join('/');

            // For shared paths, rewrite to use the absolute path so brush
            // resolves it correctly (bash CWD may differ from Prolog CWD)
            if (absPath.startsWith('/tmp/') || absPath.startsWith('/shared/') || absPath.startsWith('/education/') || absPath.startsWith('/user/education/')) {
                return indent + cmd + ' ' + absPath;
            }

            try {
                const content = swipl.FS.readFile(absPath, { encoding: 'utf8' });
                return indent + '# [inlined from ' + filePath + ']\n' + content;
            } catch (e) {
                return match;
            }
        });
    }

    /**
     * Execute bash code. Returns { stdout, result, error }.
     * Shell state persists across calls — variables, functions,
     * aliases from previous cells are available.
     */
    async execute(code) {
        if (!this._ready || !this._shell) {
            throw new Error('Bash kernel not initialized');
        }

        const trimmed = code.trim();
        if (!trimmed) {
            return { stdout: '', result: null, error: null };
        }

        // Resolve source commands that reference Prolog VFS (/user/ paths)
        const resolved = this._resolveBashSources(trimmed);

        try {
            const result = await this._shell.execute(resolved);

            const stdout = result.stdout || '';
            const stderr = result.stderr || '';
            const exitCode = result.exit_code;

            // Format output similar to other kernels
            let output = stdout;
            if (stderr) {
                output += (output ? '\n' : '') + stderr;
            }

            if (exitCode !== 0 && !stderr) {
                return {
                    stdout: output,
                    result: null,
                    error: `Exit code: ${exitCode}`
                };
            }

            if (stderr) {
                return {
                    stdout: stdout,
                    result: null,
                    error: stderr
                };
            }

            return {
                stdout: output,
                result: null,
                error: null
            };
        } catch (err) {
            return {
                stdout: '',
                result: null,
                error: err.message || String(err)
            };
        }
    }

    /**
     * Reset the shell to a clean state.
     */
    async reset() {
        if (this._shell) {
            this._shell.free();
        }
        if (this._module) {
            this._shell = await this._module.BrushShell.create();
        }
    }

    destroy() {
        if (this._shell) {
            this._shell.free();
            this._shell = null;
        }
        this._ready = false;
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('bash', BashKernel);
}
