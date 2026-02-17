/**
 * kernels/prolog.js — SWI-Prolog kernel using swipl-wasm (WebAssembly).
 * Loads from GitHub Pages CDN. Supports queries, assertions, and consult.
 */

class PrologKernel {
    constructor() {
        this._swipl = null;
        this._ready = false;
        this._loading = false;
    }

    /**
     * CDN URL for swipl-wasm single-file bundle.
     * Using dynamic-import.js which embeds .wasm + .data in one file.
     */
    static CDN_URL = 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/latest/dynamic-import.js';

    async init() {
        if (this._ready) return;
        if (this._loading) {
            // Wait for in-progress loading
            while (this._loading) {
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }

        this._loading = true;
        try {
            const module = await import(PrologKernel.CDN_URL);
            const SWIPL = module.SWIPL || module.default;
            this._swipl = await SWIPL({ arguments: ['-q'] });
            this._ready = true;
        } finally {
            this._loading = false;
        }
    }

    isReady() {
        return this._ready;
    }

    getName() {
        return 'SWI-Prolog (WASM)';
    }

    getLanguage() {
        return 'prolog';
    }

    /**
     * Execute Prolog code. Handles three cases:
     * 1. Directives (:- ...) — executed silently
     * 2. Assertions/consult (assert/retract/consult) — executed, confirm
     * 3. Queries — enumerate all solutions
     *
     * Returns { stdout, result, error }
     */
    async execute(code) {
        if (!this._ready) {
            throw new Error('Prolog kernel not initialized');
        }

        const trimmed = code.trim();
        if (!trimmed) {
            return { stdout: '', result: null, error: null };
        }

        try {
            // Handle multi-line input: split by '.\n' for multiple clauses
            // But first check if it looks like a single query vs. multiple assertions
            const results = this._executeBlock(trimmed);
            return results;
        } catch (err) {
            return { stdout: '', result: null, error: err.message || String(err) };
        }
    }

    _executeBlock(code) {
        const prolog = this._swipl.prolog;
        let output = [];
        let errorMsg = null;

        // Split into individual statements (clauses/queries) by period at end of line
        const statements = this._splitStatements(code);

        for (const stmt of statements) {
            const trimmed = stmt.trim();
            if (!trimmed) continue;

            // Ensure statement ends with a period
            const query = trimmed.endsWith('.') ? trimmed : trimmed + '.';

            try {
                // Check if this is a directive (:- ...)
                if (trimmed.startsWith(':-')) {
                    const result = prolog.query(query).once();
                    if (result.success === false) {
                        output.push('false.');
                    }
                    continue;
                }

                // Check if this is an assertion/retract/consult
                if (this._isAssertion(trimmed)) {
                    const result = prolog.query(query).once();
                    if (result.success) {
                        output.push('true.');
                    } else {
                        output.push('false.');
                    }
                    continue;
                }

                // It's a query — enumerate solutions using manual iteration.
                // Note: swipl-wasm may return the last solution with done:true,
                // so for...of would miss it. We use .next() explicitly.
                const solutions = [];
                let count = 0;
                const MAX_SOLUTIONS = 100;
                const q = prolog.query(query);

                try {
                    let step = q.next();
                    while (true) {
                        // Check if we got a value (even if done is true)
                        const val = step.value || step;
                        if (val && val.success !== false) {
                            count++;
                            if (count > MAX_SOLUTIONS) {
                                solutions.push('... (limited to ' + MAX_SOLUTIONS + ' solutions)');
                                break;
                            }
                            const bindings = this._formatBindings(val);
                            if (bindings) {
                                solutions.push(bindings);
                            }
                        }
                        if (step.done) break;
                        step = q.next();
                    }
                } finally {
                    if (q.close) q.close();
                }

                if (solutions.length > 0) {
                    output.push(solutions.join('\n'));
                } else {
                    // No bindings found — report success/failure
                    output.push(count > 0 ? 'true.' : 'false.');
                }

            } catch (err) {
                errorMsg = err.message || String(err);
                break;
            }
        }

        const stdout = output.join('\n');

        if (errorMsg) {
            return { stdout, result: null, error: errorMsg };
        }

        return { stdout, result: null, error: null };
    }

    /**
     * Split Prolog source into individual statements.
     * Handles multi-line clauses by looking for period followed by whitespace/EOF.
     */
    _splitStatements(code) {
        const statements = [];
        let current = '';
        let inString = false;
        let stringChar = null;

        for (let i = 0; i < code.length; i++) {
            const ch = code[i];
            const next = code[i + 1];

            // Track string literals
            if (!inString && (ch === "'" || ch === '"')) {
                inString = true;
                stringChar = ch;
                current += ch;
                continue;
            }
            if (inString && ch === stringChar) {
                // Check for escaped quote
                if (next === stringChar) {
                    current += ch + next;
                    i++;
                    continue;
                }
                inString = false;
                current += ch;
                continue;
            }

            if (inString) {
                current += ch;
                continue;
            }

            // Handle % line comments
            if (ch === '%') {
                while (i < code.length && code[i] !== '\n') i++;
                continue;
            }

            // Handle /* block comments */
            if (ch === '/' && next === '*') {
                i += 2;
                while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
                i++; // skip closing /
                continue;
            }

            current += ch;

            // Period followed by whitespace or EOF = end of statement
            if (ch === '.' && (next === undefined || next === '\n' || next === '\r' || next === ' ' || next === '\t')) {
                const trimmed = current.trim();
                if (trimmed) {
                    statements.push(trimmed);
                }
                current = '';
            }
        }

        // Remaining text (query without trailing period)
        const remaining = current.trim();
        if (remaining) {
            statements.push(remaining);
        }

        return statements;
    }

    /**
     * Check if a statement is an assertion/database modification.
     */
    _isAssertion(stmt) {
        const patterns = [
            /^assert[az]?\s*\(/,
            /^retract[a]?\s*\(/,
            /^abolish\s*\(/,
            /^consult\s*\(/,
            /^use_module\s*\(/,
            /^:- /
        ];
        return patterns.some(p => p.test(stmt));
    }

    /**
     * Format query result bindings as a readable string.
     * Skips internal/system variables.
     */
    _formatBindings(result) {
        const bindings = [];
        for (const [key, value] of Object.entries(result)) {
            // Skip internal properties
            if (key === 'success' || key === 'done' || key.startsWith('$')) continue;
            // Skip anonymous variables
            if (key.startsWith('_')) continue;

            bindings.push(key + ' = ' + this._formatValue(value));
        }

        if (bindings.length === 0) return null;
        return bindings.join(', ');
    }

    /**
     * Format a Prolog value for display.
     */
    _formatValue(value) {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (Array.isArray(value)) {
            return '[' + value.map(v => this._formatValue(v)).join(', ') + ']';
        }
        if (typeof value === 'object' && value.functor) {
            // Compound term
            if (value.args && value.args.length > 0) {
                return value.functor + '(' + value.args.map(a => this._formatValue(a)).join(', ') + ')';
            }
            return value.functor;
        }
        return String(value);
    }

    async destroy() {
        this._swipl = null;
        this._ready = false;
    }
}

PrologKernel.displayName = 'Prolog';

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('prolog', PrologKernel);
}
