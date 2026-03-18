/**
 * kernels/typr.js — TypR kernel (typed R superset).
 *
 * Compiles TypR source to R via the typr-wasm compiler, then
 * executes the generated R code through the R kernel (webR).
 *
 * Two-phase: TypR WASM (~1.7MB) + webR (~50MB on first use).
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
            if (km) km.updateProgress('Loading TypR compiler…');
            this._typrModule = await import('/vendor/typr/typr_wasm.js');
            await this._typrModule.default();
            console.log('[TypRKernel] WASM compiler loaded');

            // Phase 2: Ensure R kernel is ready (downloads webR if needed)
            if (km) km.updateProgress('Ensuring R runtime is available…');
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
    getName() { return 'typr'; }
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
        if (!trimmed) return { stdout: '', error: '' };

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
                output += '⚠ Type errors:\n' + result.errors + '\n\n';
            }

            // Optionally show generated R code
            if (this._showGenerated) {
                // Show just the main code section, not the std library
                const mainIdx = result.r_code.indexOf('# === Main Code ===');
                const mainCode = mainIdx >= 0
                    ? result.r_code.substring(mainIdx + '# === Main Code ===\n'.length)
                    : result.r_code;
                output += '── Generated R ──\n' + mainCode.trim() + '\n\n';
            }

            // Execute via R kernel
            const rKernel = window.kernelManager.getKernel('r');
            if (!rKernel || !rKernel.isReady()) {
                return {
                    stdout: output,
                    error: 'R kernel not ready. Run a cell with R first.',
                };
            }

            const rResult = await window.kernelManager.execute(result.r_code, 'r');

            // Combine outputs
            if (rResult.stdout) output += rResult.stdout;

            return {
                stdout: output,
                error: rResult.error || '',
                result: rResult.result || null,
                images: rResult.images || null,
            };
        } catch (e) {
            return { stdout: '', error: 'TypR compilation error: ' + (e.message || e) };
        }
    }

    /**
     * Handle #! directives:
     *   #!show-r        — toggle showing generated R code
     *   #!typecheck      — type check only, don't execute
     *   #!transpile      — show transpiled R without type checking
     */
    _handleDirective(code) {
        const lines = code.split('\n');
        const directive = lines[0].substring(2).trim().toLowerCase();
        const rest = lines.slice(1).join('\n').trim();

        switch (directive) {
            case 'show-r':
                this._showGenerated = !this._showGenerated;
                return {
                    stdout: `Generated R code display: ${this._showGenerated ? 'ON' : 'OFF'}`,
                    error: '',
                };

            case 'typecheck': {
                if (!rest) return { stdout: '', error: 'No code to type check.' };
                try {
                    const result = this._typrModule.typeCheck(rest);
                    if (result.has_errors) {
                        return { stdout: '', error: result.errors };
                    }
                    return { stdout: '✓ No type errors found.', error: '' };
                } catch (e) {
                    return { stdout: '', error: 'Type check failed: ' + (e.message || e) };
                }
            }

            case 'transpile': {
                if (!rest) return { stdout: '', error: 'No code to transpile.' };
                try {
                    const rCode = this._typrModule.transpile(rest);
                    return { stdout: rCode, error: '' };
                } catch (e) {
                    return { stdout: '', error: 'Transpile failed: ' + (e.message || e) };
                }
            }

            default:
                return { stdout: '', error: `Unknown directive: #!${directive}` };
        }
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('typr', TypRKernel);
}
