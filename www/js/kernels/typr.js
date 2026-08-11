/**
 * kernels/typr.js — TypR kernel (typed R superset).
 *
 * Compiles TypR source to R via the typr-wasm compiler, then
 * executes the generated R code through the R kernel (webR).
 *
 * Two-phase: TypR WASM (~2.5MB) + webR (~50MB on first use).
 * Both are cached after first download.
 *
 * The kernel maintains a private /mnt/typr/ directory for
 * multi-file projects and type definitions.
 */

class TypRKernel {
    constructor() {
        this._ready = false;
        this._loading = false;
        this._typrModule = null;
        this._showGenerated = false; // show generated R code in output
    }

    static displayName = 'TypR';

    async init() {
        if (this._ready) return;
        if (this._loading) {
            while (this._loading) {
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }

        this._loading = true;
        const km = window.kernelManager;

        try {
            // Phase 1: Load TypR WASM compiler
            if (km) km.updateProgress(window.t('runtime.typrLoading'));
            const base = document.baseURI || location.href;
            const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
            this._typrModule = await import(baseDir + 'vendor/typr/typr_wasm.js');
            await this._typrModule.default();
            console.log('[TypRKernel] WASM compiler loaded');

            // Phase 2: Ensure R kernel is ready (downloads webR if needed)
            if (km) km.updateProgress(window.t('runtime.typrEnsuringR'));
            await km.ensureReady('r');
            console.log('[TypRKernel] R kernel ready');

            // Set up /mnt/typr/ directory in SharedVFS
            if (window.sharedVFS) {
                window.sharedVFS.mkdir('/mnt/typr');
            }

            this._ready = true;
        } catch (e) {
            console.error('[TypRKernel] Init failed:', e);
            throw e;
        } finally {
            this._loading = false;
        }
    }

    isReady() { return this._ready; }
    getName() { return 'TypR'; }
    getLanguage() { return 'typr'; }
    getMemoryUsage() { return 0; }

    destroy() {
        this._ready = false;
        this._typrModule = null;
    }

    /**
     * Execute TypR code:
     * 1. Compile TypR → R via WASM
     * 2. Execute R code via R kernel
     * 3. Return combined output
     */
    async execute(code) {
        if (!this._ready) await this.init();

        const trimmed = code.trim();
        if (!trimmed) return { stdout: '', error: null };

        // Handle directives
        if (trimmed.startsWith('#!')) {
            return this._handleDirective(trimmed);
        }

        try {
            // Compile TypR → R
            const result = this._typrModule.compile(trimmed);

            // Build output parts
            let output = '';

            // Show type errors as warnings (compilation still produces R code)
            if (result.has_errors) {
                output += window.t('typr.typeErrors') + '\n' + result.errors + '\n\n';
            }

            // Optionally show generated R code
            if (this._showGenerated) {
                // Show just the main code section, not the std library
                const mainIdx = result.r_code.indexOf('# === Main Code ===');
                const mainCode = mainIdx >= 0
                    ? result.r_code.substring(mainIdx + '# === Main Code ===\n'.length)
                    : result.r_code;
                output += window.t('typr.generatedR') + '\n' + mainCode.trim() + '\n\n';
            }

            // Execute via R kernel (disable autoprint to avoid duplicate output)
            const rKernel = window.kernelManager.getKernel('r');
            if (!rKernel || !rKernel.isReady()) {
                return {
                    stdout: output,
                    error: window.t('typr.rNotReady'),
                };
            }

            // Each TypR cell is a self-contained compilation unit. Execute its
            // generated standard library and user code in a child environment
            // so declarations such as `exists` do not mask base R functions in
            // later plain-R cells.
            const isolatedR =
                'base::local({\n' + result.r_code +
                '\n}, envir = base::new.env(parent = base::globalenv()))';

            // Execute directly through webR to avoid withAutoprint, which would
            // duplicate output produced by print()/cat().
            const rResult = await rKernel.executeRaw(isolatedR);

            // Combine outputs
            if (rResult.stdout) output += rResult.stdout;

            return {
                stdout: output,
                error: rResult.error || null,
                result: rResult.result || null,
                images: rResult.images || null,
            };
        } catch (e) {
            return { stdout: '', error: window.t('typr.compileFailed', { error: e.message || e }) };
        }
    }

    /**
     * Handle #! directives:
     *   #!source        — keep a highlighted source fragment without executing it
     *   #!show-r        — toggle showing generated R code
     *   #!typecheck      — type check only, don't execute
     *   #!transpile      — show transpiled R without type checking
     */
    _handleDirective(code) {
        const lines = code.split('\n');
        const directive = lines[0].substring(2).trim().toLowerCase();
        const rest = lines.slice(1).join('\n').trim();

        switch (directive) {
            case 'source':
                return { stdout: '', error: null };

            case 'show-r':
                this._showGenerated = !this._showGenerated;
                return {
                    stdout: window.t(this._showGenerated
                        ? 'typr.generatedRDisplayOn'
                        : 'typr.generatedRDisplayOff'),
                    error: null,
                };

            case 'typecheck': {
                if (!rest) return { stdout: '', error: window.t('typr.noCodeTypecheck') };
                try {
                    const result = this._typrModule.typeCheck(rest);
                    if (result.has_errors) {
                        return { stdout: '', error: result.errors };
                    }
                    return { stdout: window.t('typr.noTypeErrors'), error: '' };
                } catch (e) {
                    return { stdout: '', error: window.t('typr.typecheckFailed', { error: e.message || e }) };
                }
            }

            case 'transpile': {
                if (!rest) return { stdout: '', error: window.t('typr.noCodeTranspile') };
                try {
                    const rCode = this._typrModule.transpile(rest);
                    return { stdout: rCode, error: '' };
                } catch (e) {
                    return { stdout: '', error: window.t('typr.transpileFailed', { error: e.message || e }) };
                }
            }

            default:
                return { stdout: '', error: window.t('typr.unknownDirective', { directive: `#!${directive}` }) };
        }
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('typr', TypRKernel);
}
