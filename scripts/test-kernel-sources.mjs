#!/usr/bin/env node
/**
 * test-kernel-sources.mjs — deterministic tests for the resilient kernel loader.
 *
 * Loads the REAL KernelManager from www/js/kernel_manager.js in a Node vm
 * sandbox (with minimal window/document/localStorage shims) and drives
 * loadKernelSource() with a mock loadFn that succeeds, fails, or hangs on
 * demand. This exercises the CDN-robustness logic — candidate ordering,
 * per-kernel override, per-attempt timeout, fallthrough, and the
 * profile-disabled guard — WITHOUT any real network/CDN.
 *
 * Run: node scripts/test-kernel-sources.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'www', 'js', 'kernel_manager.js');
const GENERATED_CONFIG_SRC = join(__dirname, '..', 'www', 'js', 'kernel_config.js');

function loadGeneratedConfig() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(GENERATED_CONFIG_SRC, 'utf8'), sandbox, {
    filename: 'kernel_config.js',
  });
  return sandbox.window.KERNEL_CONFIG;
}

// ── Build a fresh KernelManager in a sandbox with the given config/override ──
function makeManager({ config, overrides = {}, platformApi = null, cacheStorage = null } = {}) {
  const store = new Map(Object.entries(overrides));
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { KERNEL_CONFIG: config, location: { href: 'https://app.example/index.html' } },
    URL,
    Request,
    Response,
    document: {
      baseURI: 'https://app.example/index.html',
      addEventListener() {},
      getElementById() { return null; },
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  if (cacheStorage) {
    sandbox.caches = cacheStorage;
    sandbox.window.caches = cacheStorage;
  }
  if (platformApi) sandbox.window.sciREPLPlatform = platformApi;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox, { filename: 'kernel_manager.js' });
  return sandbox.window.kernelManager;
}

function makeFakeCacheStorage() {
  const stores = new Map();
  const normalize = (request) => typeof request === 'string' ? request : request.url;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async keys() { return [...entries.keys()].map((url) => new Request(url)); },
      async match(request) {
        const response = entries.get(normalize(request));
        return response ? response.clone() : undefined;
      },
      async put(request, response) {
        entries.set(normalize(request), response.clone());
      },
      async delete(request) { return entries.delete(normalize(request)); },
    };
  };
  return {
    open,
    async seed(cacheName, url, body = 'runtime asset') {
      await (await open(cacheName)).put(url, new Response(body));
    },
    async remove(cacheName, url) { return (await open(cacheName)).delete(url); },
    async urls(cacheName) { return (await (await open(cacheName)).keys()).map((item) => item.url); },
  };
}

function loadKernelClass(relativeFile, className, { config = {}, overrides = {} } = {}) {
  const store = new Map(Object.entries(overrides));
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { KERNEL_CONFIG: config },
    document: { baseURI: 'https://example.test/' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };
  vm.createContext(sandbox);
  const file = join(__dirname, '..', 'www', 'js', 'kernels', relativeFile);
  vm.runInContext(`${readFileSync(file, 'utf8')}\nwindow.__KernelUnderTest = ${className};`, sandbox, {
    filename: relativeFile,
  });
  return sandbox.window.__KernelUnderTest;
}

const FULL = {
  profile: 'full',
  languages: {
    lua: { enabled: true, timeoutMs: 200, sources: [{ type: 'cdn', url: 'MIRROR_A' }, { type: 'cdn', url: 'MIRROR_B' }] },
    prolog: { enabled: true, version: '3.8.2', versionSelector: '3/8/2', timeoutMs: 200, sources: [
      { type: 'cdn', url: 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/8/2/dynamic-import.js' },
    ] },
    python: { enabled: false, timeoutMs: 200, sources: [] },
  },
};

// ── Tiny test runner ──
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message || e)); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { assert(a === b, (msg || 'eq') + `: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// loadFn factories
const ok = (val) => (url) => Promise.resolve({ url, val });
const failOn = (badUrls, val) => (url) =>
  badUrls.includes(url) ? Promise.reject(new Error('boom ' + url)) : Promise.resolve({ url, val });
const hangOn = (hangUrls, val) => (url) =>
  hangUrls.includes(url) ? new Promise(() => {}) /* never resolves */ : Promise.resolve({ url, val });

console.log('resilient kernel loader — deterministic tests\n');

