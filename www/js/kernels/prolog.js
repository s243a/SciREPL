/**
 * kernels/prolog.js — SWI-Prolog kernel using swipl-wasm (WebAssembly).
 * Loads from GitHub Pages CDN. Supports queries, assertions, consult,
 * virtual filesystem, search paths, and URL-based file fetching.
 */

class PrologKernel {
    constructor() {
        this._swipl = null;
        this._vfs = null;
        this._ready = false;
        this._loading = false;
        this._stdoutBuffer = [];
        this._stderrBuffer = [];
    }

    /**
     * Pinned swipl-wasm version. Used unless the user overrides via the
     * `scirepl_swipl_version` localStorage setting (e.g. set to "latest"
     * or another tag like "9.3.32" to opt into a different release).
     *
     * Bump this together with CDN_CACHE in sw.js when upgrading, so
     * stale cached swipl-wasm assets get evicted.
     *
     * Format: a path segment under https://SWI-Prolog.github.io/npm-swipl-wasm/3/
     * e.g. "latest" or a numeric version like "9.3.32".
     */
    static DEFAULT_SWIPL_VERSION = 'latest';

    static cdnUrl() {
        const version = (typeof localStorage !== 'undefined'
            && localStorage.getItem('scirepl_swipl_version'))
            || PrologKernel.DEFAULT_SWIPL_VERSION;
        return `https://SWI-Prolog.github.io/npm-swipl-wasm/3/${version}/dynamic-import.js`;
    }

