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
            const base = document.baseURI || location.href;
            const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
            this._typrModule = await import(baseDir + 'vendor/typr/typr_wasm.js');
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
            // Handle @{ ... }@ raw-R blocks:
            // Split code into alternating TypR and raw-R segments,
            // compile each TypR segment via WASM, pass raw-R through as-is.
            const hasRawBlocks = /@\{[\s\S]*?\}@/.test(trimmed);

            let result;
            if (hasRawBlocks) {
                // Split into segments: [typr, rawR, typr, rawR, ...]
                const parts = trimmed.split(/@\{|\}@/);
                // Odd indices are raw-R, even indices are TypR
                let combinedR = '';
                let allErrors = '';
                let hasErrors = false;
                // Track if we need the std library preamble (only from first TypR compile)
                let preambleAdded = false;

                for (let i = 0; i < parts.length; i++) {
                    const segment = parts[i].trim();
                    if (!segment) continue;

                    if (i % 2 === 0) {
                        // TypR segment — compile
                        if (!segment) continue;
                        try {
                            const compiled = this._typrModule.compile(segment);
                            if (compiled.has_errors) {
                                hasErrors = true;
                                allErrors += compiled.errors + '\n';
                            }
                            if (!preambleAdded) {
                                combinedR += compiled.r_code;
                                preambleAdded = true;
                            } else {
                                // Skip std library preamble on subsequent segments
                                const mainIdx = compiled.r_code.indexOf('# === Main Code ===');
                                combinedR += mainIdx >= 0
                                    ? '\n' + compiled.r_code.substring(mainIdx)
                                    : '\n' + compiled.r_code;
                            }
                        } catch (e) {
                            // TypR compile failed — pass as-is (might be R-compatible)
                            combinedR += '\n' + segment;
                        }
                    } else {
                        // Raw-R segment — pass through directly
                        combinedR += '\n' + segment;
                    }
                }

                result = { r_code: combinedR, has_errors: hasErrors, errors: allErrors };
            } else {
                // Pure TypR — compile via WASM
                result = this._typrModule.compile(trimmed);
            }

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

            // Execute via R kernel (disable autoprint to avoid duplicate output)
            const rKernel = window.kernelManager.getKernel('r');
            if (!rKernel || !rKernel.isReady()) {
                return {
                    stdout: output,
                    error: 'R kernel not ready. Run a cell with R first.',
                };
            }

            // Execute R code directly through the R kernel's webR instance
            // to avoid withAutoprint which causes duplicate output with print()
            const rResult = await rKernel.executeRaw(result.r_code);

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