await test('primary succeeds → returns primary, no fallback', async () => {
  const km = makeManager({ config: FULL });
  const tried = [];
  const r = await km.loadKernelSource('lua', 'PRIMARY', (u) => { tried.push(u); return ok('v')(u); });
  eq(r.url, 'PRIMARY', 'returned source');
  eq(tried.length, 1, 'only one attempt');
  eq(km.getRuntimeSessionSource('lua'), null,
    'loader success remains provisional until full runtime initialization');
  km._commitRuntimeSource('lua');
  eq(km.getRuntimeSessionSource('lua').source, 'PRIMARY', 'successful session source recorded');
  eq(km.getRuntimeSessionSource('lua').tested, false, 'ad-hoc primary is not marked tested');
});

await test('configured mirror success is recorded as a tested session source', async () => {
  const km = makeManager({ config: FULL });
  const r = await km.loadKernelSource('lua', 'PRIMARY', failOn(['PRIMARY']));
  eq(r.url, 'MIRROR_A', 'mirror loaded');
  eq(km.getRuntimeSessionSource('lua'), null,
    'fallback source is not exposed as Loaded before runtime initialization');
  km._commitRuntimeSource('lua');
  const loaded = km.getRuntimeSessionSource('lua');
  eq(loaded.source, 'MIRROR_A', 'exact source recorded');
  eq(loaded.tested, true, 'generated configured source marked tested');
});

await test('successful exact Prolog source records selector and source separately', async () => {
  const km = makeManager({ config: FULL });
  const url = 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/8/2/dynamic-import.js';
  await km.loadKernelSource('prolog', url, ok('v'));
  eq(km.getRuntimeSessionSource('prolog'), null,
    'exact-version loader success remains provisional');
  km._commitRuntimeSource('prolog');
  const loaded = km.getRuntimeSessionSource('prolog');
  eq(loaded.version, '3/8/2', 'resolved package selector recorded');
  eq(loaded.source, url, 'exact successful source recorded');
});

await test('override is tried before primary', async () => {
  const override = 'https://custom.example/runtime.js';
  const km = makeManager({ config: FULL, overrides: { scirepl_lua_source: override } });
  const tried = [];
  const r = await km.loadKernelSource('lua', 'PRIMARY', (u) => { tried.push(u); return ok('v')(u); });
  eq(tried[0], override, 'override first');
  eq(r.url, override, 'returned override');
});

await test('primary fails → falls through to config mirror', async () => {
  const km = makeManager({ config: FULL });
  const tried = [];
  const r = await km.loadKernelSource('lua', 'PRIMARY', (u) => { tried.push(u); return failOn(['PRIMARY'])(u); });
  eq(tried[0], 'PRIMARY', 'tried primary first');
  eq(r.url, 'MIRROR_A', 'recovered on first mirror');
});

await test('primary + first mirror fail → second mirror', async () => {
  const km = makeManager({ config: FULL });
  const r = await km.loadKernelSource('lua', 'PRIMARY', failOn(['PRIMARY', 'MIRROR_A']));
  eq(r.url, 'MIRROR_B', 'recovered on second mirror');
});

await test('all sources fail → rejects with aggregate error', async () => {
  const km = makeManager({ config: FULL });
  let threw = null;
  try { await km.loadKernelSource('lua', 'PRIMARY', failOn(['PRIMARY', 'MIRROR_A', 'MIRROR_B'])); }
  catch (e) { threw = e; }
  assert(threw, 'should have thrown');
  assert(/All sources failed for lua/.test(threw.message), 'aggregate message: ' + threw.message);
});

await test('hanging primary times out → falls through to mirror', async () => {
  const km = makeManager({ config: FULL }); // lua timeoutMs = 200ms
  const t0 = Date.now();
  const r = await km.loadKernelSource('lua', 'PRIMARY', hangOn(['PRIMARY']));
  const dt = Date.now() - t0;
  eq(r.url, 'MIRROR_A', 'recovered after timeout');
  assert(dt >= 180 && dt < 1500, 'timed out around 200ms, took ' + dt + 'ms');
});

await test('all sources hang → times out each, then rejects', async () => {
  const km = makeManager({ config: FULL });
  let threw = null;
  try { await km.loadKernelSource('lua', 'PRIMARY', hangOn(['PRIMARY', 'MIRROR_A', 'MIRROR_B'])); }
  catch (e) { threw = e; }
  assert(threw, 'should have thrown');
  assert(/timed out/.test(threw.message), 'timeout in message: ' + threw.message);
});

