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
        // In-flight init promises: language id → Promise (guards concurrent init)
        this._initPromises = {};
        // Currently selected language
        this.currentLanguage = 'python';

        // Backdrop / × click hides the download modal at any phase.
        // During the Download/Cancel confirmation, _confirmDownload attaches its
        // own dismiss handler that also rejects the pending promise.
        document.addEventListener('click', (e) => {
            const modal = document.getElementById('runtime-download-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            if (e.target === modal ||
                (modal.contains(e.target) && e.target.classList.contains('modal-close'))) {
                this.hideDownloadModal();
            }
        });
    }

    _t(key, fallback, vars = {}) {
        const translated = typeof window.t === 'function' ? window.t(key, vars) : key;
        if (translated !== key) return translated;
        return String(fallback).replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
    }

    _setTranslatedText(el, key, fallback, vars = {}) {
        if (!el) return;
        el.textContent = this._t(key, fallback, vars);
        if (typeof window.setI18nText === 'function') window.setI18nText(el, key, vars);
    }

    _setTranslatedHtml(el, key, fallback, vars = {}) {
        if (!el) return;
        // This node has a generic static data-i18n fallback in index.html; once
        // runtime-specific markup is installed, one authoritative HTML key must
        // own it so locale changes do not briefly apply two competing strings.
        el.removeAttribute('data-i18n');
        el.innerHTML = this._t(key, fallback, vars);
        if (typeof window.setI18nHtml === 'function') window.setI18nHtml(el, key, vars);
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
            throw new Error(this._t('kernelManager.notRegistered',
                'No kernel registered for: {language}', { language }));
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
        if (kernel.isReady()) return kernel;

        // Share one in-flight init per language: a second Run while a heavy
        // runtime (e.g. Pyodide) is still loading must not start a second load.
        if (!this._initPromises[language]) {
            this._initPromises[language] = (async () => {
                try {
                    if (KernelManager.CDN_KERNELS.has(language) &&
                        !this._prefersBundledSource(language)) {
                        await this._ensurePrivacyConsent();
                        await this._confirmDownload(language);
                    }
                    await kernel.init();
                } catch (err) {
                    this.hideDownloadModal();
                    throw err;
                } finally {
                    delete this._initPromises[language];
                }
            })();
        }
        await this._initPromises[language];
        return kernel;
    }

    /**
     * Whether this build will try a declared same-origin runtime before any
     * network source. An explicit URL override remains a network choice.
     */
    _prefersBundledSource(language) {
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[language]) || {};
        const override = (typeof localStorage !== 'undefined') &&
            localStorage.getItem('scirepl_' + language + '_source');
        if (override && override !== 'local') return false;
        const hasLocal = (cfg.sources || []).some(source =>
            source && source.type === 'local' && source.url);
        return hasLocal && (cfg.preferLocal || override === 'local');
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
                    reject(new Error(this._t('kernelManager.privacyRequired',
                        'Privacy policy must be accepted to download runtimes from CDN')));
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

        this._setTranslatedText(title, 'kernelManager.downloadTitle',
            'Download {runtime}', { runtime: info.name });
        this._setTranslatedHtml(desc, 'kernelManager.downloadDescription',
            'The <strong>{runtime}</strong> runtime requires a <strong>{size}</strong> download from CDN. It will be cached locally for future use.',
            { runtime: info.name, size: info.size });

        // Check if runtime is actually in the CDN cache
        let cached = false;
        if (info.cdnHost) {
            try {
                const cdnCache = await caches.open(KernelManager.CDN_CACHE);
                const keys = await cdnCache.keys();
                cached = keys.some(r => new URL(r.url).hostname === info.cdnHost);
            } catch (_) { }
        }

        // Auto-download or cached: skip confirmation, show progress after a delay
        // so fast loads don't flash the modal
        if (cached || localStorage.getItem('scirepl_auto_download') === '1') {
            if (actions) actions.classList.add('hidden');
            if (progressWrap) progressWrap.classList.remove('hidden');
            if (cached) {
                this._setTranslatedText(progressText, 'kernelManager.loadingRuntime',
                    'Loading {runtime}…', { runtime: info.name });
                this._setTranslatedText(title, 'kernelManager.loadingTitle',
                    'Loading {runtime}', { runtime: info.name });
            } else {
                this._setTranslatedText(progressText, 'kernelManager.downloadingRuntime',
                    'Downloading {runtime}…', { runtime: info.name });
                this._setTranslatedText(title, 'kernelManager.downloadingTitle',
                    'Downloading {runtime}', { runtime: info.name });
            }
            // Delay showing modal — hideDownloadModal() cancels if load finishes first
            this._autoDownloadTimer = setTimeout(() => {
                modal.classList.remove('hidden');
            }, 2000);
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
                this._setTranslatedText(progressText, 'kernelManager.downloadingRuntime',
                    'Downloading {runtime}…', { runtime: info.name });
                this._setTranslatedText(title, 'kernelManager.downloadingTitle',
                    'Downloading {runtime}', { runtime: info.name });
                resolve();
            };
            const onCancel = () => {
                cleanup();
                modal.classList.add('hidden');
                reject(new Error(this._t('kernelManager.downloadCancelled',
                    '{runtime} download cancelled by user', { runtime: info.name })));
            };
            const onDismiss = (e) => {
                if (e.target === modal || e.target.classList.contains('modal-close')) {
                    onCancel();
                }
            };
            const cleanup = () => {
                downloadBtn.removeEventListener('click', onDownload);
                cancelBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onDismiss);
            };

            downloadBtn.addEventListener('click', onDownload);
            cancelBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onDismiss);
        });
    }

    /**
     * Update the download modal progress text. Called by kernel init().
     */
    updateProgress(text) {
        const el = document.getElementById('runtime-progress-text');
        if (!el) return;
        // Kernel implementations may pass { key, fallback, vars } so the
        // already-open modal follows a later locale change. Raw strings remain
        // supported while older kernels migrate to that contract.
        if (text && typeof text === 'object' && text.key) {
            this._setTranslatedText(el, text.key, text.fallback || text.key, text.vars || {});
        } else {
            el.removeAttribute('data-i18n');
            el.removeAttribute('data-i18n-vars');
            el.textContent = String(text ?? '');
        }
    }

    /**
     * Hide the download modal. Called when kernel init completes.
     */
    hideDownloadModal() {
        // Cancel pending auto-download timer so fast downloads never flash the modal
        if (this._autoDownloadTimer) {
            clearTimeout(this._autoDownloadTimer);
            this._autoDownloadTimer = null;
        }
        const modal = document.getElementById('runtime-download-modal');
        if (modal) modal.classList.add('hidden');
    }

    /**
     * Load a kernel runtime with source fallback + per-attempt timeout.
     *
     * Candidate order: a per-kernel override (localStorage scirepl_<lang>_source,
     * a URL), then the kernel's own primaryUrl (which still honors version
     * overrides), then any mirror/local sources from window.KERNEL_CONFIG. Each
     * attempt is bounded by timeoutMs so a slow/dead source fails fast and falls
     * through instead of hanging the WASM thread (which would crash the WebView).
     *
     * @param {string} language
     * @param {string} primaryUrl  the kernel's computed primary source URL
     * @param {(url:string)=>Promise<any>} loadFn  performs the actual load (e.g. url => import(url))
     * @returns {Promise<any>} whatever loadFn resolves to
     */
    async loadKernelSource(language, primaryUrl, loadFn) {
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[language]) || {};
        // A profile's `enabled:false` only means "off by default / not bundled" —
        // it does NOT forbid the kernel. If a load was requested, the user enabled
        // it (Languages modal), so honor it and pull the runtime from the CDN.
        const timeoutMs = cfg.timeoutMs || 60000;

        const candidates = [];
        const seen = new Set();
        const localUrls = new Set(
            (cfg.sources || [])
                .filter(source => source && source.type === 'local' && source.url)
                .map(source => source.url)
        );
        const add = (url) => { if (url && !seen.has(url)) { seen.add(url); candidates.push(url); } };

        // Per-kernel override (a URL); 'local' means "prefer the bundled source".
        const override = (typeof localStorage !== 'undefined') && localStorage.getItem('scirepl_' + language + '_source');
        if (override && override !== 'local') add(override);
        // Local-first when the build bundled this kernel (cfg.preferLocal) or the
        // user override asked for 'local': try the bundled copy before the CDN.
        if (cfg.preferLocal || override === 'local') {
            for (const s of (cfg.sources || [])) { if (s && s.type === 'local' && s.url) add(s.url); }
        }
        // Kernel's own primary (honors version override).
        add(primaryUrl);
        // Mirrors / remaining (incl. local as a last resort) from config.
        for (const s of (cfg.sources || [])) { if (s && s.url) add(s.url); }

        if (!candidates.length) throw new Error(this._t('kernelManager.noSources',
            'No sources configured for {language}', { language }));

        let lastErr;
        let externalFallbackApproved = !this._prefersBundledSource(language);
        for (const url of candidates) {
            try {
                if (!localUrls.has(url) && !externalFallbackApproved &&
                    KernelManager.CDN_KERNELS.has(language)) {
                    await this._ensurePrivacyConsent();
                    await this._confirmDownload(language);
                    externalFallbackApproved = true;
                }
                console.log('[KernelSource] ' + language + ': loading ' + url);
                return await this._withTimeout(loadFn(url), timeoutMs, url);
            } catch (e) {
                lastErr = e;
                console.warn('[KernelSource] ' + language + ' source failed: ' + url + ' — ' + (e && e.message || e));
            }
        }
        const error = lastErr ? (lastErr.message || lastErr) : this._t(
            'kernelManager.unknownError', 'unknown');
        throw new Error(this._t('kernelManager.allSourcesFailed',
            'All sources failed for {language}: {error}', { language, error }));
    }

    /**
     * Race a load against a timeout (the only way to bound an import()/fetch
     * that stalls — the underlying request can't be cancelled, but we stop
     * waiting and move to the next source).
     */
    _withTimeout(promise, ms, url) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(this._t(
                'kernelManager.sourceTimeout',
                'Source timed out after {milliseconds}ms: {url}',
                { milliseconds: ms, url }))), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    /**
     * Load a classic (non-module) script by URL; resolves on load, rejects on
     * error. Use as the loadFn for script-tag kernels (Pyodide, Fengari).
     */
    _loadScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(this._t(
                'kernelManager.scriptLoadFailed',
                'Script failed to load: {url}', { url })));
            document.head.appendChild(script);
        });
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
            throw new Error(this._t('kernelManager.notRegistered',
                'No kernel registered for: {language}', { language }));
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

    /**
     * Get memory info for all registered kernels.
     * Returns { kernels: [{language, name, ready, loaded, memory}] }
     */
    getMemoryInfo() {
        const kernels = [];
        for (const lang of this.getLanguages()) {
            const instance = this._instances[lang];
            const ready = instance ? instance.isReady() : false;
            const name = instance ? instance.getName() : (this._registry[lang].displayName || lang);
            let memory = null;
            if (instance && typeof instance.getMemoryUsage === 'function') {
                memory = instance.getMemoryUsage();
            }
            kernels.push({ language: lang, name, ready, loaded: !!instance, memory });
        }
        return { kernels };
    }
}

// Kernels that require CDN downloads
KernelManager.CDN_KERNELS = new Set(['python', 'prolog', 'r', 'lua']);
KernelManager.CDN_CACHE = 'scirepl-cdn-v2';

// Runtime display info for download confirmation modal
KernelManager.RUNTIME_INFO = {
    python: { name: 'Python (Pyodide)', size: '~25 MB', cdnHost: 'cdn.jsdelivr.net' },
    r:      { name: 'R (webR)',         size: '~50 MB', cdnHost: 'webr.r-wasm.org' },
    prolog: { name: 'Prolog (SWI)',     size: '~10 MB', cdnHost: 'swi-prolog.github.io' },
    lua:    { name: 'Lua (Fengari)',    size: '~200 KB', cdnHost: 'cdn.jsdelivr.net' },
};

// Export singleton
window.kernelManager = new KernelManager();
