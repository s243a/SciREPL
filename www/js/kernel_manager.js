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
     * Loads the runtime if needed. Returns the kernel instance.
     */
    async ensureReady(language) {
        const kernel = this.getKernel(language);
        if (!kernel.isReady()) {
            await kernel.init();
        }
        return kernel;
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

// Export singleton
window.kernelManager = new KernelManager();