await test('profile-disabled-by-default language still loads when explicitly requested', async () => {
  const km = makeManager({ config: FULL }); // python.enabled = false
  let called = false;
  const r = await km.loadKernelSource('python', 'PRIMARY', (url) => {
    called = true;
    return ok('v')(url);
  });
  assert(called, 'loadFn must be called for a user-requested language');
  eq(r.url, 'PRIMARY', 'explicit request uses the kernel primary');
});

await test('no config → no entry uses default 60s timeout, primary still works', async () => {
  const km = makeManager({ config: null });
  const r = await km.loadKernelSource('lua', 'PRIMARY', ok('v'));
  eq(r.url, 'PRIMARY', 'works with no config');
});

// Bundled-build behavior: preferLocal makes the local source win before CDN.
const BUNDLED = {
  profile: 'full',
  languages: {
    python: { enabled: true, timeoutMs: 200, preferLocal: true, sources: [
      { type: 'local', url: 'vendor/pyodide/pyodide.js' },
      { type: 'cdn', url: 'CDN_MIRROR' },
    ] },
  },
};

await test('preferLocal → bundled local source is tried before the CDN primary', async () => {
  const km = makeManager({ config: BUNDLED });
  const tried = [];
  let confirmations = 0;
  km._confirmDownload = async () => { confirmations++; };
  const r = await km.loadKernelSource('python', 'PRIMARY_CDN', (u) => { tried.push(u); return ok('v')(u); });
  eq(tried[0], 'vendor/pyodide/pyodide.js', 'local first');
  eq(r.url, 'vendor/pyodide/pyodide.js', 'returned local');
  eq(confirmations, 0, 'bundled success needs no CDN confirmation');
});

await test('preferLocal → missing local file falls back to CDN primary', async () => {
  const km = makeManager({ config: BUNDLED });
  const tried = [];
  let confirmations = 0;
  km._ensurePrivacyConsent = async () => {};
  km._confirmDownload = async () => { confirmations++; };
  const r = await km.loadKernelSource('python', 'PRIMARY_CDN',
    (u) => { tried.push(u); return failOn(['vendor/pyodide/pyodide.js'])(u); });
  eq(tried[0], 'vendor/pyodide/pyodide.js', 'tried local first');
  eq(r.url, 'PRIMARY_CDN', 'recovered on CDN primary');
  eq(confirmations, 1, 'CDN fallback is confirmed once');
});

await test("override 'local' also forces local-first even without preferLocal", async () => {
  const cfg = { profile: 'full', languages: { lua: { enabled: true, timeoutMs: 200, sources: [
    { type: 'local', url: 'vendor/lua/local.js' }, { type: 'cdn', url: 'MIRROR_A' } ] } } };
  const km = makeManager({ config: cfg, overrides: { scirepl_lua_source: 'local' } });
  const tried = [];
  const r = await km.loadKernelSource('lua', 'PRIMARY', (u) => { tried.push(u); return ok('v')(u); });
  eq(tried[0], 'vendor/lua/local.js', 'local first via override');
  eq(r.url, 'vendor/lua/local.js', 'returned local');
});

await test("custom source override is strict and never falls back", async () => {
  const custom = 'https://custom.example/runtime.js';
  const km = makeManager({ config: FULL, overrides: { scirepl_lua_source: custom } });
  const tried = [];
  let threw = null;
  try {
    await km.loadKernelSource('lua', 'PRIMARY', (url) => {
      tried.push(url);
      return Promise.reject(new Error('custom failed'));
    });
  } catch (error) { threw = error; }
  assert(threw && /custom failed/.test(threw.message), 'custom failure should be visible');
  eq(JSON.stringify(tried), JSON.stringify([custom]), 'no implicit fallback after custom source');
});

await test('custom source validation requires HTTPS and rejects embedded credentials', async () => {
  const km = makeManager({ config: FULL });
  eq(km.validateRuntimeSourceOverride('lua', 'https://cdn.example/runtime.js'),
    'https://cdn.example/runtime.js', 'HTTPS accepted');
  for (const bad of [
    'http://cdn.example/runtime.js',
    'https://user:secret@cdn.example/runtime.js',
    'javascript:alert(1)',
  ]) {
    let threw = null;
    try { km.validateRuntimeSourceOverride('lua', bad); } catch (error) { threw = error; }
    assert(threw, `unsafe source rejected: ${bad}`);
  }
});