    async init() {
        if (this._ready) return;
        if (this._loading) {
            // Wait for in-progress loading
            while (this._loading) {
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }

        const km = window.kernelManager;
        this._loading = true;
        try {
            const cdnUrl = PrologKernel.cdnUrl();
            console.log(`[PrologKernel] Loading swipl-wasm from ${cdnUrl}`);
            if (km) km.updateProgress('Downloading Prolog runtime...');
            const module = await import(cdnUrl);
            const SWIPL = module.SWIPL || module.default;
            const self = this;

            if (km) km.updateProgress('Initializing Prolog...');
            this._swipl = await SWIPL({
                arguments: ['-q'],
                print: (text) => { self._stdoutBuffer.push(text); },
                printErr: (text) => { self._stderrBuffer.push(text); }
            });

            // Initialize VFS
            if (typeof PrologVFS !== 'undefined') {
                this._vfs = new PrologVFS(this._swipl);
                // Add default search path
                this._vfs.addSearchPath('user', '/user');
            }

            // Load prelude
            await this._loadPrelude();

            this._ready = true;
            if (km) km.hideDownloadModal();

            // Restore Prolog VFS state from IndexedDB (deferred from session restore)
            if (window.sessionManager && window.sessionManager.restorePrologState) {
                try {
                    await window.sessionManager.restorePrologState();
                } catch (e) {
                    console.warn('[PrologKernel] Failed to restore VFS state:', e);
                }
            }
        } catch (err) {
            if (km) km.hideDownloadModal();
            throw err;
        } finally {
            this._loading = false;
        }
    }

    /**
     * Load the Prolog prelude file into VFS and consult it.
     */
    async _loadPrelude() {
        try {
            const response = await fetch('js/prolog_prelude.pl');
            if (response.ok) {
                const prelude = await response.text();
                if (this._vfs) {
                    this._vfs.writeFile('/user/prelude.pl', prelude);
                } else {
                    // Fallback: write directly via FS
                    this._swipl.FS.mkdir('/user');
                    this._swipl.FS.writeFile('/user/prelude.pl', prelude);
                }
                this._swipl.prolog.query("consult('/user/prelude.pl').").once();
            }
        } catch (e) {
            console.warn('Failed to load Prolog prelude:', e);
        }
    }

    isReady() {
        return this._ready;
    }

    getMemoryUsage() {
        if (!this._swipl) return null;
        try {
            return this._swipl.HEAPU8?.buffer?.byteLength ?? null;
        } catch (_) { return null; }
    }

    getName() {
        return 'SWI-Prolog (WASM)';
    }

    getLanguage() {
        return 'prolog';
    }

    /**
     * Get the VFS instance for external access (settings UI, etc.)
     */
    getVFS() {
        return this._vfs;
    }

    /**
     * Get the raw swipl instance.
     */
    getSwipl() {
        return this._swipl;
    }

    /**
     * Execute Prolog code. Handles three cases:
     * 1. Directives (:- ...) — executed silently
     * 2. Assertions/consult (assert/retract/consult) — executed, confirm
     * 3. Queries — enumerate all solutions
     *
     * Also intercepts fetch_file/2 calls for URL-based file fetching.
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
            // Sync NotebookVFS cell properties into Emscripten FS
            this._syncNbToProlog();
            const results = await this._executeBlock(trimmed);
            // Sync files written by Prolog's native I/O to SharedVFS
            this._syncSharedPaths();
            // Sync NotebookVFS write-back
            this._syncNbFromProlog();
            return results;
        } catch (err) {
            return { stdout: '', result: null, error: err.message || String(err) };
        }
    }

    /**
     * Walk shared directories in Emscripten FS and mirror any files
     * to SharedVFS. Prolog's native file I/O (open/3, write/1) writes
     * directly to Emscripten FS, bypassing PrologVFS.writeFile(),
     * so SharedVFS never sees those files without this sync.
     */
    /**
     * Sync NotebookVFS cell properties into Emscripten FS.
     * Creates /nb/In[N]/.code, .output, .language, .type, .name.
     * This allows Prolog to read cell content via read_file_to_string/3.
     */
    _syncNbToProlog() {
        const nbvfs = window.notebookVFS;
        if (!nbvfs || !this._swipl) return;
        const FS = this._swipl.FS;
        const cells = window._cells || [];
        if (cells.length === 0) return;

        // Ensure /nb exists
        try { FS.mkdir('/nb'); } catch (_) { /* exists */ }

        const props = ['.code', '.output', '.language', '.type', '.name'];

        for (let i = 0; i < cells.length; i++) {
            const label = 'In[' + (i + 1) + ']';
            const cellDir = '/nb/' + label;
            try { FS.mkdir(cellDir); } catch (_) { /* exists */ }

            for (const prop of props) {
                const value = nbvfs._getCellProperty(i, prop);
                if (value !== null) {
                    try {
                        FS.writeFile(cellDir + '/' + prop, value);
                    } catch (_) { /* skip */ }
                }
            }

            // Named alias
            if (cells[i].name) {
                const namedDir = '/nb/' + cells[i].name;
                try { FS.mkdir(namedDir); } catch (_) { /* exists */ }
                for (const prop of props) {
                    const value = nbvfs._getCellProperty(i, prop);
                    if (value !== null) {
                        try {
                            FS.writeFile(namedDir + '/' + prop, value);
                        } catch (_) { /* skip */ }
                    }
                }
            }
        }
    }

    /**
     * Sync NotebookVFS properties from Emscripten FS back to NotebookVFS.
     * Detects files modified by Prolog under /nb/In[N]/ and writes back.
     */
    _syncNbFromProlog() {
        const nbvfs = window.notebookVFS;
        if (!nbvfs || !this._swipl) return;
        const FS = this._swipl.FS;
        const cells = window._cells || [];
        if (cells.length === 0) return;

        const writableProps = ['.code', '.language', '.type', '.name'];

        for (let i = 0; i < cells.length; i++) {
            // Check both In[N] and named cell directories
            const dirs = ['/nb/In[' + (i + 1) + ']'];
            if (cells[i].name) dirs.push('/nb/' + cells[i].name);

            for (const cellDir of dirs) {
                for (const prop of writableProps) {
                    try {
                        const data = FS.readFile(cellDir + '/' + prop, { encoding: 'utf8' });
                        const oldValue = nbvfs._getCellProperty(i, prop) || '';
                        if (data !== oldValue) {
                            nbvfs._setCellProperty(i, prop, data);
                        }
                    } catch (e) {
                        // File doesn't exist — skip
                    }
                }
            }
        }
    }

    _syncSharedPaths() {
        if (!window.sharedVFS || !this._swipl) return;
        const FS = this._swipl.FS;
        const sharedPrefixes = ['/tmp', '/shared', '/education', '/user/education'];

        for (const prefix of sharedPrefixes) {
            try {
                FS.stat(prefix);
            } catch (e) {
                continue; // directory doesn't exist in Emscripten FS
            }
            this._syncDir(FS, prefix);
        }
    }

    /**
     * Recursively sync a directory from Emscripten FS to SharedVFS.
     */
    _syncDir(FS, dirPath) {
        let entries;
        try {
            entries = FS.readdir(dirPath).filter(n => n !== '.' && n !== '..');
        } catch (e) {
            return;
        }

        for (const name of entries) {
            const fullPath = dirPath + '/' + name;
            try {
                const stat = FS.stat(fullPath);
                if (FS.isDir(stat.mode)) {
                    this._syncDir(FS, fullPath);
                } else {
                    // Skip temp consult files
                    if (name.startsWith('_cell_')) continue;
                    // Read from Emscripten FS and write to SharedVFS
                    const content = FS.readFile(fullPath);
                    window.sharedVFS.writeFile(fullPath, content, 'prolog');
                }
            } catch (e) {
                // Skip inaccessible entries
            }
        }
    }

    /**
     * Drain any captured stdout lines and append them to the output array.
     */
    _drainStdout(output) {
        if (this._stdoutBuffer.length > 0) {
            output.push(this._stdoutBuffer.join('\n'));
            this._stdoutBuffer = [];
        }
    }

    async _executeBlock(code) {
        const prolog = this._swipl.prolog;
        let output = [];
        let errorMsg = null;

        // Clear any residual stdout/stderr from previous execution
        this._stdoutBuffer = [];
        this._stderrBuffer = [];

        // Split into individual statements (clauses/queries) by period at end of line
        const statements = this._splitStatements(code);

        // If cell contains clause definitions (:- dynamic, rules with :-),
        // split into definition statements (consulted as a source file) and
        // query statements (executed normally). This handles mixed cells like:
        //   generate_dot(G, D) :- ...   % definition
        //   build_call_graph(...), writeln(...).  % query
        if (this._isProgramCell(statements)) {
            const defParts = [];
            const queryParts = [];
            for (const s of statements) {
                if (this._isDefinitionStatement(s.trim())) {
                    defParts.push(s);
                } else {
                    queryParts.push(s);
                }
            }

            // Consult the definition parts
            if (defParts.length > 0) {
                const consultResult = this._consultCell(defParts.join('\n'));
                if (consultResult.stdout && consultResult.stdout !== 'true.') {
                    output.push(consultResult.stdout);
                }
                if (consultResult.error) {
                    return consultResult;
                }
            }

            // If no query parts remain, we're done
            if (queryParts.length === 0) {
                const stdout = output.length > 0 ? output.join('\n') : 'true.';
                return { stdout, result: null, error: null };
            }

            // Replace statements with just the query parts for the loop below
            statements.length = 0;
            queryParts.forEach(q => statements.push(q));
        }

        for (const stmt of statements) {
            const trimmed = stmt.trim();
            if (!trimmed) continue;

            // Intercept wasm_call/3 calls: wasm_call(Module, Function, ArgsJson).
            const wasmMatch = this._matchWasmCall(trimmed);
            if (wasmMatch) {
                try {
                    const result = this._handleWasmCall(wasmMatch.module, wasmMatch.func, wasmMatch.args);
                    output.push(JSON.stringify(result));
                } catch (err) {
                    errorMsg = 'wasm_call error: ' + (err.message || String(err));
                    break;
                }
                continue;
            }

            // Intercept fetch_file/2 calls
            const fetchMatch = this._matchFetchFile(trimmed);
            if (fetchMatch) {
                try {
                    const localPath = await this._handleFetchFile(fetchMatch.url, fetchMatch.path);
                    output.push('Fetched: ' + localPath);
                } catch (err) {
                    errorMsg = 'fetch_file error: ' + (err.message || String(err));
                    break;
                }
                continue;
            }

            // Intercept list-based consult: ['../init', 'foo'].
            const listConsult = this._matchListConsult(trimmed);
            if (listConsult) {
                for (const filePath of listConsult) {
                    const resolved = this._resolveConsultPath(filePath);
                    if (resolved) {
                        try {
                            prolog.query(`consult('${resolved}').`).once();
                            output.push('true.');
                        } catch (err) {
                            errorMsg = `consult('${resolved}'): ${err.message || String(err)}`;
                            break;
                        }
                    } else {
                        errorMsg = `Cannot find file: ${filePath}`;
                        break;
                    }
                }
                if (errorMsg) break;
                continue;
            }

            // Intercept load_url/2 calls (fetch + consult)
            const loadMatch = this._matchLoadUrl(trimmed);
            if (loadMatch) {
                try {
                    const localPath = await this._handleFetchFile(loadMatch.url, loadMatch.path);
                    const consultQuery = `consult('${localPath}').`;
                    prolog.query(consultQuery).once();
                    output.push('Loaded: ' + localPath);
                } catch (err) {
                    errorMsg = 'load_url error: ' + (err.message || String(err));
                    break;
                }
                continue;
            }

            // Ensure statement ends with a period
            const query = trimmed.endsWith('.') ? trimmed : trimmed + '.';

            try {
                // Check if this is a directive (:- ...)
                // swipl-wasm's query API doesn't support :- syntax directly,
                // so strip it and execute the inner goal.
                if (trimmed.startsWith(':-')) {
                    let body = trimmed.substring(2).trim();
                    if (!body.endsWith('.')) body += '.';
                    const result = prolog.query(body).once();
                    this._drainStdout(output);
                    if (result.success === false) {
                        output.push('false.');
                    }
                    continue;
                }

                // Check if this is an assertion/retract/consult
                if (this._isAssertion(trimmed)) {
                    const result = prolog.query(query).once();
                    this._drainStdout(output);
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
                        // swipl-wasm may return errors as {error: true, message: "..."}
                        // instead of throwing. Re-throw so the catch block handles it.
                        if (val && val.error && val.message) {
                            throw new Error(val.message);
                        }
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

                // Capture any stdout from format/2, writeln/1, etc.
                this._drainStdout(output);

                if (solutions.length > 0) {
                    output.push(solutions.join('\n'));
                } else if (count === 0) {
                    output.push('false.');
                }

            } catch (err) {
                const msg = err.message || String(err);
                // Auto-create parent directories for open/3 write failures
                if (msg.includes('does not exist') && this._autoMkdir(trimmed)) {
                    // Retry the statement after creating directories
                    try {
                        const retryQ = trimmed.endsWith('.') ? trimmed : trimmed + '.';
                        const result = prolog.query(retryQ).once();
                        if (result.success !== false) {
                            output.push('true.');
                        } else {
                            output.push('false.');
                        }
                        continue;
                    } catch (retryErr) {
                        errorMsg = retryErr.message || String(retryErr);
                        break;
                    }
                }
                errorMsg = msg;
                break;
            }
        }

        const stdout = output.join('\n');

        if (errorMsg) {
            return { stdout, result: null, error: errorMsg };
        }

        return { stdout, result: null, error: null };
    }

    // ---- Auto-mkdir for open/3 ----

    /**
     * Try to extract a file path from a statement containing open/3 or open/4
     * and create its parent directory in the Emscripten FS.
     * Returns true if directories were created, false otherwise.
     */
    _autoMkdir(stmt) {
        // Match open('path', write, ...) or open("path", write, ...)
        const re = /open\s*\(\s*(['"])(.+?)\1/;
        const m = stmt.match(re);
        if (!m) return false;

        const filePath = m[2];
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash <= 0) return false;

        const dir = filePath.substring(0, lastSlash);
        try {
            // Resolve relative path using SWI-Prolog's working directory
            let absDir = dir;
            if (!dir.startsWith('/')) {
                try {
                    const r = this._swipl.prolog.query("working_directory(D, D).").once();
                    if (r.D) {
                        const wd = String(r.D).replace(/\/$/, '');
                        absDir = wd + '/' + dir;
                    }
                } catch (e) { /* use as-is */ }
            }

            // Normalize path (resolve ..)
            const parts = absDir.split('/');
            const resolved = [];
            for (const p of parts) {
                if (p === '..') resolved.pop();
                else if (p !== '' && p !== '.') resolved.push(p);
            }
            const normalizedDir = '/' + resolved.join('/');

            // Create directory tree via Emscripten FS
            const segs = normalizedDir.split('/').filter(Boolean);
            let current = '';
            for (const seg of segs) {
                current += '/' + seg;
                try { this._swipl.FS.mkdir(current); } catch (e) { /* exists */ }
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // ---- Program cell detection and consulting ----

    /**
     * Check if a code block is a "program" cell containing clause definitions.
     * Detected by:
     *   1. :- dynamic/discontiguous/multifile declarations
     *   2. Rule definitions (head :- body) — e.g., ancestor(X,Y) :- parent(X,Y).
     * A cell with any of these is consulted as a source file rather than
     * executed as queries.
     */
    _isProgramCell(statements) {
        return statements.some(s => {
            const t = s.trim();
            // Directive declaring program text
            if (/^:-\s*(dynamic|discontiguous|multifile)\b/.test(t)) return true;
            // Rule definition: starts with a functor, contains :- that's not at position 0
            // e.g., "ancestor(X, Y) :- parent(X, Y)." or "hello :- world."
            if (!t.startsWith(':-') && /^[a-z_]\w*[\s(]/.test(t) && /\)\s*:-|^[a-z_]\w*\s*:-/.test(t)) return true;
            return false;
        });
    }

    /**
     * Check if an individual statement is a clause definition (should be consulted)
     * rather than a query (should be executed).
     * Definitions: :- dynamic/discontiguous/multifile declarations,
     *              rule definitions (head :- body), bare facts (functor(args).)
     */
    _isDefinitionStatement(stmt) {
        const t = stmt.trim();
        // :- dynamic/discontiguous/multifile declarations
        if (/^:-\s*(dynamic|discontiguous|multifile)\b/.test(t)) return true;
        // Rule definition: functor(...) :- body
        if (!t.startsWith(':-') && /^[a-z_]\w*[\s(]/.test(t) && /\)\s*:-|^[a-z_]\w*\s*:-/.test(t)) return true;
        // Bare fact: functor(args). — but NOT a query like writeln(...) or format(...)
        // Facts start with a functor and have simple args (atoms/variables), no commas between goals
        // We check: starts with a functor, has balanced parens, and doesn't contain goal-like commas
        // This is heuristic — we exclude known query predicates
        if (/^[a-z_]\w*\(/.test(t) && !this._looksLikeQuery(t)) {
            // Check if it's a simple fact (no conjunction with other goals)
            // A fact has the form: functor(args).  with no top-level commas outside parens
            if (!this._hasTopLevelComma(t)) return true;
        }
        return false;
    }

    /**
     * Check if a statement looks like a query rather than a fact.
     */
    _looksLikeQuery(stmt) {
        const queryPreds = [
            'writeln', 'write', 'format', 'nl', 'print_message',
            'build_call_graph', 'find_sccs', 'generate_dot',
            'compile_recursive', 'compile_mutual_recursion', 'compile_tail_recursion',
            'is_tail_recursive_accumulator', 'is_linear_recursive_streamable',
            'is_mutual_transitive_closure', 'count_recursive_calls',
            'get_dependencies', 'get_dependents', 'predicates_in_group',
            'is_self_recursive', 'is_trivial_scc',
            'forall', 'findall', 'bagof', 'setof',
            'open', 'close', 'read', 'atom_string',
            'use_module', 'consult'
        ];
        return queryPreds.some(p => stmt.startsWith(p + '(') || stmt.startsWith(p + ' '));
    }

    /**
     * Check if a statement has a top-level comma (outside parentheses),
     * which indicates it's a conjunction of goals, not a simple fact.
     */
    _hasTopLevelComma(stmt) {
        let depth = 0;
        let inString = false;
        let stringChar = null;
        for (let i = 0; i < stmt.length; i++) {
            const ch = stmt[i];
            if (!inString && (ch === "'" || ch === '"')) {
                inString = true;
                stringChar = ch;
                continue;
            }
            if (inString && ch === stringChar) {
                inString = false;
                continue;
            }
            if (inString) continue;
            if (ch === '(' || ch === '[') depth++;
            else if (ch === ')' || ch === ']') depth--;
            else if (ch === ',' && depth === 0) return true;
        }
        return false;
    }

    /**
     * Consult a code block as a source file by writing to a temp file
     * in the Emscripten FS and consulting it. This ensures bare facts
     * are added to the database rather than treated as queries.
     */
    _consultCell(code) {
        const tmpPath = '/tmp/_cell_' + Date.now() + '.pl';
        const FS = this._swipl.FS;

        // Ensure /tmp exists
        try { FS.mkdir('/tmp'); } catch (e) { /* already exists */ }

        // Clear stdout buffer before consult
        this._stdoutBuffer = [];

        FS.writeFile(tmpPath, code);
        try {
            const result = this._swipl.prolog.query(`consult('${tmpPath}').`).once();
            const captured = this._stdoutBuffer.join('\n');
            this._stdoutBuffer = [];
            if (result.success === false) {
                return { stdout: captured || 'false.', result: null, error: null };
            }
            return { stdout: captured || 'true.', result: null, error: null };
        } catch (err) {
            const captured = this._stdoutBuffer.join('\n');
            this._stdoutBuffer = [];
            const errOut = captured ? captured + '\n' : '';
            return { stdout: errOut, result: null, error: err.message || String(err) };
        } finally {
            try { FS.unlink(tmpPath); } catch (e) { /* ignore */ }
        }
    }

    // ---- wasm_call interception ----

    /**
     * Match wasm_call(Module, Function, ArgsJson) pattern.
     * Returns {module, func, args} or null.
     */
    _matchWasmCall(stmt) {
        // wasm_call(module_name, func_name, '{"key": "value"}').
        const re = /^wasm_call\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(['"])(.+?)\3\s*\)\s*\.?$/;
        const m = stmt.match(re);
        if (m) {
            try {
                return { module: m[1], func: m[2], args: JSON.parse(m[4]) };
            } catch (e) {
                return { module: m[1], func: m[2], args: m[4] };
            }
        }
        return null;
    }

    /**
     * Execute a WASM module function via JSON FFI.
     */
    _handleWasmCall(moduleName, funcName, args) {
        if (!window.wasmModules || !window.wasmModules[moduleName]) {
            throw new Error(`WASM module '${moduleName}' not loaded`);
        }
        const mod = window.wasmModules[moduleName];
        if (!mod.call) {
            throw new Error(`WASM module '${moduleName}' does not support JSON FFI`);
        }
        return mod.call(funcName, args);
    }

    // ---- fetch_file / load_url interception ----

    /**
     * Match fetch_file('URL', 'Path') pattern in a statement.
     * Returns {url, path} or null.
     */
    _matchFetchFile(stmt) {
        // Match: fetch_file('...', '...') or fetch_file("...", "...")
        const re = /^fetch_file\s*\(\s*(['"])(.+?)\1\s*,\s*(['"])(.+?)\3\s*\)\s*\.?$/;
        const m = stmt.match(re);
        if (m) return { url: m[2], path: m[4] };
        return null;
    }

    /**
     * Match load_url('URL', 'Path') pattern.
     */
    _matchLoadUrl(stmt) {
        const re = /^load_url\s*\(\s*(['"])(.+?)\1\s*,\s*(['"])(.+?)\3\s*\)\s*\.?$/;
        const m = stmt.match(re);
        if (m) return { url: m[2], path: m[4] };
        return null;
    }

    /**
     * Match list-based consult syntax: ['path1', 'path2', ...].
     * Returns array of path strings, or null if not a list-consult.
     */
    _matchListConsult(stmt) {
        const s = stmt.endsWith('.') ? stmt.slice(0, -1).trim() : stmt;
        if (!s.startsWith('[') || !s.endsWith(']')) return null;
        const inner = s.slice(1, -1).trim();
        // Skip library(...) terms — those are use_module, not file consult
        if (/library\s*\(/.test(inner)) return null;
        // Parse comma-separated quoted strings
        const paths = [];
        const re = /['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(inner)) !== null) {
            paths.push(m[1]);
        }
        return paths.length > 0 ? paths : null;
    }

    /**
     * Resolve a consult path (possibly relative) to an absolute VFS path.
     * Tries known base directories for education notebooks.
     */
    _resolveConsultPath(filePath) {
        if (!this._vfs) return null;

        // Absolute path — check directly (with and without .pl)
        if (filePath.startsWith('/')) {
            if (this._vfs.exists(filePath)) return filePath;
            if (this._vfs.exists(filePath + '.pl')) return filePath + '.pl';
            return null;
        }

        // Relative path — try resolving from known base directories
        const baseDirs = [
            '/user/education/notebooks',
            '/user/education',
            '/user',
        ];

        for (const base of baseDirs) {
            const parts = (base + '/' + filePath).split('/');
            const resolved = [];
            for (const p of parts) {
                if (p === '..') resolved.pop();
                else if (p !== '' && p !== '.') resolved.push(p);
            }
            const abs = '/' + resolved.join('/');

            if (this._vfs.exists(abs)) return abs;
            if (this._vfs.exists(abs + '.pl')) return abs + '.pl';
        }

        return null;
    }

    /**
     * Fetch a URL and write to VFS.
     */
    async _handleFetchFile(url, localPath) {
        if (this._vfs) {
            return await this._vfs.fetchFile(url, localPath);
        }

        // Fallback without VFS
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }
        const text = await response.text();

        // Ensure parent dir
        const dir = localPath.substring(0, localPath.lastIndexOf('/'));
        if (dir) {
            try { this._swipl.FS.mkdirTree(dir); } catch (e) { /* ignore */ }
        }
        this._swipl.FS.writeFile(localPath, text);
        return localPath;
    }

    // ---- Statement parsing ----

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
            // Skip internal properties and error metadata
            if (key === 'success' || key === 'done' || key === 'error' || key === 'message' || key.startsWith('$')) continue;
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
        this._vfs = null;
        this._swipl = null;
        this._ready = false;
    }
}

PrologKernel.displayName = 'Prolog';

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('prolog', PrologKernel);
}
