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
        // Successful runtime source for this page session.  This is deliberately
        // not persisted: the Languages screen must report what actually loaded
        // now, rather than implying that a previous session's fallback is live.
        this._runtimeSessionSources = {};
        // Currently selected language
        this.currentLanguage = 'python';
        // A loader URL succeeding is not the same thing as a usable runtime.
        // Keep that source provisional until the kernel's complete init()
        // succeeds; otherwise Languages could claim a failed runtime is loaded.
        this._pendingRuntimeSources = {};

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
     * Whether a language can load executable runtime code from the network.
     * The generated profile is authoritative: bundled profiles still have CDN
     * fallbacks, while native/local-only kernels do not need a consent gate.
     * The static set is only a compatibility fallback for tests/older configs.
     */
    isNetworkRuntime(language) {
        const languages = (typeof window !== 'undefined' && window.KERNEL_CONFIG)
            ? window.KERNEL_CONFIG.languages : null;
        const cfg = languages && languages[language];
        if (cfg && typeof cfg === 'object') {
            return cfg.runtime === 'cdn' || (cfg.sources || []).some((source) =>
                source && source.type === 'cdn' && source.url);
        }
        return KernelManager.CDN_KERNELS.has(language);
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
                    if (this.isNetworkRuntime(language) &&
                        !this._prefersBundledSource(language)) {
                        await this._ensurePrivacyConsent();
                        await this._confirmDownload(language);
                    }
                    await kernel.init();
                    this._commitRuntimeSource(language);
                } catch (err) {
                    this._discardPendingRuntimeSource(language);
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

    _runtimeVersionSelection(language, cfg = {}) {
        let storageKey = null;
        let selected = null;
        let tested = null;
        let fields = null;

        if (language === 'r') {
            storageKey = 'scirepl_webr_version';
            const normalize = (value) => {
                const text = String(value || '').trim();
                if (text === 'latest') return 'latest';
                const match = text.match(/^v?(\d+\.\d+\.\d+)$/);
                return match ? match[1] : null;
            };
            const raw = (typeof localStorage !== 'undefined')
                ? localStorage.getItem(storageKey) : null;
            selected = normalize(raw);
            tested = normalize(cfg.versionTag || cfg.version);
            if (selected) {
                fields = {
                    version: selected,
                    versionTag: selected === 'latest' ? 'latest' : 'v' + selected,
                };
            }
            return {
                explicit: !!String(raw || '').trim(),
                selected,
                tested,
                sameAsTested: !!selected && selected === tested,
                fields,
            };
        }

        if (language === 'prolog') {
            storageKey = 'scirepl_swipl_version';
            const normalize = (value) => {
                const text = String(value || '').trim();
                if (/^3\.\d+\.\d+$/.test(text)) return text.replaceAll('.', '/');
                if (/^\d+\/\d+$/.test(text)) return '3/' + text;
                if (/^3\/\d+\/\d+$/.test(text)) return text;
                return null;
            };
            const raw = (typeof localStorage !== 'undefined')
                ? localStorage.getItem(storageKey) : null;
            selected = normalize(raw);
            tested = normalize(cfg.versionSelector || cfg.version);
            if (selected) {
                fields = {
                    versionSelector: selected,
                    version: selected.replaceAll('/', '.'),
                };
            }
            return {
                explicit: !!String(raw || '').trim(),
                selected,
                tested,
                sameAsTested: !!selected && selected === tested,
                fields,
            };
        }

        return { explicit: false, selected: null, tested: null, sameAsTested: false, fields: null };
    }

    _expandRuntimeSourceTemplate(template, fields) {
        if (!template || !fields) return null;
        return String(template).replace(/\{(version|versionTag|versionSelector)\}/g,
            (match, key) => Object.prototype.hasOwnProperty.call(fields, key)
                ? fields[key] : match);
    }

    validateRuntimeSourceOverride(language, value) {
        const source = String(value || '').trim();
        if (!source) return '';
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[language]) || {};
        const localAvailable = (cfg.sources || []).some(item =>
            item?.type === 'local' && item.url);
        if (source === 'local') {
            if (!localAvailable) throw new Error(this._t('kernelManager.localSourceUnavailable',
                'No bundled local source is configured for {language}.', { language }));
            return source;
        }

        let parsed;
        try { parsed = new URL(source); } catch (_) {
            throw new Error(this._t('kernelManager.runtimeSourceInvalidHttps',
                'Custom runtime source must be a valid HTTPS URL.'));
        }
        if (parsed.username || parsed.password) {
            throw new Error(this._t('kernelManager.runtimeSourceCredentials',
                'Custom runtime source URLs must not contain a username or password.'));
        }
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        const devLoopback = parsed.protocol === 'http:' && loopback
            && window.KERNEL_CONFIG?.development?.allowLoopbackRuntimeSources === true;
        if (parsed.protocol !== 'https:' && !devLoopback) {
            throw new Error(this._t('kernelManager.runtimeSourceHttpsRequired',
                'Custom runtime sources must use HTTPS. Loopback HTTP is available only in explicit development mode.'));
        }

        // Electron deliberately keeps a fixed CSP. Arbitrary renderer URLs
        // cannot widen it. A future host may expose a deeply frozen exact-URL
        // allowlist; absent that capability, custom sources stay disabled.
        if (typeof window !== 'undefined' && window.sciREPLPlatform) {
            const allowlist = window.sciREPLPlatform.runtimeSourceAllowlist;
            if (!Array.isArray(allowlist) || !Object.isFrozen(allowlist)
                || !allowlist.includes(parsed.href)) {
                throw new Error(this._t('kernelManager.runtimeSourceElectronBlocked',
                    'Custom runtime sources are disabled by the Electron host policy.'));
            }
        }
        return parsed.href;
    }

    /**
     * Whether this build will try a declared same-origin runtime before any
     * network source. An explicit URL override remains a network choice, and
     * an explicit non-tested version must not silently load the bundled tested
     * runtime merely because this profile normally prefers local assets.
     */
    _prefersBundledSource(language) {
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[language]) || {};
        const override = (typeof localStorage !== 'undefined') &&
            localStorage.getItem('scirepl_' + language + '_source');
        if (override && override !== 'local') return false;
        const hasLocal = (cfg.sources || []).some(source =>
            source && source.type === 'local' && source.url);
        if (!hasLocal) return false;
        const version = this._runtimeVersionSelection(language, cfg);
        if (version.explicit && !version.sameAsTested) return false;
        return cfg.preferLocal || override === 'local';
    }

    hasCurrentPrivacyConsent() {
        return localStorage.getItem('scirepl_privacy_accepted') === '1'
            && localStorage.getItem(KernelManager.PRIVACY_POLICY_REVISION_KEY)
                === KernelManager.PRIVACY_POLICY_REVISION;
    }

    /**
     * Show the privacy modal if consent is absent. Existing boolean consent is
     * still sufficient for the network operations described by the old policy,
     * but new automatic package-metadata requests require acceptance of the
     * current policy revision. Accepting the visible policy always records both.
     */
    async _ensurePrivacyConsent({ requireCurrentRevision = false } = {}) {
        if (localStorage.getItem('scirepl_privacy_accepted') === '1'
            && (!requireCurrentRevision || this.hasCurrentPrivacyConsent())) return;

        const modal = document.getElementById('privacy-modal');
        const acceptBtn = document.getElementById('privacy-accept-btn');
        if (!modal || !acceptBtn) {
            throw new Error(this._t('kernelManager.privacyRequired',
                'Privacy policy must be accepted before this network request'));
        }

        return new Promise((resolve, reject) => {
            modal.classList.remove('hidden');

            const onAccept = () => {
                cleanup();
                localStorage.setItem('scirepl_privacy_accepted', '1');
                localStorage.setItem(KernelManager.PRIVACY_POLICY_REVISION_KEY,
                    KernelManager.PRIVACY_POLICY_REVISION);
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

    _normalizeRuntimeCacheVersion(language, value) {
        const text = String(value || '').trim();
        if (!text || text === 'latest') return null;
        if (language === 'prolog') {
            if (/^\d+\.\d+\.\d+$/.test(text)) return text.replaceAll('.', '/');
            return /^\d+\/\d+\/\d+$/.test(text) ? text : null;
        }
        const match = text.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
        return match ? match[1] : null;
    }

    _expectedRuntimeCacheVersion(language) {
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[language]) || {};
        const sourceOverride = (typeof localStorage !== 'undefined')
            && localStorage.getItem('scirepl_' + language + '_source');
        // A custom executable URL is its own trust decision, not a tested
        // runtime/version selection. Never let a receipt for it suppress a
        // future confirmation.
        if (sourceOverride && sourceOverride !== 'local') return null;
        if (language === 'r' || language === 'prolog') {
            const selected = this._runtimeVersionSelection(language, cfg);
            return this._normalizeRuntimeCacheVersion(language,
                selected.explicit ? selected.selected : selected.tested);
        }
        return this._normalizeRuntimeCacheVersion(language,
            cfg.versionSelector || cfg.versionTag || cfg.version);
    }

    _runtimeCacheMarkerUrl(language, version) {
        const base = (typeof window !== 'undefined' && window.location?.href)
            || (typeof document !== 'undefined' && document.baseURI)
            || 'https://scirepl.invalid/';
        const safeVersion = String(version).replace(/[^0-9A-Za-z.+-]/g, '_');
        return new URL(`__scirepl_runtime_cache__/${language}/${safeVersion}.json`, base).href;
    }

    _runtimeProbeMarkerPrefix() {
        const base = (typeof window !== 'undefined' && window.location?.href)
            || (typeof document !== 'undefined' && document.baseURI)
            || 'https://scirepl.invalid/';
        return new URL('__scirepl_runtime_probes__/', base).href;
    }

    _runtimeCacheUrlMatches(language, version, candidate) {
        let url;
        try { url = new URL(candidate); } catch (_) { return false; }
        if (!['https:', 'http:'].includes(url.protocol) || url.search) return false;
        let pathname;
        try { pathname = decodeURIComponent(url.pathname).toLowerCase(); }
        catch (_) { pathname = url.pathname.toLowerCase(); }
        const escaped = String(version).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (language === 'prolog') {
            return new RegExp('/npm-swipl-wasm/' + escaped + '/').test(pathname);
        }
        if (language === 'python') {
            return new RegExp('(?:/pyodide/v|/pyodide@)' + escaped + '(?:/|$)').test(pathname);
        }
        if (language === 'r') {
            return new RegExp('(?:/v|/webr@)' + escaped + '(?:/|$)').test(pathname);
        }
        if (language === 'lua') {
            return new RegExp('/fengari-web@' + escaped + '(?:/|$)').test(pathname);
        }
        return false;
    }

    /** Match an immutable CDN entry to its runtime family, independent of version. */
    _runtimeCacheUrlBelongsTo(language, candidate) {
        let url;
        try { url = new URL(candidate); } catch (_) { return false; }
        if (!['https:', 'http:'].includes(url.protocol) || url.search) return false;
        let pathname;
        try { pathname = decodeURIComponent(url.pathname).toLowerCase(); }
        catch (_) { pathname = url.pathname.toLowerCase(); }
        const host = url.hostname.toLowerCase();
        if (language === 'prolog') return pathname.includes('/npm-swipl-wasm/');
        if (language === 'python') return /\/pyodide(?:\/v|@)[^/]+\//.test(pathname);
        if (language === 'r') {
            return pathname.includes('/webr@')
                || (host === 'webr.r-wasm.org' && /\/v\d+\.\d+\.\d+(?:[-+][^/]*)?\//.test(pathname));
        }
        if (language === 'lua') return pathname.includes('/fengari-web@');
        if (language === 'clojurescript') return pathname.includes('/scittle@');
        return false;
    }

    /**
     * Return only cache records owned by one runtime. Hosts are deliberately
     * insufficient: Python, Lua and ClojureScript can all share jsDelivr.
     */
    async runtimeCacheEntries(language) {
        if (typeof caches === 'undefined') return [];
        const cache = await caches.open(KernelManager.CDN_CACHE);
        const requests = await cache.keys();
        const receiptNeedle = `/__scirepl_runtime_cache__/${encodeURIComponent(language)}/`;
        const probePrefix = this._runtimeProbeMarkerPrefix();
        const matches = [];
        for (const request of requests) {
            let pathname = '';
            try { pathname = decodeURIComponent(new URL(request.url).pathname); }
            catch (_) { /* malformed URL cannot belong to a runtime */ }
            if (pathname.includes(receiptNeedle)
                || this._runtimeCacheUrlBelongsTo(language, request.url)) {
                matches.push(request);
                continue;
            }
            if (!request.url.startsWith(probePrefix)) continue;
            try {
                const marker = await cache.match(request);
                const probe = marker && await marker.json();
                if (probe?.schemaVersion === 1 && probe.method === 'HEAD'
                    && this._runtimeCacheUrlBelongsTo(language, probe.url)) {
                    matches.push(request);
                }
            } catch (_) { /* corrupt marker stays for the global cache reset */ }
        }
        return matches;
    }

    async hasRuntimeCacheEntries(language) {
        try { return (await this.runtimeCacheEntries(language)).length > 0; }
        catch (_) { return false; }
    }

    async clearRuntimeCache(language) {
        if (typeof caches === 'undefined') return 0;
        const cache = await caches.open(KernelManager.CDN_CACHE);
        const requests = await this.runtimeCacheEntries(language);
        const removed = await Promise.all(requests.map(request => cache.delete(request)));
        return removed.filter(Boolean).length;
    }

    /**
     * Write a completion receipt only after a runtime has initialized. The
     * receipt inventories the exact-version responses present at that moment;
     * it is written last, so an interrupted or partial download cannot be
     * mistaken for a complete cached runtime on the next launch.
     */
    async markRuntimeCacheComplete(language) {
        if (typeof caches === 'undefined' || typeof Response === 'undefined') return false;
        const entry = this._pendingRuntimeSources[language]
            || this._runtimeSessionSources[language];
        const expected = this._expectedRuntimeCacheVersion(language);
        const loaded = this._normalizeRuntimeCacheVersion(language, entry?.version);
        if (!entry || entry.sourceType === 'local' || !expected || loaded !== expected) return false;

        let source;
        try {
            const base = (typeof document !== 'undefined' && document.baseURI) || undefined;
            source = new URL(entry.source, base).href;
        } catch (_) { return false; }
        if (!this._runtimeCacheUrlMatches(language, expected, source)) return false;

        try {
            const cache = await caches.open(KernelManager.CDN_CACHE);
            const requests = await cache.keys();
            const inventory = requests.map((request) => request.url)
                .filter((url) => this._runtimeCacheUrlMatches(language, expected, url))
                .sort();
            if (!inventory.includes(source)) return false;
            const probeInventory = [];
            const probePrefix = this._runtimeProbeMarkerPrefix();
            for (const request of requests) {
                if (!request.url.startsWith(probePrefix)) continue;
                try {
                    const marker = await cache.match(request);
                    const probe = marker && await marker.json();
                    if (probe?.schemaVersion === 1 && probe.method === 'HEAD'
                        && [200, 404].includes(probe.status)
                        && this._runtimeCacheUrlMatches(language, expected, probe.url)) {
                        probeInventory.push(request.url);
                    }
                } catch (_) { /* corrupt probe marker is not part of the receipt */ }
            }
            const receipt = {
                schemaVersion: 1,
                complete: true,
                language,
                version: expected,
                source,
                inventory,
                probeInventory: probeInventory.sort(),
                completedAt: new Date().toISOString(),
            };
            await cache.put(this._runtimeCacheMarkerUrl(language, expected), new Response(
                JSON.stringify(receipt), { headers: { 'content-type': 'application/json' } }));
            return true;
        } catch (_) {
            return false;
        }
    }

    async _hasCompleteCachedRuntime(language) {
        if (typeof caches === 'undefined') return false;
        const version = this._expectedRuntimeCacheVersion(language);
        if (!version) return false;
        try {
            const cache = await caches.open(KernelManager.CDN_CACHE);
            const response = await cache.match(this._runtimeCacheMarkerUrl(language, version));
            if (!response) return false;
            const receipt = await response.json();
            if (receipt?.schemaVersion !== 1 || receipt.complete !== true
                || receipt.language !== language || receipt.version !== version
                || !Array.isArray(receipt.inventory) || receipt.inventory.length === 0
                || !receipt.inventory.includes(receipt.source)
                || !Array.isArray(receipt.probeInventory)) return false;
            for (const url of receipt.inventory) {
                if (!this._runtimeCacheUrlMatches(language, version, url)
                    || !(await cache.match(url))) return false;
            }
            for (const markerUrl of receipt.probeInventory) {
                if (!markerUrl.startsWith(this._runtimeProbeMarkerPrefix())) return false;
                const marker = await cache.match(markerUrl);
                if (!marker) return false;
                const probe = await marker.json();
                if (probe?.schemaVersion !== 1 || probe.method !== 'HEAD'
                    || ![200, 404].includes(probe.status)
                    || !this._runtimeCacheUrlMatches(language, version, probe.url)) return false;
            }
            return true;
        } catch (_) {
            return false;
        }
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

        // Suppress the prompt only after this exact runtime/version completed
        // successfully and every response recorded in its receipt is still
        // present. A lone file from the same host is not a cached runtime.
        const cached = await this._hasCompleteCachedRuntime(language);

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
     * Candidate selection has three deliberately strict modes:
     *   1. no override: bundled local first (when preferred), then the pinned
     *      tested source and its pinned mirrors;
     *   2. explicit version: only sources expanded for that exact version;
     *      bundled local is eligible only when it is the same tested version;
     *   3. explicit source: only that source. `local` is a strict request for a
     *      declared bundled source, never a hint followed by a silent CDN swap.
     *
     * Each attempt is bounded by timeoutMs so a slow/dead source fails fast.
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
        const localSources = (cfg.sources || [])
            .filter(source => source && source.type === 'local' && source.url);
        const localUrls = new Set(localSources.map(source => source.url));
        const add = (url) => { if (url && !seen.has(url)) { seen.add(url); candidates.push(url); } };

        // Per-kernel override (a URL); 'local' means "strictly use the bundled source".
        const storedOverride = (typeof localStorage !== 'undefined')
            && localStorage.getItem('scirepl_' + language + '_source');
        const override = storedOverride
            ? this.validateRuntimeSourceOverride(language, storedOverride)
            : storedOverride;
        if (override === 'local' && localUrls.size === 0) {
            throw new Error(this._t('kernelManager.localSourceUnavailable',
                'No bundled local source is configured for {language}.', { language }));
        }
        const version = this._runtimeVersionSelection(language, cfg);

        if (override && override !== 'local') {
            // A custom executable source is an explicit trust decision. If it
            // fails, surface that failure rather than running different code.
            add(override);
        } else if (override === 'local') {
            if (version.explicit && !version.sameAsTested) {
                throw new Error(this._t('kernelManager.localVersionMismatch',
                    'The bundled {language} runtime is the tested version and cannot satisfy the selected version.',
                    { language }));
            }
            for (const source of localSources) add(source.url);
        } else if (version.explicit) {
            // An explicitly selected version must remain version-coherent across
            // fallback. Never append pinned-default URLs for another version.
            if (version.sameAsTested && cfg.preferLocal) {
                for (const source of localSources) add(source.url);
            }
            add(primaryUrl);
            if (cfg.overrideUrlTemplate) {
                add(this._expandRuntimeSourceTemplate(cfg.overrideUrlTemplate, version.fields));
            }
            for (const source of (cfg.sources || [])) {
                if (!source || source.type === 'local') continue;
                if (source.urlTemplate) {
                    add(this._expandRuntimeSourceTemplate(source.urlTemplate, version.fields));
                } else if (version.sameAsTested) {
                    add(source.url);
                }
            }
        } else {
            if (cfg.preferLocal) {
                for (const source of localSources) add(source.url);
            }
            add(primaryUrl);
            for (const source of (cfg.sources || [])) add(source?.url);
        }

        if (!candidates.length) throw new Error(this._t('kernelManager.noSources',
            'No sources configured for {language}', { language }));

        let lastErr;
        let externalFallbackApproved = !this._prefersBundledSource(language);
        for (const url of candidates) {
            try {
                if (!localUrls.has(url) && !externalFallbackApproved &&
                    this.isNetworkRuntime(language)) {
                    await this._ensurePrivacyConsent();
                    await this._confirmDownload(language);
                    externalFallbackApproved = true;
                }
                console.log('[KernelSource] ' + language + ': loading ' + url);
                const result = await this._withTimeout(loadFn(url), timeoutMs, url);
                this._stageRuntimeSource(language, url);
                return result;
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
     * Record the exact source that completed successfully, then notify an open
     * Languages modal so it can refresh without polling.  The URL/path is the
     * authoritative session fact; `tested` says whether it is one of the
     * generated, release-pinned sources rather than a user override.
     */
    _runtimeSourceEntry(language, url) {
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[language]) || {};
        const configuredSource = (cfg.sources || []).find(source => source && source.url === url);
        return {
            language,
            source: url,
            tested: !!configuredSource,
            sourceType: configuredSource?.type || 'override',
            version: this._inferRuntimeVersion(language, url, cfg, configuredSource),
        };
    }

    _stageRuntimeSource(language, url) {
        this._pendingRuntimeSources[language] = this._runtimeSourceEntry(language, url);
    }

    _commitRuntimeSource(language) {
        const pending = this._pendingRuntimeSources[language];
        if (!pending) return null;
        delete this._pendingRuntimeSources[language];
        const entry = { ...pending, loadedAt: Date.now() };
        this._runtimeSessionSources[language] = entry;
        this._dispatchRuntimeSourceLoaded(entry);
        return entry;
    }

    _discardPendingRuntimeSource(language) {
        delete this._pendingRuntimeSources[language];
    }

    /**
     * Test/support helper for a source known to have completed initialization.
     * Runtime loaders themselves must stage via loadKernelSource() and let
     * ensureReady() commit only after init() returns successfully.
     */
    _recordRuntimeSource(language, url) {
        this._stageRuntimeSource(language, url);
        return this._commitRuntimeSource(language);
    }

    _inferRuntimeVersion(language, url, cfg, configuredSource) {
        if (language === 'prolog') {
            const match = String(url).match(/npm-swipl-wasm\/(\d+\/\d+\/\d+)\/dynamic-import\.js/i);
            if (match) return match[1];
            if (configuredSource) return cfg.versionSelector || cfg.version || null;
            const selected = typeof localStorage !== 'undefined'
                && localStorage.getItem('scirepl_swipl_version');
            if (/^\d+\.\d+\.\d+$/.test(selected || '')) return selected.replaceAll('.', '/');
            if (/^\d+\/\d+$/.test(selected || '')) return '3/' + selected;
            if (/^\d+\/\d+\/\d+$/.test(selected || '')) return selected;
            return null;
        }
        if (language === 'r') {
            if (configuredSource) return cfg.versionTag || cfg.version || null;
            const official = String(url).match(/(?:webr@|\/v)(\d+\.\d+\.\d+)(?:\/|$)/i);
            if (official) return official[1];
            const sourceOverride = typeof localStorage !== 'undefined'
                && localStorage.getItem('scirepl_r_source');
            if (sourceOverride && sourceOverride !== 'local') return null;
            const selected = typeof localStorage !== 'undefined'
                && localStorage.getItem('scirepl_webr_version');
            return selected && selected !== 'latest' ? selected : null;
        }
        return configuredSource ? (cfg.versionTag || cfg.versionSelector || cfg.version || null) : null;
    }

    _dispatchRuntimeSourceLoaded(entry) {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            const EventClass = (typeof CustomEvent === 'function' && CustomEvent)
                || (typeof window.CustomEvent === 'function' && window.CustomEvent);
            if (EventClass) {
                window.dispatchEvent(new EventClass('scirepl:runtime-source-loaded', {
                    detail: { ...entry },
                }));
            }
        }
    }

    /** Refine a source record with the version reported by the initialized runtime. */
    recordRuntimeLoadedVersion(language, version) {
        const pending = this._pendingRuntimeSources[language];
        const entry = pending || this._runtimeSessionSources[language];
        if (!entry || version === undefined || version === null || version === '') return;
        entry.version = String(version);
        // A provisional source must remain invisible until init() finishes.
        if (!pending) this._dispatchRuntimeSourceLoaded(entry);
    }

    /** Return a copy so callers cannot mutate the manager's session record. */
    getRuntimeSessionSource(language) {
        const entry = this._runtimeSessionSources[language];
        return entry ? { ...entry } : null;
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
            // Anonymous CORS keeps the response visible to the service worker.
            // Without this, a cross-origin classic script is an opaque status-0
            // response, which the immutable runtime cache deliberately rejects.
            script.crossOrigin = 'anonymous';
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
KernelManager.CDN_KERNELS = new Set(['python', 'prolog', 'r', 'lua', 'clojurescript']);
KernelManager.CDN_CACHE = 'scirepl-cdn-v3';
KernelManager.PRIVACY_POLICY_REVISION_KEY = 'scirepl_privacy_accepted_revision';
KernelManager.PRIVACY_POLICY_REVISION = '2026-08-runtime-metadata-v1';

// Runtime display info for download confirmation modal
KernelManager.RUNTIME_INFO = {
    python: { name: 'Python (Pyodide)', size: '~25 MB', cdnHost: 'cdn.jsdelivr.net' },
    r:      { name: 'R (webR)',         size: '~50 MB', cdnHost: 'webr.r-wasm.org' },
    prolog: { name: 'Prolog (SWI)',     size: '~10 MB', cdnHost: 'swi-prolog.github.io' },
    lua:    { name: 'Lua (Fengari)',    size: '~200 KB', cdnHost: 'cdn.jsdelivr.net' },
    clojurescript: { name: 'ClojureScript (Scittle)', size: '~900 KB', cdnHost: 'cdn.jsdelivr.net' },
};

// Export singleton
window.kernelManager = new KernelManager();