await test('loopback HTTP is accepted only under an explicit development flag', async () => {
  const denied = makeManager({ config: FULL });
  let threw = null;
  try { denied.validateRuntimeSourceOverride('lua', 'http://127.0.0.1:8080/runtime.js'); }
  catch (error) { threw = error; }
  assert(threw, 'production loopback HTTP rejected');
  const development = structuredClone(FULL);
  development.development = { allowLoopbackRuntimeSources: true };
  const allowed = makeManager({ config: development });
  eq(allowed.validateRuntimeSourceOverride('lua', 'http://localhost:8080/runtime.js'),
    'http://localhost:8080/runtime.js', 'explicit development loopback accepted');
});

await test('Electron host without immutable allowlist rejects arbitrary runtime source', async () => {
  const km = makeManager({ config: FULL, platformApi: Object.freeze({}) });
  let threw = null;
  try { km.validateRuntimeSourceOverride('lua', 'https://cdn.example/runtime.js'); }
  catch (error) { threw = error; }
  assert(threw && /Electron host policy/.test(threw.message), 'Electron CSP policy is preserved');
});

await test('current-revision consent fails closed when consent UI is unavailable', async () => {
  const km = makeManager({ config: FULL, overrides: { scirepl_privacy_accepted: '1' } });
  let threw = null;
  try { await km._ensurePrivacyConsent({ requireCurrentRevision: true }); }
  catch (error) { threw = error; }
  assert(threw && /Privacy policy must be accepted/.test(threw.message),
    'missing modal cannot silently authorise a request');
});

await test("override 'local' is strict and never falls back to a network source", async () => {
  const cfg = { profile: 'full', languages: { lua: { enabled: true, timeoutMs: 200, sources: [
    { type: 'local', url: 'vendor/lua/local.js' }, { type: 'cdn', url: 'MIRROR_A' } ] } } };
  const km = makeManager({ config: cfg, overrides: { scirepl_lua_source: 'local' } });
  const tried = [];
  let threw = null;
  try {
    await km.loadKernelSource('lua', 'PRIMARY', (url) => {
      tried.push(url);
      return Promise.reject(new Error('local missing'));
    });
  } catch (error) { threw = error; }
  assert(threw && /local missing/.test(threw.message), 'local failure should be visible');
  eq(JSON.stringify(tried), JSON.stringify(['vendor/lua/local.js']), 'strict local has no CDN fallback');
});

await test("override 'local' is rejected when generated config has no local source", async () => {
  const km = makeManager({ config: FULL, overrides: { scirepl_lua_source: 'local' } });
  let threw = null;
  try { await km.loadKernelSource('lua', 'PRIMARY', ok('v')); } catch (e) { threw = e; }
  assert(threw && /No bundled local source/.test(threw.message),
    'must not silently fall back to CDN while reporting local selected');
});

// Version-coherence assertions must exercise the checked-in generated table.
// A hand-written facsimile once contained a parameterized source template while
// the real generated config contained a literal tested-version URL, masking a
// cross-version fallback in production.
const FULL_PROLOG = loadGeneratedConfig();

await test('generated Prolog source retains an exact-version template', async () => {
  const source = FULL_PROLOG.languages?.prolog?.sources?.find((item) => item.type === 'cdn');
  eq(source?.url, 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/8/2/dynamic-import.js',
    'generated tested source');
  eq(source?.urlTemplate,
    'https://SWI-Prolog.github.io/npm-swipl-wasm/{versionSelector}/dynamic-import.js',
    'generated exact-version fallback template');
});

await test('generated ClojureScript CDN fallback requires consent and download confirmation', async () => {
  const km = makeManager({ config: FULL_PROLOG });
  const cfg = FULL_PROLOG.languages?.clojurescript;
  const local = cfg?.sources?.find((item) => item.type === 'local')?.url;
  const cdn = cfg?.sources?.find((item) => item.type === 'cdn')?.url;
  assert(local && cdn && cfg.preferLocal, 'generated full profile must bundle Scittle with a CDN fallback');
  assert(km.isNetworkRuntime('clojurescript'),
    'network-runtime classification must come from generated CDN capability');
  eq(km.constructor.RUNTIME_INFO.clojurescript?.name, 'ClojureScript (Scittle)',
    'download dialog has ClojureScript runtime information');

  let consent = 0;
  let confirmation = 0;
  km._ensurePrivacyConsent = async () => { consent++; };
  km._confirmDownload = async () => { confirmation++; };
  const tried = [];
  const result = await km.loadKernelSource('clojurescript', cdn, (url) => {
    tried.push(url);
    return url === local
      ? Promise.reject(new Error('bundled Scittle missing'))
      : ok('scittle')(url);
  });
  eq(JSON.stringify(tried), JSON.stringify([local, cdn]),
    'generated local source falls back to the pinned CDN source');
  eq(result.url, cdn, 'pinned ClojureScript CDN fallback succeeds');
  eq(consent, 1, 'external ClojureScript fallback requests privacy consent once');
  eq(confirmation, 1, 'external ClojureScript fallback requests download confirmation once');
});

