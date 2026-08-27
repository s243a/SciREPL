/**
 * Node-only regression tests for the verified remote catalogue source layer.
 *
 * No live network or browser IndexedDB is used. Fetch, time, settings, and the
 * atomic database boundary are injected so channel selection, byte integrity,
 * last-good fallback, moved-tag handling, and artifact caching stay
 * deterministic in CI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const C = require(path.join(ROOT, 'www', 'js', 'catalog_source.js'));

const encoder = new TextEncoder();
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const TAG = 'v1.2.3';
const NOW = 2_000_000_000_000;

const bytes = value => value instanceof Uint8Array
    ? value
    : encoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
const digest = value => createHash('sha256').update(bytes(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  [PASS] ${name}`);
    } catch (error) {
        failed++;
        console.error(`  [FAIL] ${name}: ${error && error.stack || error}`);
    }
}

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem(key) { return data.has(key) ? data.get(key) : null; },
        setItem(key, value) { data.set(key, String(value)); },
        removeItem(key) { data.delete(key); },
        data,
    };
}

class MemoryDb {
    constructor() {
        this.stores = Object.fromEntries(
            ['snapshots', 'pointers', 'pins', 'artifacts'].map(name => [name, new Map()]),
        );
        this.activations = 0;
    }

    async get(store, key) {
        return this.stores[store].get(key) || null;
    }

    async put(store, value) {
        const key = store === 'pins' ? value.tag
            : store === 'artifacts' ? value.sha256 : value.id;
        this.stores[store].set(key, value);
    }

    async activate(candidate, pointer, proposedPin, { replacePin = false } = {}) {
        // This method is deliberately one operation: the manager must not
        // publish a pointer until the complete candidate has verified.
        this.activations++;
        const existing = proposedPin ? this.stores.pins.get(proposedPin.tag) : null;
        if (existing && !replacePin
            && (existing.commit !== proposedPin.commit
                || existing.indexSha256 !== proposedPin.indexSha256)) {
            return { activated: false, pin: existing };
        }
        const pin = proposedPin ? {
            ...proposedPin,
            firstSeenAt: existing && !replacePin
                ? existing.firstSeenAt : proposedPin.firstSeenAt,
        } : null;
        this.stores.snapshots.set(candidate.id, candidate);
        this.stores.pointers.set(pointer.id, pointer);
        if (pin) this.stores.pins.set(pin.tag, pin);
        return { activated: true, pin };
    }

    async clear() {
        Object.values(this.stores).forEach(store => store.clear());
    }
}

function response(body, { status = 200, headers = {}, url = '' } = {}) {
    const out = new Response(body, { status, headers });
    if (url) Object.defineProperty(out, 'url', { configurable: true, value: url });
    return out;
}

function mockFetch(routes, calls = []) {
    const table = routes instanceof Map ? routes : new Map(Object.entries(routes));
    return async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (!table.has(String(url))) throw new Error(`Unexpected request: ${url}`);
        let route = table.get(String(url));
        if (Array.isArray(route)) {
            if (!route.length) throw new Error(`Exhausted response queue: ${url}`);
            route = route.shift();
        }
        if (typeof route === 'function') route = await route(String(url), options);
        if (route instanceof Error) throw route;
        if (route && route.throw) throw route.throw;
        if (route instanceof Response) return route;
        if (route && Object.prototype.hasOwnProperty.call(route, 'body')) {
            return response(route.body, {
                status: route.status,
                headers: route.headers,
                url: route.url,
            });
        }
        return response(route);
    };
}

function workbookBytes(label = 'Cálculo de pi') {
    return bytes(JSON.stringify({
        format_version: '2.0',
        notebook: {
            name: label,
            cells: [{ id: 1, type: 'markdown', language: 'markdown', code: `# ${label}` }],
        },
    }, null, 2) + '\n');
}

function makeIndex({ artifact = workbookBytes(), item = {}, index = {} } = {}) {
    return {
        format_version: '2.0',
        name: 'SciREPL Catalog',
        source: 'https://github.com/s243a/SciREPL-Catalog',
        locales: ['es'],
        items: [{
            id: 'compute-pi-es',
            name: 'Cálculo de Pi',
            description: 'Edición en español.',
            type: 'workbook',
            kernels: ['python'],
            locales: ['es'],
            format: 'srwb',
            path: 'workbooks/es/compute-pi-workbook.srwb',
            revision: 2,
            sha256: digest(artifact),
            size: artifact.byteLength,
            ...item,
        }],
        ...index,
    };
}

function makeRelease({
    tag = TAG,
    commit = COMMIT_A,
    artifact = workbookBytes(),
    item,
    index,
    descriptor,
    siteBase = C.PAGES_ROOT,
} = {}) {
    const indexObject = makeIndex({ artifact, item, index });
    const indexBytes = bytes(JSON.stringify(indexObject, null, 2) + '\n');
    const descriptorObject = {
        schema: 1,
        tag,
        commit,
        date: '2026-08-14T21:08:44-06:00',
        catalog: `releases/${tag}/catalog.json`,
        files_base: `releases/${tag}/files/`,
        raw_base: `${C.RAW_ROOT}${commit}/`,
        index: {
            sha256: digest(indexBytes),
            size: indexBytes.byteLength,
            format_version: '2.0',
            items: indexObject.items.length,
        },
        ...descriptor,
    };
    const descriptorBytes = bytes(JSON.stringify(descriptorObject, null, 2) + '\n');
    const catalogUrl = `${siteBase}releases/${tag}/catalog.json`;
    const artifactUrl = `${siteBase}releases/${tag}/files/${indexObject.items[0].path}`;
    const rawArtifactUrl = `${C.RAW_ROOT}${commit}/${indexObject.items[0].path}`;
    return {
        siteBase,
        tag,
        commit,
        artifact,
        indexObject,
        indexBytes,
        descriptorObject,
        descriptorBytes,
        stableUrl: `${siteBase}stable.json`,
        releaseUrl: `${siteBase}releases/${tag}/release.json`,
        catalogUrl,
        artifactUrl,
        rawArtifactUrl,
        rawIndexUrl: `${C.RAW_ROOT}${commit}/scirepl-catalog.json`,
    };
}

function releaseRoutes(fixture, { descriptorUrl = fixture.stableUrl } = {}) {
    return new Map([
        [descriptorUrl, fixture.descriptorBytes],
        [fixture.catalogUrl, fixture.indexBytes],
        [fixture.artifactUrl, fixture.artifact],
        [fixture.rawArtifactUrl, fixture.artifact],
    ]);
}

function manager({
    routes = new Map(),
    calls = [],
    db = new MemoryDb(),
    storage = memoryStorage(),
    now = () => NOW,
    beforeNetwork = async () => {},
} = {}) {
    return new C.CatalogSourceManager({
        fetchImpl: mockFetch(routes, calls),
        db,
        storage,
        now,
        beforeNetwork,
    });
}

function provenanceFor(fixture) {
    return C.validateDescriptor(fixture.descriptorObject, fixture.siteBase);
}

console.log('1. Source configuration and path hardening');

await test('stable is the safe default and preserves an HTTPS mirror base', () => {
    assert.deepEqual(C.normalizeConfig(null), C.DEFAULT_CONFIG);
    assert.deepEqual(C.normalizeConfig({ mode: 'stable', value: 'ignored' }, { strict: true }), {
        mode: 'stable', value: '', siteBase: C.PAGES_ROOT,
    });
    assert.equal(C.normalizeBaseUrl('https://catalog.example/root'),
        'https://catalog.example/root/');
});

await test('release, full commit, and development branch values normalize strictly', () => {
    assert.equal(C.normalizeConfig({ mode: 'release', value: 'v2.3.4' }, { strict: true }).value,
        'v2.3.4');
    assert.equal(C.normalizeConfig({ mode: 'commit', value: COMMIT_A.toUpperCase() },
        { strict: true }).value, COMMIT_A);
    assert.equal(C.normalizeConfig({ mode: 'development', value: 'feature/catalog-v2' },
        { strict: true }).value, 'feature/catalog-v2');
    assert.throws(() => C.normalizeConfig({ mode: 'release', value: 'v2.3.4-beta' },
        { strict: true }), /Release/);
    assert.throws(() => C.normalizeConfig({ mode: 'commit', value: COMMIT_A.slice(0, 12) },
        { strict: true }), /40-character/);
    for (const branch of [
        '../main', '/main', 'main/', 'a\\b', 'a@{upstream}', 'a//b', 'a:b',
        'feature branch', '@', '.hidden/main', 'main.', 'topic.lock',
    ]) {
        assert.throws(() => C.normalizeBranch(branch), /safe/, branch);
    }
});

await test('remote bases require HTTPS, no credentials, query, or fragment', () => {
    assert.equal(C.normalizeBaseUrl('http://127.0.0.1:8765/catalog'),
        'http://127.0.0.1:8765/catalog/');
    assert.equal(C.normalizeBaseUrl('http://[::1]:8765/catalog'),
        'http://[::1]:8765/catalog/');
    assert.throws(() => C.normalizeConfig({ mode: 'unknown' }, { strict: true }),
        /Unknown catalogue source mode/);
    for (const base of [
        'http://catalog.example/',
        'https://user:secret@catalog.example/',
        'https://catalog.example/?channel=stable',
        'https://catalog.example/#stable',
        'file:///catalog/',
    ]) {
        assert.throws(() => C.normalizeBaseUrl(base), /Invalid catalogue host/, base);
    }
});

await test('repository paths reject traversal, absolute, drive, UNC, ADS, and URL syntax', () => {
    assert.equal(C.safeRelativePath('workbooks/es/pi.srwb'), 'workbooks/es/pi.srwb');
    assert.equal(C.joinBase(C.PAGES_ROOT, 'workbooks/es/pi.srwb'),
        `${C.PAGES_ROOT}workbooks/es/pi.srwb`);
    for (const unsafe of [
        '../pi.srwb', 'workbooks/../pi.srwb', '/etc/passwd', 'C:/pi.srwb',
        '\\\\server\\share\\pi.srwb', 'workbooks/es/pi.srwb:stream',
        'workbooks\\es\\pi.srwb', 'workbooks//pi.srwb', 'workbooks/./pi.srwb',
        'workbooks/%2e%2e/pi.srwb', 'workbooks/pi.srwb?raw=1',
        'workbooks/pi.srwb#fragment', '~/pi.srwb', 'workbooks/name./pi.srwb',
    ]) {
        assert.throws(() => C.safeRelativePath(unsafe), /Catalogue path/, unsafe);
    }
});

await test('pointer identities isolate mirrors and immutable selections', () => {
    assert.notEqual(
        C.pointerId({ mode: 'stable', siteBase: C.PAGES_ROOT }),
        C.pointerId({ mode: 'stable', siteBase: 'https://mirror.example/catalog/' }),
    );
    assert.match(C.pointerId({ mode: 'release', value: TAG }), /^release:/);
    assert.equal(C.pointerId({ mode: 'commit', value: COMMIT_A }), `commit:${COMMIT_A}`);
});

console.log('2. Descriptor and index validation');

await test('release descriptor resolves site-root paths and pins the raw mirror', () => {
    const fixture = makeRelease();
    const value = C.validateDescriptor(fixture.descriptorObject, fixture.siteBase, TAG);
    assert.equal(value.catalogUrl, fixture.catalogUrl);
    assert.equal(value.artifactBaseUrl, `${fixture.siteBase}releases/${TAG}/files/`);
    assert.equal(value.rawBase, `${C.RAW_ROOT}${COMMIT_A}/`);
    assert.equal(value.indexSha256, digest(fixture.indexBytes));
});

await test('descriptor rejects schema, tag, commit, path, raw-base, and index lies', () => {
    const fixture = makeRelease();
    const cases = [
        value => { value.schema = 2; },
        value => { value.tag = 'latest'; },
        value => { value.commit = 'abc'; },
        value => { value.date = 'not-a-date'; },
        value => { value.catalog = `releases/${TAG}/../catalog.json`; },
        value => { value.files_base = 'files/'; },
        value => { value.raw_base = `${C.RAW_ROOT}${COMMIT_B}/`; },
        value => { value.index.sha256 = 'short'; },
        value => { value.index.size = C.MAX_INDEX_BYTES + 1; },
        value => { value.index.items = C.MAX_ITEMS + 1; },
        value => { value.index.format_version = '1.0'; },
    ];
    for (const mutate of cases) {
        const candidate = clone(fixture.descriptorObject);
        mutate(candidate);
        assert.throws(() => C.validateDescriptor(candidate, fixture.siteBase, TAG));
    }
    assert.throws(() => C.validateDescriptor(fixture.descriptorObject, fixture.siteBase, 'v9.9.9'),
        /unexpected tag/);
});

await test('index produces official, namespaced, immutable workbook entries', () => {
    const requires = ['unifyweaver-scirepl'];
    const fixture = makeRelease({ item: { requires } });
    const validated = C.validateIndex(fixture.indexObject, provenanceFor(fixture));
    assert.equal(validated.entries.length, 1);
    const entry = validated.entries[0];
    assert.equal(entry.catalogKey, 'scirepl-catalog:compute-pi-es');
    assert.equal(entry.sourceId, C.SOURCE_ID);
    assert.equal(entry.official, true);
    assert.equal(entry.builtin, false);
    assert.deepEqual(entry.locales, ['es']);
    assert.equal(entry.pages_url, fixture.artifactUrl);
    assert.equal(entry.url, fixture.rawArtifactUrl);
    assert.deepEqual(entry.requires, ['unifyweaver-scirepl']);
    assert.notEqual(entry.requires, requires);
    assert(Object.isFrozen(entry.requires));
    assert.equal(entry._catalog.commit, COMMIT_A);
    assert.equal(entry._catalog.sha256, digest(fixture.artifact));
});

await test('index rejects malformed, duplicate, unsupported, and dishonest items', () => {
    const fixture = makeRelease();
    const provenance = provenanceFor(fixture);
    const cases = [
        value => { value.format_version = '1.0'; },
        value => { value.source = 'http://example.test/catalog'; },
        value => { value.items.push(clone(value.items[0])); },
        value => { value.items[0].id = '../pi'; },
        value => { value.items[0].type = 'package'; },
        value => { value.items[0].format = 'zip'; },
        value => { value.items[0].format = 'SRWB'; },
        value => { value.items[0].path = 'workbooks/es/pi.ipynb'; },
        value => { value.items[0].path = 'workbooks/es/compute-pi-workbook.SRWB'; },
        value => { value.items[0].sha256 = 'short'; },
        value => { value.items[0].size = 0; },
        value => { value.items[0].size = C.MAX_ARTIFACT_BYTES + 1; },
        value => { value.items[0].revision = 0; },
        value => { value.items[0].kernels = []; },
        value => { value.items[0].kernels = ['not valid']; },
        value => { value.items[0].kernels = ['fortran']; },
        value => { value.items[0].kernels = ['ai']; },
        value => { value.items[0].kernels = ['Python']; },
        value => { value.items[0].locales = ['not_a_locale']; },
        value => { value.items[0].name = 'bad\u202ename'; },
        value => { value.items[0].requires = null; },
        value => { value.items[0].requires = 'unifyweaver-scirepl'; },
        value => { value.items[0].requires = []; },
        value => { value.items[0].requires = [42]; },
        value => { value.items[0].requires = ['../package']; },
        value => { value.items[0].requires = ['unknown-package']; },
        value => { value.items[0].requires = ['bad\u202ename']; },
        value => { value.items[0].requires = ['unifyweaver-scirepl', 'unifyweaver-scirepl']; },
        value => {
            value.items[0].requires = Array.from(
                { length: C.MAX_REQUIRES + 1 }, (_, index) => `package-${index}`);
        },
    ];
    for (const mutate of cases) {
        const candidate = clone(fixture.indexObject);
        mutate(candidate);
        assert.throws(() => C.validateIndex(candidate, provenance));
    }
    assert.throws(() => C.validateIndex(fixture.indexObject, { ...provenance, itemCount: 2 }),
        /item count/);
});

await test('index rejects every unsafe artifact path before URL resolution', () => {
    const fixture = makeRelease();
    const provenance = provenanceFor(fixture);
    for (const artifactPath of [
        '../pi.srwb', '/pi.srwb', 'C:/pi.srwb', '\\\\host\\pi.srwb',
        'workbooks/pi.srwb:ads', 'workbooks/%2e%2e/pi.srwb',
        'https://evil.example/pi.srwb', 'workbooks/pi.srwb?x=1',
    ]) {
        const candidate = clone(fixture.indexObject);
        candidate.items[0].path = artifactPath;
        assert.throws(() => C.validateIndex(candidate, provenance), undefined, artifactPath);
    }
});

await test('JSON decoding is UTF-8 strict and bounded', () => {
    assert.deepEqual(C.decodeJson(bytes('{"ok":true}'), 64, 'Fixture'), { ok: true });
    assert.throws(() => C.decodeJson(Uint8Array.of(0xc3, 0x28), 64, 'Fixture'), /UTF-8/);
    assert.throws(() => C.decodeJson(bytes('{bad'), 64, 'Fixture'), /valid JSON/);
    assert.throws(() => C.decodeJson(new Uint8Array(65), 64, 'Fixture'), /size limit/);
});

await test('hashes cover fetched raw bytes, not parsed or reserialized JSON', async () => {
    const raw = bytes('{\n  "name": "Cálculo", "value": 1\n}\n');
    const reserialized = bytes(JSON.stringify(JSON.parse(new TextDecoder().decode(raw))));
    assert.equal(await C.sha256Hex(raw), digest(raw));
    assert.notEqual(await C.sha256Hex(raw), await C.sha256Hex(reserialized));
});

console.log('3. Channel selection and network policy');

await test('stable and release channels are API-free and use the Pages site root', async () => {
    for (const mode of ['stable', 'release']) {
        const fixture = makeRelease();
        const calls = [];
        const descriptorUrl = mode === 'stable' ? fixture.stableUrl : fixture.releaseUrl;
        const app = manager({ routes: releaseRoutes(fixture, { descriptorUrl }), calls });
        if (mode === 'release') app.setConfig({ mode, value: TAG });
        const result = await app.load({ refresh: true });
        assert.equal(result.status, 'verified', result.error);
        assert.deepEqual(calls.map(call => call.url), [descriptorUrl, fixture.catalogUrl]);
        assert.equal(calls.some(call => call.url.startsWith(C.API_ROOT)), false);
        assert.equal(result.entries[0].pages_url, fixture.artifactUrl);
        for (const call of calls) {
            assert.equal(call.options.credentials, 'omit');
            assert.equal(call.options.redirect, 'error');
            assert.equal(call.options.cache, 'no-store');
            assert.equal(call.options.referrerPolicy, 'no-referrer');
        }
    }
});

await test('a bad static index falls back only to the descriptor-pinned raw commit', async () => {
    const fixture = makeRelease();
    const corrupt = fixture.indexBytes.slice();
    corrupt[corrupt.byteLength - 2] ^= 1;
    const calls = [];
    const routes = releaseRoutes(fixture);
    routes.set(fixture.catalogUrl, corrupt);
    routes.set(fixture.rawIndexUrl, fixture.indexBytes);
    const result = await manager({ routes, calls }).load({ refresh: true });
    assert.equal(result.status, 'verified', result.error);
    assert.equal(result.provenance.loadedIndexUrl, fixture.rawIndexUrl);
    assert.deepEqual(calls.map(call => call.url), [
        fixture.stableUrl, fixture.catalogUrl, fixture.rawIndexUrl,
    ]);
});

await test('release tag trust fails closed when persistent trust storage is unavailable', async () => {
    const fixture = makeRelease();
    const source = new C.CatalogSourceManager({
        fetchImpl: mockFetch(releaseRoutes(fixture)),
        storage: memoryStorage(),
        db: new C.CatalogDb(null),
        now: () => NOW,
    });
    const result = await source.load({ refresh: true });
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /trust storage is unavailable/);
});

await test('a supplied full commit fetches raw immutable content without the API', async () => {
    const fixture = makeRelease();
    const calls = [];
    const app = manager({ routes: new Map([[fixture.rawIndexUrl, fixture.indexBytes]]), calls });
    app.setConfig({ mode: 'commit', value: COMMIT_A });
    const result = await app.load({ refresh: true });
    assert.equal(result.status, 'verified', result.error);
    assert.deepEqual(calls.map(call => call.url), [fixture.rawIndexUrl]);
    assert.equal(result.provenance.commit, COMMIT_A);
    assert.equal(result.entries[0].pages_url, fixture.rawArtifactUrl);
});

await test('development branch alone resolves through GitHub API, then pins raw SHA', async () => {
    const fixture = makeRelease({ commit: COMMIT_B });
    const branch = 'feature/catalog-v2';
    const apiUrl = `${C.API_ROOT}git/ref/heads/feature/catalog-v2`;
    const calls = [];
    const app = manager({
        routes: new Map([
            [apiUrl, bytes({ object: { sha: COMMIT_B } })],
            [fixture.rawIndexUrl, fixture.indexBytes],
        ]),
        calls,
    });
    app.setConfig({ mode: 'development', value: branch });
    const result = await app.load({ refresh: true });
    assert.equal(result.status, 'verified', result.error);
    assert.deepEqual(calls.map(call => call.url), [apiUrl, fixture.rawIndexUrl]);
    assert.equal(result.provenance.commit, COMMIT_B);
});

await test('cross-origin redirects and both declared and streamed oversize responses fail closed', async () => {
    const tooLarge = new Uint8Array(C.MAX_DESCRIPTOR_BYTES + 1);
    const cases = [
        response('{}', { url: 'https://evil.example/stable.json' }),
        { body: '{}', headers: { 'content-length': String(C.MAX_DESCRIPTOR_BYTES + 1) } },
        { body: tooLarge },
    ];
    for (const reply of cases) {
        const app = manager({ routes: new Map([[`${C.PAGES_ROOT}stable.json`, reply]]) });
        const result = await app.load({ refresh: true });
        assert.equal(result.status, 'unavailable');
        assert.match(result.error, /redirected|size limit/);
    }
});

await test('descriptor index size, digest, and count mismatches never activate', async () => {
    const fixture = makeRelease();
    const descriptors = [
        { ...fixture.descriptorObject,
            index: { ...fixture.descriptorObject.index, size: fixture.indexBytes.byteLength + 1 } },
        { ...fixture.descriptorObject,
            index: { ...fixture.descriptorObject.index, sha256: '0'.repeat(64) } },
        { ...fixture.descriptorObject,
            index: { ...fixture.descriptorObject.index, items: 2 } },
    ];
    for (const descriptorObject of descriptors) {
        const db = new MemoryDb();
        const routes = releaseRoutes(fixture);
        routes.set(fixture.stableUrl, bytes(JSON.stringify(descriptorObject)));
        const result = await manager({ routes, db }).load({ refresh: true });
        assert.equal(result.status, 'unavailable');
        assert.equal(db.activations, 0);
        assert.equal(db.stores.pointers.size, 0);
    }
});

console.log('4. Last-good cache, TTL, and moved tags');

await test('verified snapshots activate atomically and fresh stable loads avoid network', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    const calls = [];
    const app = manager({ routes: releaseRoutes(fixture), calls, db });
    const first = await app.load({ refresh: true });
    assert.equal(first.status, 'verified', first.error);
    assert.equal(db.activations, 1);
    assert.equal(db.stores.snapshots.size, 1);
    assert.equal(db.stores.pointers.size, 1);
    assert.equal(db.stores.pins.get(TAG).commit, COMMIT_A);
    const count = calls.length;
    const second = await app.load();
    assert.equal(second.status, 'cached');
    assert.equal(calls.length, count);
});

await test('a new manager restores and revalidates the cached raw bytes', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    await manager({ routes: releaseRoutes(fixture), db }).load({ refresh: true });
    const offline = manager({ routes: new Map(), db });
    const result = await offline.load({ allowNetwork: false });
    assert.equal(result.status, 'cached');
    assert.equal(result.entries[0].id, 'compute-pi-es');
});

await test('stable and named-release pointers sharing a commit retain distinct provenance', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    const storage = memoryStorage();
    const stable = manager({ routes: releaseRoutes(fixture), db, storage });
    assert.equal((await stable.load({ refresh: true })).provenance.channel, 'stable');

    const release = manager({
        routes: releaseRoutes(fixture, { descriptorUrl: fixture.releaseUrl }), db, storage,
    });
    release.setConfig({ mode: 'release', value: TAG });
    assert.equal((await release.load({ refresh: true })).provenance.channel, 'release');
    assert.equal(db.stores.snapshots.size, 2);

    stable.setConfig({ mode: 'stable' });
    const restored = await manager({ routes: new Map(), db, storage })
        .load({ allowNetwork: false });
    assert.equal(restored.status, 'cached');
    assert.equal(restored.provenance.channel, 'stable');
    assert.equal(restored.provenance.selector, 'stable');
});

await test('cold failure is unavailable; stale warm failure retains last-good entries', async () => {
    const cold = await manager({
        routes: new Map([[`${C.PAGES_ROOT}stable.json`, new Error('offline')]]),
    }).load({ refresh: true });
    assert.equal(cold.status, 'unavailable');
    assert.deepEqual(cold.entries, []);

    const fixture = makeRelease();
    const db = new MemoryDb();
    await manager({ routes: releaseRoutes(fixture), db }).load({ refresh: true });
    const warm = manager({
        routes: new Map([[fixture.stableUrl, new Error('offline')]]),
        db,
        now: () => NOW + C.CACHE_TTL_MS + 1,
    });
    const result = await warm.load();
    assert.equal(result.status, 'refresh-failed');
    assert.equal(result.stale, true);
    assert.equal(result.entries[0].id, 'compute-pi-es');
});

await test('release and commit snapshots are immutable and never age into a refresh', async () => {
    for (const mode of ['release', 'commit']) {
        const fixture = makeRelease();
        const db = new MemoryDb();
        const storage = memoryStorage();
        const routes = mode === 'release'
            ? releaseRoutes(fixture, { descriptorUrl: fixture.releaseUrl })
            : new Map([[fixture.rawIndexUrl, fixture.indexBytes]]);
        const online = manager({ routes, db, storage });
        online.setConfig({ mode, value: mode === 'release' ? TAG : COMMIT_A });
        assert.equal((await online.load({ refresh: true })).status, 'verified');
        let attempted = 0;
        const offline = manager({
            routes: new Map(), db, storage,
            now: () => NOW + 100 * C.CACHE_TTL_MS,
            beforeNetwork: async () => { attempted++; },
        });
        const restored = await offline.load();
        assert.equal(restored.status, 'cached');
        assert.equal(restored.stale, false);
        assert.equal(attempted, 0);
    }
});

await test('corrupt cached bytes are rejected instead of becoming last-good', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    await manager({ routes: releaseRoutes(fixture), db }).load({ refresh: true });
    const snapshot = [...db.stores.snapshots.values()][0];
    snapshot.indexBytes = bytes('{"format_version":"2.0"}');
    const restored = await manager({ routes: new Map(), db }).load({ allowNetwork: false });
    assert.equal(restored.status, 'bundled-only');
    assert.deepEqual(restored.entries, []);
});

await test('a failed refresh does not replace the active pointer', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    await manager({ routes: releaseRoutes(fixture), db }).load({ refresh: true });
    const pointerId = C.pointerId(C.DEFAULT_CONFIG);
    const before = db.stores.pointers.get(pointerId).snapshotId;
    const badDescriptor = clone(fixture.descriptorObject);
    badDescriptor.index.sha256 = '0'.repeat(64);
    const routes = releaseRoutes(fixture);
    routes.set(fixture.stableUrl, bytes(badDescriptor));
    const result = await manager({ routes, db }).load({ refresh: true });
    assert.equal(result.status, 'refresh-failed');
    assert.equal(db.stores.pointers.get(pointerId).snapshotId, before);
    assert.equal(db.activations, 1);
});

await test('an older concurrent refresh cannot roll the active pointer back', async () => {
    const older = makeRelease({ tag: TAG, commit: COMMIT_A });
    const newer = makeRelease({
        tag: 'v1.2.4', commit: COMMIT_B, artifact: workbookBytes('Revisión más nueva'),
    });
    const db = new MemoryDb();
    let releaseOlder;
    let markOlderStarted;
    const olderGate = new Promise(resolve => { releaseOlder = resolve; });
    const olderStarted = new Promise(resolve => { markOlderStarted = resolve; });
    const routes = new Map([
        [older.stableUrl, [
            async () => { markOlderStarted(); await olderGate; return older.descriptorBytes; },
            newer.descriptorBytes,
        ]],
        [older.catalogUrl, older.indexBytes],
        [newer.catalogUrl, newer.indexBytes],
    ]);
    const source = manager({ routes, db });
    const first = source.load({ refresh: true });
    await olderStarted;
    const second = source.load({ refresh: true });
    assert.equal((await second).provenance.commit, COMMIT_B);
    releaseOlder();
    const superseded = await first;
    assert.equal(superseded.superseded, true);
    const pointer = db.stores.pointers.get(C.pointerId(C.DEFAULT_CONFIG));
    assert.match(pointer.snapshotId, new RegExp(COMMIT_B));
});

await test('stable refuses a release rollback unless the older tag is selected explicitly', async () => {
    const newer = makeRelease({ tag: 'v1.2.4', commit: COMMIT_B });
    const older = makeRelease({ tag: TAG, commit: COMMIT_A });
    const db = new MemoryDb();
    assert.equal((await manager({ routes: releaseRoutes(newer), db })
        .load({ refresh: true })).provenance.tag, 'v1.2.4');
    const blocked = await manager({ routes: releaseRoutes(older), db })
        .load({ refresh: true });
    assert.equal(blocked.status, 'refresh-failed');
    assert.equal(blocked.provenance.tag, 'v1.2.4');
    assert.match(blocked.error, /rollback blocked/);

    const storage = memoryStorage();
    const release = manager({
        routes: releaseRoutes(older, { descriptorUrl: older.releaseUrl }), db, storage,
    });
    release.setConfig({ mode: 'release', value: TAG });
    assert.equal((await release.load({ refresh: true })).provenance.tag, TAG);
});

await test('a moved release tag is quarantined until explicitly accepted', async () => {
    const original = makeRelease({ commit: COMMIT_A });
    const moved = makeRelease({ commit: COMMIT_B, artifact: workbookBytes('Nueva revisión') });
    const db = new MemoryDb();
    const first = manager({ routes: releaseRoutes(original), db });
    assert.equal((await first.load({ refresh: true })).status, 'verified');

    const second = manager({ routes: releaseRoutes(moved), db });
    const held = await second.load({ refresh: true });
    assert.equal(held.status, 'tag-moved');
    assert.equal(held.provenance.commit, COMMIT_A);
    assert.equal(held.candidate.commit, COMMIT_B);
    assert.equal(db.stores.pins.get(TAG).commit, COMMIT_A);

    const accepted = await second.acceptMovedTag();
    assert.equal(accepted.status, 'verified');
    assert.equal(accepted.provenance.commit, COMMIT_B);
    assert.equal(db.stores.pins.get(TAG).commit, COMMIT_B);
    await assert.rejects(() => second.acceptMovedTag(), /no moved release tag/i);
});

console.log('5. Artifact integrity and cache');

await test('artifact download verifies bytes and an offline read returns the exact cache', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    const source = manager({ routes: releaseRoutes(fixture), db });
    const loaded = await source.load({ refresh: true });
    const entry = loaded.entries[0];
    const downloaded = new Uint8Array(await (await source.fetchArtifact(entry)).arrayBuffer());
    assert.deepEqual(downloaded, fixture.artifact);
    assert.equal(db.stores.artifacts.get(entry.sha256).size, fixture.artifact.byteLength);

    let network = 0;
    const offline = manager({
        routes: new Map(), db,
        beforeNetwork: async () => { network++; throw new Error('offline'); },
    });
    const cached = new Uint8Array(await (await offline.fetchArtifact(entry)).arrayBuffer());
    assert.deepEqual(cached, fixture.artifact);
    assert.equal(network, 0);
});

await test('a corrupt cached artifact is ignored and the verified raw mirror can repair Pages', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    const source = manager({ routes: releaseRoutes(fixture), db });
    const entry = (await source.load({ refresh: true })).entries[0];
    const corrupt = fixture.artifact.slice();
    corrupt[0] ^= 1;
    await db.put('artifacts', {
        sha256: entry.sha256, bytes: corrupt, size: corrupt.byteLength,
        format: entry.format, cachedAt: NOW,
    });
    const pageCorrupt = fixture.artifact.slice();
    pageCorrupt[pageCorrupt.length - 2] ^= 1;
    const calls = [];
    const repair = manager({
        db, calls,
        routes: new Map([
            [fixture.artifactUrl, pageCorrupt],
            [fixture.rawArtifactUrl, fixture.artifact],
        ]),
    });
    const repaired = new Uint8Array(await (await repair.fetchArtifact(entry)).arrayBuffer());
    assert.deepEqual(repaired, fixture.artifact);
    assert.deepEqual(calls.map(call => call.url), [fixture.artifactUrl, fixture.rawArtifactUrl]);
});

await test('size and hash mismatches on both mirrors fail without caching bytes', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    const source = manager({ routes: releaseRoutes(fixture), db });
    const entry = (await source.load({ refresh: true })).entries[0];
    const wrongSize = fixture.artifact.slice(0, -1);
    const wrongHash = fixture.artifact.slice();
    wrongHash[1] ^= 1;
    const broken = manager({
        db,
        routes: new Map([
            [fixture.artifactUrl, wrongSize],
            [fixture.rawArtifactUrl, wrongHash],
        ]),
    });
    await assert.rejects(() => broken.fetchArtifact(entry), /SHA-256|size/);
    assert.equal(db.stores.artifacts.has(entry.sha256), false);
});

await test('artifact API refuses entries outside the official verified source', async () => {
    await assert.rejects(
        () => manager().fetchArtifact({ id: 'fake', sourceId: 'community' }),
        /not an official remote catalogue item/,
    );
});

await test('clearCache removes snapshots, pointers, pins, artifacts, and memory state', async () => {
    const fixture = makeRelease();
    const db = new MemoryDb();
    const source = manager({ routes: releaseRoutes(fixture), db });
    const loaded = await source.load({ refresh: true });
    await source.fetchArtifact(loaded.entries[0]);
    await source.clearCache();
    for (const store of Object.values(db.stores)) assert.equal(store.size, 0);
    const result = await source.load({ allowNetwork: false });
    assert.equal(result.status, 'bundled-only');
});

console.log(`\n${failed ? `FAIL: ${failed} failed, ${passed} passed` : `PASS: ${passed} passed`}`);
process.exitCode = failed ? 1 : 0;
