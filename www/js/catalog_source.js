/**
 * catalog_source.js — verified remote SciREPL catalogue channels.
 *
 * The default path is intentionally API-free: GitHub Pages publishes a small
 * stable descriptor which pins an immutable release commit, index hash, and
 * artifact base.  The GitHub API is used only for the explicitly selected
 * development-branch channel, where it resolves a mutable branch to one full
 * commit before any catalogue bytes are accepted.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CatalogSource = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SOURCE_ID = 'scirepl-catalog';
    const SOURCE_LABEL = 'SciREPL Catalog';
    const PAGES_ROOT = 'https://s243a.github.io/SciREPL-Catalog/';
    const RAW_ROOT = 'https://raw.githubusercontent.com/s243a/SciREPL-Catalog/';
    const API_ROOT = 'https://api.github.com/repos/s243a/SciREPL-Catalog/';
    const SETTINGS_KEY = 'scirepl_catalog_source_v1';
    const DB_NAME = 'scirepl_catalog';
    const DB_VERSION = 1;
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    const MAX_DESCRIPTOR_BYTES = 64 * 1024;
    const MAX_INDEX_BYTES = 1024 * 1024;
    const MAX_ITEMS = 500;
    const MAX_REQUIRES = 8;
    const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
    const SHA_RE = /^[0-9a-f]{64}$/;
    const COMMIT_RE = /^[0-9a-f]{40}$/;
    const TAG_RE = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
    const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    const KERNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;
    const SUPPORTED_KERNELS = new Set([
        'python', 'prolog', 'bash', 'javascript', 'r', 'lua',
        'typr', 'clojurescript',
    ]);
    const LOCALE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
    const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u;
    // A remote workbook may only request packages the app already knows how
    // to obtain. Keep this explicit: arbitrary ids would turn a catalogue
    // entry into an unreviewed package-fetch request.
    const KNOWN_DEPENDENCIES = Object.freeze(['unifyweaver-scirepl']);
    const KNOWN_DEPENDENCY_SET = new Set(KNOWN_DEPENDENCIES);

    const DEFAULT_CONFIG = Object.freeze({
        mode: 'stable',
        value: '',
        siteBase: PAGES_ROOT,
    });

    function plainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function bytesOf(value) {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        throw new Error('Expected binary response bytes.');
    }

    function utf8Length(value) {
        return new TextEncoder().encode(String(value)).byteLength;
    }

    function cleanString(value, label, maxBytes, { allowEmpty = false } = {}) {
        if (typeof value !== 'string' || (!allowEmpty && !value)) {
            throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string.`);
        }
        if (UNSAFE_TEXT_RE.test(value)
            || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) {
            throw new Error(`${label} contains unsafe text.`);
        }
        if (utf8Length(value) > maxBytes) throw new Error(`${label} is too long.`);
        return value;
    }

    function isLoopback(hostname) {
        const host = String(hostname || '').toLowerCase();
        return host === 'localhost' || host === '127.0.0.1'
            || host === '::1' || host === '[::1]';
    }

    function normalizeBaseUrl(value, { strict = true } = {}) {
        try {
            const parsed = new URL(String(value || ''));
            if (parsed.username || parsed.password || parsed.search || parsed.hash) {
                throw new Error('credentials, query strings, and fragments are not allowed');
            }
            if (parsed.protocol !== 'https:'
                && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
                throw new Error('HTTPS is required (except loopback testing)');
            }
            if (String(value).length > 2048 || UNSAFE_TEXT_RE.test(String(value))) {
                throw new Error('URL is too long or contains unsafe text');
            }
            if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
            return parsed.href;
        } catch (error) {
            if (!strict) return PAGES_ROOT;
            throw new Error(`Invalid catalogue host: ${error.message}`);
        }
    }

    function normalizeBranch(value) {
        const branch = cleanString(String(value || '').trim(), 'Branch', 160);
        if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('\\')
            || branch.includes('..') || branch.includes('@{') || branch.includes('//')
            || branch === '@' || branch.endsWith('.') || /\s/.test(branch)
            || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
            || /[~^:?*[\]]/.test(branch)) {
            throw new Error('Branch name is not safe to resolve.');
        }
        return branch;
    }

    function normalizeConfig(value, { strict = false } = {}) {
        const raw = plainObject(value) ? value : {};
        try {
            if (strict && raw.mode !== undefined
                && !['stable', 'release', 'commit', 'development'].includes(raw.mode)) {
                throw new Error('Unknown catalogue source mode.');
            }
            const mode = ['stable', 'release', 'commit', 'development'].includes(raw.mode)
                ? raw.mode : 'stable';
            let selected = String(raw.value || '').trim();
            if (mode === 'stable') selected = '';
            if (mode === 'release' && !TAG_RE.test(selected)) {
                throw new Error('Release must look like v1.2.3.');
            }
            if (mode === 'commit') {
                selected = selected.toLowerCase();
                if (!COMMIT_RE.test(selected)) {
                    throw new Error('Commit must be a full 40-character SHA.');
                }
            }
            if (mode === 'development') selected = normalizeBranch(selected || 'main');
            const siteBase = normalizeBaseUrl(raw.siteBase || PAGES_ROOT, { strict: true });
            return { mode, value: selected, siteBase };
        } catch (error) {
            if (strict) throw error;
            return { ...DEFAULT_CONFIG };
        }
    }

    function pointerId(config) {
        const cfg = normalizeConfig(config, { strict: true });
        if (cfg.mode === 'stable') return `stable:${cfg.siteBase}`;
        if (cfg.mode === 'release') return `release:${cfg.siteBase}:${cfg.value}`;
        return `${cfg.mode}:${cfg.value}`;
    }

    function compareReleaseTags(left, right) {
        if (!TAG_RE.test(String(left || '')) || !TAG_RE.test(String(right || ''))) return 0;
        const a = String(left).slice(1).split('.').map(Number);
        const b = String(right).slice(1).split('.').map(Number);
        for (let index = 0; index < 3; index++) {
            if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
        }
        return 0;
    }

    function safeRelativePath(value, { directory = false } = {}) {
        const text = cleanString(value, 'Catalogue path', 1024);
        if (text.startsWith('/') || text.startsWith('~') || text.includes('\\')
            || text.includes(':') || text.includes('?') || text.includes('#')
            || text.includes('%')) {
            throw new Error('Catalogue path must be a plain repository-relative path.');
        }
        const source = directory && text.endsWith('/') ? text.slice(0, -1) : text;
        if (!source || (!directory && text.endsWith('/'))) {
            throw new Error('Catalogue path has the wrong file/directory shape.');
        }
        const parts = source.split('/');
        if (parts.some(part => !part || part === '.' || part === '..'
            || part.endsWith('.') || part.endsWith(' ') || utf8Length(part) > 255)) {
            throw new Error('Catalogue path contains an unsafe component.');
        }
        return directory ? `${parts.join('/')}/` : parts.join('/');
    }

    function joinBase(base, relative, options) {
        const safe = safeRelativePath(relative, options);
        const encoded = safe.split('/').map(part => part ? encodeURIComponent(part) : '').join('/');
        const joined = new URL(encoded, normalizeBaseUrl(base, { strict: true }));
        const rootUrl = new URL(normalizeBaseUrl(base, { strict: true }));
        if (joined.origin !== rootUrl.origin || !joined.pathname.startsWith(rootUrl.pathname)) {
            throw new Error('Catalogue path escaped its configured host.');
        }
        return joined.href;
    }

    async function sha256Hex(value) {
        const bytes = bytesOf(value);
        const cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
        if (!cryptoApi || !cryptoApi.subtle) throw new Error('SHA-256 is unavailable.');
        const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function decodeJson(value, maxBytes, label) {
        const bytes = bytesOf(value);
        if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds the size limit.`);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch (_) { throw new Error(`${label} is not valid UTF-8.`); }
        try { return JSON.parse(text); }
        catch (_) { throw new Error(`${label} is not valid JSON.`); }
    }

    function validateDescriptor(value, siteBase, expectedTag) {
        if (!plainObject(value) || value.schema !== 1) {
            throw new Error('Unsupported release descriptor schema.');
        }
        const tag = cleanString(value.tag, 'Release tag', 64);
        if (!TAG_RE.test(tag) || (expectedTag && tag !== expectedTag)) {
            throw new Error('Release descriptor has an unexpected tag.');
        }
        const commit = String(value.commit || '').toLowerCase();
        if (!COMMIT_RE.test(commit)) throw new Error('Release descriptor has an invalid commit.');
        if (typeof value.date !== 'string' || !Number.isFinite(Date.parse(value.date))) {
            throw new Error('Release descriptor has an invalid date.');
        }
        const catalog = safeRelativePath(value.catalog);
        const filesBase = safeRelativePath(value.files_base, { directory: true });
        const expectedCatalog = `releases/${tag}/catalog.json`;
        const expectedFiles = `releases/${tag}/files/`;
        if (catalog !== expectedCatalog || filesBase !== expectedFiles) {
            throw new Error('Release descriptor paths do not match its tag.');
        }
        const rawBase = normalizeBaseUrl(value.raw_base, { strict: true });
        if (rawBase !== `${RAW_ROOT}${commit}/`) {
            throw new Error('Release descriptor raw mirror is not pinned to its commit.');
        }
        if (!plainObject(value.index)) throw new Error('Release descriptor lacks index metadata.');
        const indexSha256 = String(value.index.sha256 || '').toLowerCase();
        const indexSize = Number(value.index.size);
        const itemCount = Number(value.index.items);
        if (!SHA_RE.test(indexSha256)
            || !Number.isSafeInteger(indexSize) || indexSize <= 0 || indexSize > MAX_INDEX_BYTES
            || !Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > MAX_ITEMS
            || value.index.format_version !== '2.0') {
            throw new Error('Release descriptor index metadata is invalid.');
        }
        const base = normalizeBaseUrl(siteBase, { strict: true });
        return {
            schema: 1,
            tag,
            commit,
            date: value.date,
            catalog,
            filesBase,
            catalogUrl: joinBase(base, catalog),
            artifactBaseUrl: joinBase(base, filesBase, { directory: true }),
            rawBase,
            indexSha256,
            indexSize,
            itemCount,
            formatVersion: '2.0',
        };
    }

    function validateLocales(value, fallback) {
        const list = value == null ? fallback : value;
        if (!Array.isArray(list) || list.length < 1 || list.length > 16) {
            throw new Error('Catalogue locales must be a non-empty array.');
        }
        const out = [];
        for (const raw of list) {
            const locale = cleanString(raw, 'Content locale', 35);
            if (!LOCALE_RE.test(locale)) throw new Error(`Invalid content locale: ${locale}`);
            if (!out.some(item => item.toLowerCase() === locale.toLowerCase())) out.push(locale);
        }
        return out;
    }

    function validateRequires(value, itemId) {
        if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REQUIRES) {
            throw new Error(`Workbook dependencies are invalid for ${itemId}.`);
        }
        const seen = new Set();
        const out = [];
        for (const raw of value) {
            const dependency = cleanString(raw, 'Dependency id', 128);
            if (!ID_RE.test(dependency) || seen.has(dependency)
                || !KNOWN_DEPENDENCY_SET.has(dependency)) {
                throw new Error(`Unknown or invalid package dependency: ${dependency}`);
            }
            seen.add(dependency);
            out.push(dependency);
        }
        return Object.freeze(out);
    }

    function formatBytes(size) {
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    function validateIndex(value, provenance) {
        if (!plainObject(value) || value.format_version !== '2.0') {
            throw new Error('Unsupported catalogue index format.');
        }
        const name = cleanString(value.name, 'Catalogue name', 256);
        const source = cleanString(value.source, 'Catalogue source', 2048);
        let parsedSource;
        try { parsedSource = new URL(source); }
        catch (_) { throw new Error('Catalogue source URL is invalid.'); }
        if (parsedSource.protocol !== 'https:' || parsedSource.username || parsedSource.password) {
            throw new Error('Catalogue source must be an HTTPS URL without credentials.');
        }
        const defaults = validateLocales(value.locales || ['en'], ['en']);
        if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
            throw new Error('Catalogue contains too many items.');
        }
        if (provenance.itemCount != null && value.items.length !== provenance.itemCount) {
            throw new Error('Catalogue item count does not match its descriptor.');
        }

        const seen = new Set();
        const entries = value.items.map((item) => {
            if (!plainObject(item)) throw new Error('Catalogue item must be an object.');
            const id = cleanString(item.id, 'Item id', 128);
            if (!ID_RE.test(id) || seen.has(id)) throw new Error(`Invalid or duplicate item id: ${id}`);
            seen.add(id);
            if (item.type !== 'workbook') {
                throw new Error(`Unsupported remote catalogue item type for ${id}.`);
            }
            const format = cleanString(item.format, 'Workbook format', 16);
            if (!['srwb', 'ipynb'].includes(format)) {
                throw new Error(`Unsupported workbook format for ${id}.`);
            }
            const path = safeRelativePath(item.path);
            if (!path.endsWith(`.${format}`)) {
                throw new Error(`Workbook path does not match its format for ${id}.`);
            }
            const size = Number(item.size);
            const revision = Number(item.revision);
            const sha256 = String(item.sha256 || '').toLowerCase();
            if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES
                || !Number.isSafeInteger(revision) || revision <= 0
                || !SHA_RE.test(sha256)) {
                throw new Error(`Workbook integrity metadata is invalid for ${id}.`);
            }
            if (!Array.isArray(item.kernels) || item.kernels.length < 1 || item.kernels.length > 16) {
                throw new Error(`Workbook kernels are invalid for ${id}.`);
            }
            const kernels = item.kernels.map(kernel => {
                const normalized = cleanString(kernel, 'Kernel id', 32);
                if (!KERNEL_RE.test(normalized) || !SUPPORTED_KERNELS.has(normalized)) {
                    throw new Error(`Unsupported kernel id: ${kernel}`);
                }
                return normalized;
            });
            const requires = Object.prototype.hasOwnProperty.call(item, 'requires')
                ? validateRequires(item.requires, id) : null;
            const locales = validateLocales(item.locales, defaults);
            const itemName = cleanString(item.name, 'Workbook name', 512);
            const description = cleanString(item.description, 'Workbook description', 4096, {
                allowEmpty: true,
            });
            const catalogKey = `${SOURCE_ID}:${id}`;
            const artifactUrl = joinBase(provenance.artifactBaseUrl, path);
            const rawUrl = joinBase(provenance.rawBase, path);
            const entry = {
                id,
                catalogKey,
                sourceId: SOURCE_ID,
                sourceLabel: name || SOURCE_LABEL,
                official: true,
                builtin: false,
                name: itemName,
                notebookName: itemName,
                description,
                type: 'workbook',
                format,
                revision,
                size,
                sizeLabel: formatBytes(size),
                sha256,
                kernels,
                locales,
                pages_url: artifactUrl,
                url: rawUrl,
                _catalog: Object.freeze({
                    sourceId: SOURCE_ID,
                    tag: provenance.tag || null,
                    ref: provenance.selector,
                    commit: provenance.commit,
                    path,
                    sha256,
                    size,
                    artifactUrl,
                    rawUrl,
                }),
            };
            if (requires) entry.requires = requires;
            return entry;
        });
        return { name, source, locales: defaults, entries };
    }

    function resultFromSnapshot(snapshot, status, stale, extra) {
        return {
            entries: snapshot ? snapshot.entries : [],
            status,
            stale: !!stale,
            provenance: snapshot ? snapshot.provenance : null,
            needsRefresh: !snapshot || !!stale,
            ...(extra || {}),
        };
    }

    class CatalogDb {
        constructor(indexedDBImpl) {
            this.indexedDB = indexedDBImpl;
            this._dbPromise = null;
        }

        async open() {
            if (!this.indexedDB) return null;
            if (this._dbPromise) return this._dbPromise;
            this._dbPromise = new Promise((resolve, reject) => {
                const request = this.indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('snapshots')) {
                        db.createObjectStore('snapshots', { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains('pointers')) {
                        db.createObjectStore('pointers', { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains('pins')) {
                        db.createObjectStore('pins', { keyPath: 'tag' });
                    }
                    if (!db.objectStoreNames.contains('artifacts')) {
                        db.createObjectStore('artifacts', { keyPath: 'sha256' });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('Catalogue cache failed to open.'));
            });
            return this._dbPromise;
        }

        async get(store, key) {
            const db = await this.open();
            if (!db) return null;
            return new Promise((resolve, reject) => {
                const request = db.transaction(store, 'readonly').objectStore(store).get(key);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error);
            });
        }

        async put(store, value) {
            const db = await this.open();
            if (!db) return;
            return new Promise((resolve, reject) => {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(value);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Catalogue cache transaction aborted.'));
            });
        }

        async activate(candidate, pointer, proposedPin, { replacePin = false } = {}) {
            const db = await this.open();
            if (!db) {
                if (proposedPin) throw new Error('Catalogue trust storage is unavailable.');
                return { activated: true, pin: null };
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(['snapshots', 'pointers', 'pins'], 'readwrite');
                let result = null;
                const publish = (existingPin) => {
                    if (proposedPin && existingPin && !replacePin
                        && (existingPin.commit !== proposedPin.commit
                            || existingPin.indexSha256 !== proposedPin.indexSha256)) {
                        result = { activated: false, pin: existingPin };
                        return;
                    }
                    const pin = proposedPin ? {
                        ...proposedPin,
                        firstSeenAt: existingPin && !replacePin
                            ? existingPin.firstSeenAt : proposedPin.firstSeenAt,
                    } : null;
                    tx.objectStore('snapshots').put(candidate);
                    tx.objectStore('pointers').put(pointer);
                    if (pin) tx.objectStore('pins').put(pin);
                    result = { activated: true, pin };
                };
                if (proposedPin) {
                    const request = tx.objectStore('pins').get(proposedPin.tag);
                    request.onsuccess = () => publish(request.result || null);
                    request.onerror = () => reject(request.error);
                } else {
                    publish(null);
                }
                tx.oncomplete = () => resolve(result || { activated: false, pin: null });
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Catalogue activation aborted.'));
            });
        }

        async clear() {
            const db = await this.open();
            if (!db) return;
            return new Promise((resolve, reject) => {
                const stores = ['snapshots', 'pointers', 'pins', 'artifacts'];
                const tx = db.transaction(stores, 'readwrite');
                stores.forEach(store => tx.objectStore(store).clear());
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Catalogue cache clear aborted.'));
            });
        }
    }

    class CatalogSourceManager {
        constructor(options = {}) {
            this.fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
            this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            this.now = options.now || (() => Date.now());
            this.beforeNetwork = options.beforeNetwork || (async () => {});
            this.db = options.db || new CatalogDb(
                options.indexedDBImpl !== undefined ? options.indexedDBImpl
                    : (typeof indexedDB !== 'undefined' ? indexedDB : null));
            this._memory = new Map();
            this._movedCandidate = null;
            this._inFlight = new Map();
            this._refreshGeneration = new Map();
        }

        getConfig() {
            if (!this.storage) return { ...DEFAULT_CONFIG };
            try { return normalizeConfig(JSON.parse(this.storage.getItem(SETTINGS_KEY) || 'null')); }
            catch (_) { return { ...DEFAULT_CONFIG }; }
        }

        setConfig(value) {
            const config = normalizeConfig(value, { strict: true });
            if (this.storage) this.storage.setItem(SETTINGS_KEY, JSON.stringify(config));
            this._movedCandidate = null;
            return config;
        }

        async _readBytes(url, maxBytes) {
            if (!this.fetchImpl) throw new Error('Network fetch is unavailable.');
            const response = await this.fetchImpl(url, {
                method: 'GET',
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
                headers: { Accept: 'application/json, application/octet-stream;q=0.9' },
            });
            if (!response || !response.ok) {
                throw new Error(`Catalogue request failed (HTTP ${response ? response.status : 0}).`);
            }
            if (response.url && new URL(response.url).origin !== new URL(url).origin) {
                throw new Error('Catalogue request redirected to another origin.');
            }
            const declared = Number(response.headers && response.headers.get
                ? response.headers.get('content-length') : 0);
            if (Number.isFinite(declared) && declared > maxBytes) {
                throw new Error('Catalogue response exceeds the size limit.');
            }
            if (!response.body || typeof response.body.getReader !== 'function') {
                throw new Error('Streaming catalogue responses are required for bounded downloads.');
            }
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                const chunk = bytesOf(part.value);
                total += chunk.byteLength;
                if (total > maxBytes) {
                    try { await reader.cancel(); } catch (_) {}
                    throw new Error('Catalogue response exceeds the size limit.');
                }
                chunks.push(chunk);
            }
            const out = new Uint8Array(total);
            let offset = 0;
            chunks.forEach(chunk => { out.set(chunk, offset); offset += chunk.byteLength; });
            return out;
        }

        async _channelPlan(config) {
            if (config.mode === 'stable') {
                return {
                    channel: 'stable', selector: 'stable',
                    descriptorUrl: joinBase(config.siteBase, 'stable.json'),
                    siteBase: config.siteBase,
                };
            }
            if (config.mode === 'release') {
                return {
                    channel: 'release', selector: config.value, expectedTag: config.value,
                    descriptorUrl: joinBase(config.siteBase,
                        `releases/${config.value}/release.json`),
                    siteBase: config.siteBase,
                };
            }
            if (config.mode === 'commit') {
                return {
                    channel: 'commit', selector: config.value, commit: config.value,
                    rawBase: `${RAW_ROOT}${config.value}/`,
                };
            }
            const encodedBranch = config.value.split('/').map(encodeURIComponent).join('/');
            const apiUrl = `${API_ROOT}git/ref/heads/${encodedBranch}`;
            const apiBytes = await this._readBytes(apiUrl, MAX_DESCRIPTOR_BYTES);
            const response = decodeJson(apiBytes, MAX_DESCRIPTOR_BYTES, 'GitHub branch response');
            const commit = String(response && response.object && response.object.sha || '').toLowerCase();
            if (!COMMIT_RE.test(commit)) throw new Error('GitHub did not resolve the branch to a full commit.');
            return {
                channel: 'development', selector: config.value, commit,
                rawBase: `${RAW_ROOT}${commit}/`, apiUrl,
            };
        }

        async _fetchCandidate(config) {
            const plan = await this._channelPlan(config);
            let descriptorBytes = null;
            let descriptor = null;
            let provenance;
            if (plan.descriptorUrl) {
                descriptorBytes = await this._readBytes(plan.descriptorUrl, MAX_DESCRIPTOR_BYTES);
                descriptor = validateDescriptor(
                    decodeJson(descriptorBytes, MAX_DESCRIPTOR_BYTES, 'Release descriptor'),
                    plan.siteBase, plan.expectedTag);
                provenance = {
                    channel: plan.channel,
                    selector: plan.selector,
                    descriptorUrl: plan.descriptorUrl,
                    ...descriptor,
                };
            } else {
                provenance = {
                    channel: plan.channel,
                    selector: plan.selector,
                    tag: null,
                    commit: plan.commit,
                    catalogUrl: joinBase(plan.rawBase, 'scirepl-catalog.json'),
                    artifactBaseUrl: plan.rawBase,
                    rawBase: plan.rawBase,
                    indexSha256: null,
                    indexSize: null,
                    itemCount: null,
                    formatVersion: '2.0',
                };
            }
            let indexBytes = null;
            let indexSha256 = null;
            let indexUrl = null;
            let indexError = null;
            const immutableRawIndex = joinBase(provenance.rawBase, 'scirepl-catalog.json');
            for (const url of [...new Set([provenance.catalogUrl, immutableRawIndex])]) {
                try {
                    const candidateBytes = await this._readBytes(
                        url, provenance.indexSize || MAX_INDEX_BYTES);
                    const candidateSha = await sha256Hex(candidateBytes);
                    if (provenance.indexSize != null
                        && candidateBytes.byteLength !== provenance.indexSize) {
                        throw new Error('Catalogue index size does not match its release descriptor.');
                    }
                    if (provenance.indexSha256 && candidateSha !== provenance.indexSha256) {
                        throw new Error('Catalogue index SHA-256 does not match its release descriptor.');
                    }
                    indexBytes = candidateBytes;
                    indexSha256 = candidateSha;
                    indexUrl = url;
                    break;
                } catch (error) {
                    indexError = error;
                }
            }
            if (!indexBytes) throw indexError || new Error('Catalogue index is unavailable.');
            provenance.indexSha256 = indexSha256;
            provenance.indexSize = indexBytes.byteLength;
            provenance.loadedIndexUrl = indexUrl;
            const validated = validateIndex(
                decodeJson(indexBytes, MAX_INDEX_BYTES, 'Catalogue index'), provenance);
            const id = `${pointerId(config)}@${provenance.commit}:${indexSha256}`;
            return {
                id,
                schema: 1,
                pointerId: pointerId(config),
                config,
                descriptorBytes,
                indexBytes,
                provenance,
                entries: validated.entries,
                fetchedAt: this.now(),
            };
        }

        async _restoreRecord(record, requestedConfig) {
            if (!record || record.schema !== 1 || !record.provenance) return null;
            try {
                const config = normalizeConfig(record.config, { strict: true });
                const requested = normalizeConfig(requestedConfig, { strict: true });
                if (record.pointerId !== pointerId(requested)
                    || config.mode !== requested.mode
                    || config.value !== requested.value
                    || config.siteBase !== requested.siteBase) return null;
                const provenance = { ...record.provenance };
                if ((config.mode === 'stable' || config.mode === 'release')
                    && !record.descriptorBytes) return null;
                if (record.descriptorBytes) {
                    const restored = validateDescriptor(
                        decodeJson(record.descriptorBytes, MAX_DESCRIPTOR_BYTES, 'Cached release descriptor'),
                        config.siteBase,
                        config.mode === 'release' ? config.value : undefined);
                    Object.assign(provenance, restored);
                    provenance.descriptorUrl = config.mode === 'stable'
                        ? joinBase(config.siteBase, 'stable.json')
                        : joinBase(config.siteBase, `releases/${config.value}/release.json`);
                } else {
                    const commit = config.mode === 'commit' ? config.value : provenance.commit;
                    if (!COMMIT_RE.test(String(commit || ''))) return null;
                    const rawBase = `${RAW_ROOT}${commit}/`;
                    Object.assign(provenance, {
                        commit,
                        rawBase,
                        catalogUrl: joinBase(rawBase, 'scirepl-catalog.json'),
                        artifactBaseUrl: rawBase,
                    });
                }
                const expectedSelector = config.mode === 'stable' ? 'stable' : config.value;
                if (provenance.channel !== config.mode
                    || provenance.selector !== expectedSelector) return null;
                const allowedIndexUrls = new Set([
                    provenance.catalogUrl,
                    joinBase(provenance.rawBase, 'scirepl-catalog.json'),
                ]);
                if (!allowedIndexUrls.has(provenance.loadedIndexUrl)) return null;
                const indexBytes = bytesOf(record.indexBytes);
                const digest = await sha256Hex(indexBytes);
                if (digest !== provenance.indexSha256 || indexBytes.byteLength !== provenance.indexSize) {
                    return null;
                }
                const expectedId = `${pointerId(requested)}@${provenance.commit}:${digest}`;
                if (record.id !== expectedId) return null;
                const validated = validateIndex(
                    decodeJson(indexBytes, MAX_INDEX_BYTES, 'Cached catalogue index'), provenance);
                return { ...record, provenance, entries: validated.entries };
            } catch (_) {
                return null;
            }
        }

        async _cached(config) {
            const key = pointerId(config);
            if (this._memory.has(key)) return this._memory.get(key);
            try {
                const pointer = await this.db.get('pointers', key);
                const record = pointer ? await this.db.get('snapshots', pointer.snapshotId) : null;
                const restored = await this._restoreRecord(record, config);
                if (restored) this._memory.set(key, restored);
                return restored;
            } catch (_) {
                return null;
            }
        }

        _isStale(record, config) {
            if (!record) return true;
            if (config.mode === 'release' || config.mode === 'commit') return false;
            return this.now() - Number(record.fetchedAt || 0) >= CACHE_TTL_MS;
        }

        async _activate(candidate, { replacePin = false } = {}) {
            const tag = candidate.provenance.tag;
            const pin = tag ? {
                    tag,
                    commit: candidate.provenance.commit,
                    indexSha256: candidate.provenance.indexSha256,
                    firstSeenAt: this.now(),
                    lastSeenAt: this.now(),
                } : null;
            const persisted = {
                ...candidate,
                entries: undefined,
            };
            const pointer = {
                id: candidate.pointerId,
                snapshotId: candidate.id,
                checkedAt: this.now(),
            };
            const activation = await this.db.activate(
                persisted, pointer, pin, { replacePin });
            if (!activation || activation.activated !== true) {
                return { activated: false, pin: activation && activation.pin || null };
            }
            this._memory.set(candidate.pointerId, candidate);
            return { activated: true, candidate, pin: activation.pin || pin };
        }

        async load(options = {}) {
            const config = this.getConfig();
            const cached = await this._cached(config);
            const stale = this._isStale(cached, config);
            if (options.allowNetwork === false || (!options.refresh && !stale)) {
                return cached
                    ? resultFromSnapshot(cached, stale ? 'cached-stale' : 'cached', stale)
                    : resultFromSnapshot(null, 'bundled-only', true);
            }
            const key = pointerId(config);
            if (this._inFlight.has(key) && !options.refresh) return this._inFlight.get(key);
            const generation = (this._refreshGeneration.get(key) || 0) + 1;
            this._refreshGeneration.set(key, generation);
            const run = (async () => {
                try {
                    await this.beforeNetwork();
                    const candidate = await this._fetchCandidate(config);
                    if (this._refreshGeneration.get(key) !== generation) {
                        const current = await this._cached(config);
                        return current
                            ? resultFromSnapshot(current, 'cached', false, { superseded: true })
                            : resultFromSnapshot(null, 'bundled-only', true, { superseded: true });
                    }
                    if (config.mode === 'stable' && cached
                        && compareReleaseTags(candidate.provenance.tag, cached.provenance.tag) < 0) {
                        return resultFromSnapshot(cached, 'refresh-failed', true, {
                            error: `Stable catalogue rollback blocked (${cached.provenance.tag} → ${candidate.provenance.tag}). Select the older release explicitly if intended.`,
                        });
                    }
                    const activation = await this._activate(candidate);
                    if (!activation.activated) {
                        this._movedCandidate = candidate;
                        return resultFromSnapshot(cached, 'tag-moved', !!cached, {
                            candidate: candidate.provenance,
                            trusted: activation.pin,
                            needsRefresh: false,
                        });
                    }
                    this._movedCandidate = null;
                    return resultFromSnapshot(candidate, 'verified', false, { needsRefresh: false });
                } catch (error) {
                    return cached
                        ? resultFromSnapshot(cached, 'refresh-failed', true, {
                            error: error && error.message || String(error),
                        })
                        : resultFromSnapshot(null, 'unavailable', true, {
                            error: error && error.message || String(error),
                        });
                }
            })();
            this._inFlight.set(key, run);
            try { return await run; }
            finally { if (this._inFlight.get(key) === run) this._inFlight.delete(key); }
        }

        async acceptMovedTag() {
            if (!this._movedCandidate) throw new Error('There is no moved release tag to accept.');
            const candidate = this._movedCandidate;
            const activation = await this._activate(candidate, { replacePin: true });
            if (!activation.activated) throw new Error('The moved release tag could not be accepted.');
            this._movedCandidate = null;
            return resultFromSnapshot(candidate, 'verified', false, { needsRefresh: false });
        }

        async fetchArtifact(entry) {
            if (!entry || !entry._catalog || entry.sourceId !== SOURCE_ID) {
                throw new Error('This is not an official remote catalogue item.');
            }
            const meta = entry._catalog;
            if (!Number.isSafeInteger(meta.size) || meta.size <= 0
                || meta.size > MAX_ARTIFACT_BYTES || !SHA_RE.test(String(meta.sha256 || ''))) {
                throw new Error('Workbook integrity metadata is invalid.');
            }
            const cached = await this.db.get('artifacts', meta.sha256).catch(() => null);
            if (cached && cached.size === meta.size && cached.format === entry.format) {
                const bytes = bytesOf(cached.bytes);
                if (bytes.byteLength === meta.size && await sha256Hex(bytes) === meta.sha256) {
                    return new Blob([bytes], { type: entry.format === 'ipynb'
                        ? 'application/x-ipynb+json' : 'application/json' });
                }
            }
            await this.beforeNetwork();
            let bytes = null;
            let lastError = null;
            for (const url of [...new Set([meta.artifactUrl, meta.rawUrl].filter(Boolean))]) {
                try {
                    bytes = await this._readBytes(url, meta.size);
                    if (bytes.byteLength !== meta.size) {
                        throw new Error('Workbook size does not match the catalogue.');
                    }
                    const digest = await sha256Hex(bytes);
                    if (digest !== meta.sha256) {
                        throw new Error('Workbook SHA-256 does not match the catalogue.');
                    }
                    break;
                } catch (error) {
                    bytes = null;
                    lastError = error;
                }
            }
            if (!bytes) throw lastError || new Error('Workbook download failed.');
            await this.db.put('artifacts', {
                sha256: meta.sha256,
                bytes,
                size: meta.size,
                format: entry.format,
                cachedAt: this.now(),
            }).catch(() => {});
            return new Blob([bytes], { type: entry.format === 'ipynb'
                ? 'application/x-ipynb+json' : 'application/json' });
        }

        async clearCache() {
            this._memory.clear();
            this._movedCandidate = null;
            this._inFlight.clear();
            this._refreshGeneration.clear();
            await this.db.clear();
        }
    }

    return {
        SOURCE_ID,
        SOURCE_LABEL,
        PAGES_ROOT,
        RAW_ROOT,
        API_ROOT,
        SETTINGS_KEY,
        CACHE_TTL_MS,
        MAX_DESCRIPTOR_BYTES,
        MAX_INDEX_BYTES,
        MAX_ITEMS,
        MAX_REQUIRES,
        KNOWN_DEPENDENCIES,
        MAX_ARTIFACT_BYTES,
        DEFAULT_CONFIG,
        normalizeBaseUrl,
        normalizeConfig,
        normalizeBranch,
        pointerId,
        compareReleaseTags,
        safeRelativePath,
        joinBase,
        sha256Hex,
        decodeJson,
        validateDescriptor,
        validateIndex,
        CatalogDb,
        CatalogSourceManager,
    };
}));
