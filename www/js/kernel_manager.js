/**
 * kernel_manager.js — Manages language kernels for SciREPL.
 *
 * Each kernel implements:
 *   - init()          → async, loads the runtime
 *   - execute(code)   → async, runs code, returns { stdout, result, error }
 *   - isReady()       → boolean
 *   - getName()       → display name (e.g. "Python 3")
 *   - getLanguage()   → language id (e.g. "python", "prolog")
 *   - destroy()       → cleanup (optional)
 */

class KernelManager {
    constructor() {
        // Registry: language id → kernel constructor
        this._registry = {};
        // Active kernel instances: language id → kernel instance
        this._instances = {};
        // Currently selected language
        this.currentLanguage = 'python';
    }

    /**
     * Register a kernel class for a language.
     * @param {string} language - language id (e.g. "python", "prolog")
     * @param {Function} KernelClass - constructor/class with init(), execute(), etc.
     */
    register(language, KernelClass) {
        this._registry[language] = KernelClass;
    }

    /**
     * Get all registered language ids.
     */
    getLanguages() {
        return Object.keys(this._registry);
    }

    /**
     * Get display info for all registered languages.
     * Returns [{id, name, ready}]
     */
    getLanguageInfo() {
        return this.getLanguages().map(lang => {
            const instance = this._instances[lang];
            return {
                id: lang,
                name: instance ? instance.getName() : this._registry[lang].displayName || lang,
                ready: instance ? instance.isReady() : false
            };
        });
    }

    /**
     * Get or create a kernel instance for a language.
     * Does NOT initialize it — call ensureReady() for that.
     */
    getKernel(language) {
        if (!this._registry[language]) {
            throw new Error('No kernel registered for: ' + language);
        }
        if (!this._instances[language]) {
            this._instances[language] = new this._registry[language]();
        }
        return this._instances[language];
    }

    /**
     * Ensure a kernel is initialized and ready to execute code.
     * For CDN kernels, checks privacy consent and confirms download first.
     * Returns the kernel instance.
     */
    async ensureReady(language) {
        const kernel = this.getKernel(language);
        if (!kernel.isReady()) {
            if (KernelManager.CDN_KERNELS.has(language)) {
                await this._ensurePrivacyConsent();
                await this._confirmDownload(language);
            }
            await kernel.init();
        }
        return kernel;
    }

    /**
     * Show privacy modal if user hasn't accepted yet.
     * Resolves when accepted, rejects if dismissed.
     */
    async _ensurePrivacyConsent() {
        if (localStorage.getItem('scirepl_privacy_accepted')) return;

        const modal = document.getElementById('privacy-modal');
        const acceptBtn = document.getElementById('privacy-accept-btn');
        if (!modal || !acceptBtn) return;

        return new Promise((resolve, reject) => {
            modal.classList.remove('hidden');

            const onAccept = () => {
                cleanup();
                localStorage.setItem('scirepl_privacy_accepted', '1');
                modal.classList.add('hidden');
                resolve();
            };
            const onDismiss = (e) => {
                if (e.target === modal || e.target.classList.contains('modal-close')) {
                    cleanup();
                    modal.classList.add('hidden');
                    reject(new Error('Privacy policy must be accepted to download runtimes from CDN'));
                }
            };
            const cleanup = () => {
                acceptBtn.removeEventListener('click', onAccept);
                modal.removeEventListener('click', onDismiss);
            };

            acceptBtn.addEventListener('click', onAccept);
            modal.addEventListener('click', onDismiss);
        });
    }