await test('full-profile Prolog defaults to bundled tested runtime then pinned tested CDN', async () => {
  const km = makeManager({ config: FULL_PROLOG });
  km._ensurePrivacyConsent = async () => {};
  km._confirmDownload = async () => {};
  const tried = [];
  const pinned = 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/8/2/dynamic-import.js';
  const result = await km.loadKernelSource('prolog', pinned, (url) => {
    tried.push(url);
    return url.startsWith('vendor/') ? Promise.reject(new Error('missing local')) : ok('v')(url);
  });
  eq(JSON.stringify(tried), JSON.stringify(['vendor/swipl/dynamic-import.js', pinned]),
    'default candidates remain on tested version');
  eq(result.url, pinned, 'tested CDN fallback succeeds');
});

await test('full-profile Prolog explicit newer version failure never falls back to bundled or pinned tested code', async () => {
  const km = makeManager({
    config: FULL_PROLOG,
    overrides: { scirepl_swipl_version: '3/9/1' },
  });
  const exact = 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/9/1/dynamic-import.js';
  const tried = [];
  let threw = null;
  try {
    await km.loadKernelSource('prolog', exact, (url) => {
      tried.push(url);
      return Promise.reject(new Error('selected version unavailable'));
    });
  } catch (error) { threw = error; }
  assert(threw && /selected version unavailable/.test(threw.message),
    'selected-version failure must remain visible');
  eq(JSON.stringify(tried), JSON.stringify([exact]), 'only exact 3/9/1 candidate');
});

await test('full-profile Prolog manual tested version may use same-version local bundle', async () => {
  const km = makeManager({
    config: FULL_PROLOG,
    overrides: { scirepl_swipl_version: '3.8.2' },
  });
  const tried = [];
  const result = await km.loadKernelSource('prolog',
    'https://SWI-Prolog.github.io/npm-swipl-wasm/3/8/2/dynamic-import.js',
    (url) => { tried.push(url); return ok('v')(url); });
  eq(tried[0], 'vendor/swipl/dynamic-import.js', 'same tested version can use local provenance');
  eq(result.url, 'vendor/swipl/dynamic-import.js', 'local tested bundle loaded');
});

await test('strict local rejects a selected version that bundled provenance cannot satisfy', async () => {
  const km = makeManager({
    config: FULL_PROLOG,
    overrides: { scirepl_swipl_version: '3/9/1', scirepl_prolog_source: 'local' },
  });
  let threw = null;
  try {
    await km.loadKernelSource('prolog',
      'https://SWI-Prolog.github.io/npm-swipl-wasm/3/9/1/dynamic-import.js', ok('v'));
  } catch (error) { threw = error; }
  assert(threw && /cannot satisfy the selected version/.test(threw.message),
    'must explain local/version provenance mismatch');
});

const PRO_R = {
  profile: 'pro',
  languages: {
    r: {
      enabled: true,
      version: '0.5.4',
      versionTag: 'v0.5.4',
      timeoutMs: 200,
      preferLocal: true,
      overrideUrlTemplate: 'https://webr.r-wasm.org/{versionTag}/webr.mjs',
      sources: [
        { type: 'local', url: 'vendor/webr/webr.mjs' },
        {
          type: 'cdn',
          url: 'https://webr.r-wasm.org/v0.5.4/webr.mjs',
          urlTemplate: 'https://webr.r-wasm.org/{versionTag}/webr.mjs',
        },
        {
          type: 'cdn',
          url: 'https://cdn.jsdelivr.net/npm/webr@0.5.4/dist/webr.mjs',
          urlTemplate: 'https://cdn.jsdelivr.net/npm/webr@{version}/dist/webr.mjs',
        },
      ],
    },
  },
};

