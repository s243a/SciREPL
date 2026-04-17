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

    getMemoryUsage() {
        if (!this._shell) return null;
        return null;
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
     * Rewrite `tee >(CMD)` output process substitution, which Brush WASM does
     * not currently handle (causes the shell to hang). Uses a temp file to
     * emulate the semantics: capture stdin, then feed each consumer in turn,
     * then pass through to the original redirect target.
     *
     * Input:  X | tee >(CMD1) >(CMD2) REDIR
     * Output: X | { __t=$(mktemp); cat > "$__t"; (CMD1) < "$__t"; (CMD2) < "$__t"; cat "$__t" REDIR; rm -f "$__t"; }
     *
     * Limitations:
     *   - Simple paren-depth parsing; does not track strings or escapes inside
     *     the sub-command. Pathological cases like >(grep ")") are not handled.
     *   - Sub-commands run sequentially, not concurrently like real tee, so
     *     timing-sensitive pipelines may behave differently. For boolean
     *     checks (grep -q, etc.) this is fine.
     */
    _rewriteTeeProcessSub(code) {
        const TEE_RE = /\btee\s+>\s*\(/;
        let result = '';
        let i = 0;
        let counter = 0;

        while (i < code.length) {
            const remaining = code.substring(i);
            const m = remaining.match(TEE_RE);
            if (!m) {
                result += remaining;
                break;
            }

            const teeStart = i + m.index;
            const afterOpen = teeStart + m[0].length; // right after "tee >("

            // Emit everything up to "tee"
            result += code.substring(i, teeStart);

            // Parse the >(...) sub-command(s) using paren-depth tracking.
            let j = afterOpen;
            const subCommands = [];
            let depth = 1;
            let subStart = j;
            while (j < code.length && depth > 0) {
                const ch = code[j];
                if (ch === '(') {
                    depth++;
                } else if (ch === ')') {
                    depth--;
                    if (depth === 0) {
                        subCommands.push(code.substring(subStart, j));
                        j++;
                        // Look for another >(...) continuation.
                        let k = j;
                        while (k < code.length && /\s/.test(code[k])) k++;
                        if (code.substring(k, k + 2) === '>(') {
                            j = k + 2;
                            depth = 1;
                            subStart = j;
                            continue;
                        } else {
                            break;
                        }
                    }
                }
                j++;
            }

            if (depth !== 0) {
                // Unbalanced parens — give up, emit original and bail.
                result += code.substring(teeStart);
                break;
            }

            // Capture the rest of the pipeline stage (redirects etc.) up to
            // a pipe, semicolon, newline, or end of string.
            let k = j;
            while (k < code.length) {
                const ch = code[k];
                if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') break;
                k++;
            }
            const restRedir = code.substring(j, k).trim();

            // Build the replacement. Use a compound command so the rewrite
            // fits inside a pipeline (... | { ...; }).
            counter++;
            const t = `__tee_${counter}`;
            const parts = [`${t}=$(mktemp)`, `cat > "$${t}"`];
            for (const sub of subCommands) {
                // Wrap sub-command in parens so it runs in a subshell, and
                // connect its stdin to our temp file.
                parts.push(`( ${sub} ) < "$${t}"`);
            }
            // Pass-through: apply whatever redirect tee originally had.
            if (restRedir) {
                parts.push(`cat "$${t}" ${restRedir}`);
            } else {
                parts.push(`cat "$${t}"`);
            }
            parts.push(`rm -f "$${t}"`);
            const replacement = '{ ' + parts.join('; ') + '; }';

            result += replacement;
            i = k;
        }

        return result;
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
        // NOTE: tee >(...) was previously rewritten here as a workaround for a
        // Brush hang. The Brush WASM now handles Write process substitution
        // correctly via temp-file + deferred execution, so the workaround is
        // no longer needed. _rewriteTeeProcessSub remains as a fallback if
        // needed in the future.

        // Timeout so unsupported Brush features don't hang the cell forever.
        // Can be overridden per-call via window._bashKernelTimeoutMs.
        const timeoutMs = (typeof window !== 'undefined' && window._bashKernelTimeoutMs) || 30000;

        try {
            const executionPromise = this._shell.execute(resolved);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(
                    `Bash execution timed out after ${timeoutMs}ms. ` +
                    `The shell may have hit an unsupported feature (e.g. tee >(...), ` +
                    `complex process substitution, or missing external command). ` +
                    `Shell state may be unusable — consider calling reset().`
                )), timeoutMs)
            );
            const result = await Promise.race([executionPromise, timeoutPromise]);

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
            // After a timeout, the shell may still have an in-flight execute promise
            // and be in a bad state. Auto-reset so subsequent cells don't also hang.
            const isTimeout = err.message && err.message.includes('timed out');
            if (isTimeout) {
                try {
                    await this.reset();
                    console.warn('[BashKernel] Shell was reset after execution timeout');
                } catch (resetErr) {
                    console.error('[BashKernel] Failed to reset after timeout:', resetErr);
                }
            }
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