    /**
     * Show download confirmation modal for a CDN kernel runtime.
     * Skipped if the kernel is already loaded.
     * Resolves when user clicks Download, rejects on Cancel.
     */
    async _confirmDownload(language) {
        const kernel = this.getKernel(language);
        if (kernel.isReady()) return;

        const info = KernelManager.RUNTIME_INFO[language];
        if (!info) return; // unknown kernel, skip confirmation

        const modal = document.getElementById('runtime-download-modal');
        if (!modal) return;

        const title = document.getElementById('runtime-download-title');
        const desc = document.getElementById('runtime-download-desc');
        const actions = document.getElementById('runtime-download-actions');
        const progressWrap = document.getElementById('runtime-progress-wrap');
        const progressText = document.getElementById('runtime-progress-text');

        if (title) title.textContent = info.name + ' Download';
        if (desc) desc.innerHTML = 'The <strong>' + info.name + '</strong> runtime requires a <strong>' + info.size + '</strong> download. It will be cached by the browser for future use.';

        // Auto-download: skip confirmation, just show progress
        if (localStorage.getItem('scirepl_auto_download') === '1') {
            if (actions) actions.classList.add('hidden');
            if (progressWrap) progressWrap.classList.remove('hidden');
            if (progressText) progressText.textContent = 'Downloading ' + info.name + '...';
            modal.classList.remove('hidden');
            return;
        }

        // Reset state
        if (actions) actions.classList.remove('hidden');
        if (progressWrap) progressWrap.classList.add('hidden');

        const downloadBtn = document.getElementById('runtime-download-btn');
        const cancelBtn = document.getElementById('runtime-cancel-btn');

        return new Promise((resolve, reject) => {
            modal.classList.remove('hidden');

            const onDownload = () => {
                cleanup();
                if (actions) actions.classList.add('hidden');
                if (progressWrap) progressWrap.classList.remove('hidden');
                if (progressText) progressText.textContent = 'Downloading ' + info.name + '...';
                resolve();
            };
            const onCancel = () => {
                cleanup();
                modal.classList.add('hidden');
                reject(new Error(info.name + ' download cancelled by user'));
            };
            const cleanup = () => {
                downloadBtn.removeEventListener('click', onDownload);
                cancelBtn.removeEventListener('click', onCancel);
            };

            downloadBtn.addEventListener('click', onDownload);
            cancelBtn.addEventListener('click', onCancel);
        });
    }

    /**
     * Update the download modal progress text. Called by kernel init().
     */
    updateProgress(text) {
        const el = document.getElementById('runtime-progress-text');
        if (el) el.textContent = text;
    }

    /**
     * Hide the download modal. Called when kernel init completes.
     */
    hideDownloadModal() {
        const modal = document.getElementById('runtime-download-modal');
        if (modal) modal.classList.add('hidden');
    }

    /**
     * Execute code using the specified language kernel.
     * Lazy-loads the kernel if needed.
     * Returns { stdout, result, error }
     */
    async execute(code, language) {
        language = language || this.currentLanguage;
        const kernel = await this.ensureReady(language);
        return kernel.execute(code);
    }

    /**
     * Check if a specific kernel is loaded and ready.
     */
    isReady(language) {
        language = language || this.currentLanguage;
        const instance = this._instances[language];
        return instance ? instance.isReady() : false;
    }

    /**
     * Get the currently active kernel's display name.
     */
    getCurrentName() {
        const instance = this._instances[this.currentLanguage];
        return instance ? instance.getName() : this.currentLanguage;
    }

    /**
     * Switch the current language.
     */
    setLanguage(language) {
        if (!this._registry[language]) {
            throw new Error('No kernel registered for: ' + language);
        }
        this.currentLanguage = language;
    }

    /**
     * Destroy a kernel to free resources.
     */
    async destroyKernel(language) {
        const instance = this._instances[language];
        if (instance && instance.destroy) {
            await instance.destroy();
        }
        delete this._instances[language];
    }
}

// Kernels that require CDN downloads
KernelManager.CDN_KERNELS = new Set(['python', 'prolog', 'r']);

// Runtime display info for download confirmation modal
KernelManager.RUNTIME_INFO = {
    python: { name: 'Python (Pyodide)', size: '~25 MB' },
    r:      { name: 'R (webR)',         size: '~50 MB' },
    prolog: { name: 'Prolog (SWI)',     size: '~10 MB' },
};

// Export singleton
window.kernelManager = new KernelManager();
