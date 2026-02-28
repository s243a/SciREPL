/**
 * kernels/r.js — R kernel using webR (WebAssembly).
 * Provides a full R environment with plotting support.
 *
 * Lazy-loaded from CDN (~50+ MB) on first use.
 * User is prompted before download.
 */

class RKernel {
    constructor() {
        this._webr = null;
        this._ready = false;
        this._loading = false;
    }

    static displayName = 'R';

    async init() {
        if (this._ready) return;
        if (this._loading) {
            while (this._loading) {
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }

        // Prompt user before downloading the large runtime
        const proceed = await this._confirmDownload();
        if (!proceed) {
            throw new Error('R runtime download cancelled by user');
        }

        this._loading = true;
        try {
            const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');
            this._webr = new WebR();
            await this._webr.init();
            this._ready = true;
            console.log('[RKernel] Ready (webR)');
        } catch (err) {
            console.error('[RKernel] Init failed:', err);
            throw err;
        } finally {
            this._loading = false;
        }
    }

    /**
     * Prompt the user before downloading the ~50 MB webR runtime.
     * Returns true if user confirms, false if cancelled.
     */
    async _confirmDownload() {
        return new Promise(resolve => {
            const confirmed = confirm(
                'The R runtime (webR) requires a ~50 MB download.\n\n' +
                'It will be cached by the browser for future use.\n\n' +
                'Download now?'
            );
            resolve(confirmed);
        });
    }

    isReady() {
        return this._ready;
    }

    getName() {
        return 'R (webR)';
    }

    getLanguage() {
        return 'r';
    }

    /**
     * Execute R code. Returns { stdout, result, error, images }.
     */
    async execute(code) {
        if (!this._ready) await this.init();

        const trimmed = code.trim();
        if (!trimmed) {
            return { stdout: '', result: null, error: null };
        }

        try {
            const shelter = await new this._webr.Shelter();
            const capture = await shelter.captureR(trimmed, {
                withAutoprint: true,
                captureStreams: true,
                captureConditions: false,
                captureGraphics: {
                    width: 504,
                    height: 504
                }
            });

            // Collect stdout/stderr
            let stdout = '';
            for (const msg of capture.output) {
                if (msg.type === 'stdout' || msg.type === 'stderr') {
                    stdout += msg.data + '\n';
                }
            }

            // Convert result to displayable value
            let result = null;
            if (capture.result && capture.result.type !== 'null') {
                try {
                    const jsVal = await capture.result.toJs();
                    if (jsVal && jsVal.values !== undefined) {
                        const vals = jsVal.values;
                        if (Array.isArray(vals) && vals.length === 1) {
                            result = { type: 'text', content: String(vals[0]) };
                        } else if (Array.isArray(vals)) {
                            result = { type: 'text', content: vals.join(' ') };
                        }
                    }
                } catch (e) {
                    // Non-convertible result (e.g. environment), skip
                }
            }

            // Handle plot images
            let images = [];
            if (capture.images && capture.images.length > 0) {
                for (const img of capture.images) {
                    try {
                        const canvas = new OffscreenCanvas(img.width, img.height);
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        const blob = await canvas.convertToBlob({ type: 'image/png' });
                        const url = URL.createObjectURL(blob);
                        images.push(url);
                    } catch (e) {
                        console.warn('[RKernel] Failed to render plot:', e);
                    }
                }
            }

            shelter.purge();

            return {
                stdout: stdout.trimEnd(),
                result,
                error: null,
                images
            };
        } catch (e) {
            return {
                stdout: '',
                result: null,
                error: e.message || String(e)
            };
        }
    }

    destroy() {
        if (this._webr) {
            this._webr = null;
        }
        this._ready = false;
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('r', RKernel);
}