await test('Pro-profile R explicit newer version uses only exact-version CDN mirrors', async () => {
  const km = makeManager({ config: PRO_R, overrides: { scirepl_webr_version: 'v0.6.0' } });
  const official = 'https://webr.r-wasm.org/v0.6.0/webr.mjs';
  const mirror = 'https://cdn.jsdelivr.net/npm/webr@0.6.0/dist/webr.mjs';
  const tried = [];
  const result = await km.loadKernelSource('r', official, (url) => {
    tried.push(url);
    return url === official ? Promise.reject(new Error('official unavailable')) : ok('v')(url);
  });
  eq(JSON.stringify(tried), JSON.stringify([official, mirror]),
    'fallback stays entirely on selected 0.6.0');
  eq(result.url, mirror, 'exact-version mirror succeeds');
  assert(!tried.includes('vendor/webr/webr.mjs')
      && !tried.some(url => url.includes('0.5.4')),
    'must not mix selected and tested versions');
});

await test('runtime prompt suppression requires a completion receipt for the exact version', async () => {
  const cacheStorage = makeFakeCacheStorage();
  const km = makeManager({ config: PRO_R, cacheStorage });
  const source = 'https://webr.r-wasm.org/v0.5.4/webr.mjs';
  const support = 'https://webr.r-wasm.org/v0.5.4/webr-worker.js';
  const optional = 'https://webr.r-wasm.org/v0.5.4/vfs/optional-file';
  const probeMarker = km._runtimeProbeMarkerPrefix() + encodeURIComponent(optional);
  await cacheStorage.seed('scirepl-cdn-v3', source);
  await cacheStorage.seed('scirepl-cdn-v3', support);
  await cacheStorage.seed('scirepl-cdn-v3', probeMarker, JSON.stringify({
    schemaVersion: 1,
    method: 'HEAD',
    url: optional,
    status: 404,
    headers: {},
  }));
  eq(await km._hasCompleteCachedRuntime('r'), false,
    'same-host files without a success receipt do not suppress confirmation');

  km._recordRuntimeSource('r', source);
  km.recordRuntimeLoadedVersion('r', '0.5.4');
  eq(await km.markRuntimeCacheComplete('r'), true, 'successful exact runtime writes receipt last');
  eq(await km._hasCompleteCachedRuntime('r'), true,
    'complete exact-version inventory suppresses repeat confirmation');

  await cacheStorage.remove('scirepl-cdn-v3', support);
  eq(await km._hasCompleteCachedRuntime('r'), false,
    'missing one inventoried response invalidates the completion receipt');
  await cacheStorage.seed('scirepl-cdn-v3', support);
  await cacheStorage.remove('scirepl-cdn-v3', probeMarker);
  eq(await km._hasCompleteCachedRuntime('r'), false,
    'missing an inventoried immutable HEAD/404 probe also invalidates the receipt');
});

await test('per-runtime cache clearing preserves other runtimes on the same CDN host', async () => {
  const cacheStorage = makeFakeCacheStorage();
  const km = makeManager({ config: FULL_PROLOG, cacheStorage });
  const cacheName = km.constructor.CDN_CACHE;
  const lua = 'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js';
  const luaProbeTarget = 'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/optional.js';
  const luaProbe = km._runtimeProbeMarkerPrefix() + encodeURIComponent(luaProbeTarget);
  const luaReceipt = km._runtimeCacheMarkerUrl('lua', '0.1.4');
  const python = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js';
  const clojure = 'https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js';
  await cacheStorage.seed(cacheName, lua);
  await cacheStorage.seed(cacheName, luaReceipt, '{}');
  await cacheStorage.seed(cacheName, luaProbe, JSON.stringify({
    schemaVersion: 1,
    method: 'HEAD',
    url: luaProbeTarget,
    status: 404,
  }));
  await cacheStorage.seed(cacheName, python);
  await cacheStorage.seed(cacheName, clojure);

  eq(await km.hasRuntimeCacheEntries('lua'), true, 'Lua cache entries detected');
  eq(await km.clearRuntimeCache('lua'), 3, 'only Lua asset, receipt, and probe removed');
  const remaining = await cacheStorage.urls(cacheName);
  assert(remaining.includes(python) && remaining.includes(clojure),
    'other jsDelivr runtimes remain cached');
  assert(!remaining.includes(lua) && !remaining.includes(luaReceipt)
      && !remaining.includes(luaProbe), 'all Lua-owned entries removed');
});

await test('a completed tested runtime never suppresses a different selected version', async () => {
  const cacheStorage = makeFakeCacheStorage();
  const tested = makeManager({ config: PRO_R, cacheStorage });
  const oldSource = 'https://webr.r-wasm.org/v0.5.4/webr.mjs';
  await cacheStorage.seed('scirepl-cdn-v3', oldSource);
  tested._recordRuntimeSource('r', oldSource);
  tested.recordRuntimeLoadedVersion('r', '0.5.4');
  eq(await tested.markRuntimeCacheComplete('r'), true, 'tested receipt created');

  const newer = makeManager({
    config: PRO_R,
    cacheStorage,
    overrides: { scirepl_webr_version: 'v0.6.0' },
  });
  eq(await newer._hasCompleteCachedRuntime('r'), false,
    '0.5.4 receipt does not authorize a 0.6.0 load');
});

await test('custom runtime URLs cannot create a tested-version completion receipt', async () => {
  const cacheStorage = makeFakeCacheStorage();
  const custom = 'https://custom.example/webr/v0.5.4/webr.mjs';
  const km = makeManager({
    config: PRO_R,
    cacheStorage,
    overrides: { scirepl_r_source: custom },
  });
  await cacheStorage.seed('scirepl-cdn-v3', custom);
  km._recordRuntimeSource('r', custom);
  km.recordRuntimeLoadedVersion('r', '0.5.4');
  eq(await km.markRuntimeCacheComplete('r'), false,
    'custom executable source remains a fresh explicit trust choice');
  eq(await km._hasCompleteCachedRuntime('r'), false,
    'custom source never suppresses the prompt via tested provenance');
});

await test('malformed percent escapes cannot break exact-version cache classification', async () => {
  const km = makeManager({ config: PRO_R });
  eq(km._runtimeCacheUrlMatches('r', '0.5.4',
    'https://webr.r-wasm.org/v0.5.4/%ZZ-optional'), true,
  'raw pathname fallback remains safely classifiable');
});

await test('webR version override accepts exact semver/latest and rejects URL injection', async () => {
  const RKernel = loadKernelClass('r.js', 'RKernel');
  eq(RKernel.normalizeVersionTag('0.5.4'), 'v0.5.4', 'normalizes exact tag');
  eq(RKernel.normalizeVersionTag('v0.5.4'), 'v0.5.4', 'keeps exact tag');
  eq(RKernel.normalizeVersionTag('latest'), 'latest', 'explicit rolling selector');
  let threw = null;
  try { RKernel.normalizeVersionTag('https://evil.example/webr.mjs'); } catch (e) { threw = e; }
  assert(threw && /Invalid webR version/.test(threw.message), 'custom URL rejected from version field');
});

await test('Prolog package selector accepts documented forms and rejects URL injection', async () => {
  const PrologKernel = loadKernelClass('prolog.js', 'PrologKernel');
  eq(PrologKernel.normalizeSelector('3.8.2'), '3/8/2', 'dotted package selector');
  eq(PrologKernel.normalizeSelector('8/2'), '3/8/2', 'short package selector');
  eq(PrologKernel.normalizeSelector('3/8/2'), '3/8/2', 'full package selector');
  for (const incompatible of ['8.0.5', '8/0/5']) {
    let incompatibleThrew = null;
    try { PrologKernel.normalizeSelector(incompatible); } catch (e) { incompatibleThrew = e; }
    assert(incompatibleThrew && /compatible 3\.x/.test(incompatibleThrew.message),
      `incompatible package line rejected: ${incompatible}`);
  }
  let latestThrew = null;
  try { PrologKernel.normalizeSelector('latest'); } catch (e) { latestThrew = e; }
  assert(latestThrew && /incompatible release line/.test(latestThrew.message),
    'global latest must be rejected because it resolves to incompatible 8.x');
  let threw = null;
  try { PrologKernel.normalizeSelector('https://evil.example/swipl.mjs'); } catch (e) { threw = e; }
  assert(threw && /Invalid SWI-Prolog/.test(threw.message)
    && /Check latest/.test(threw.message) && /compatible 3\.x/.test(threw.message)
    && !/or "latest"/.test(threw.message),
    'custom URL rejected from version field with compatible-latest guidance');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
