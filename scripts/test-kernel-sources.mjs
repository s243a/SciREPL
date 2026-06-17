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

// ── Build a fresh KernelManager in a sandbox with the given config/override ──
function makeManager({ config, overrides = {} } = {}) {
  const store = new Map(Object.entries(overrides));
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { KERNEL_CONFIG: config },
    document: { addEventListener() {}, getElementById() { return null; } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox, { filename: 'kernel_manager.js' });
  return sandbox.window.kernelManager;
}

const FULL = {
  profile: 'full',
  languages: {
    lua: { enabled: true, timeoutMs: 200, sources: [{ type: 'cdn', url: 'MIRROR_A' }, { type: 'cdn', url: 'MIRROR_B' }] },
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
});

await test('override is tried before primary', async () => {
  const km = makeManager({ config: FULL, overrides: { scirepl_lua_source: 'OVERRIDE' } });
  const tried = [];
  const r = await km.loadKernelSource('lua', 'PRIMARY', (u) => { tried.push(u); return ok('v')(u); });
  eq(tried[0], 'OVERRIDE', 'override first');
  eq(r.url, 'OVERRIDE', 'returned override');
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

await test('profile-disabled language → throws immediately, never calls loadFn', async () => {
  const km = makeManager({ config: FULL }); // python.enabled = false
  let called = false, threw = null;
  try { await km.loadKernelSource('python', 'PRIMARY', () => { called = true; return ok('v')('x'); }); }
  catch (e) { threw = e; }
  assert(threw, 'should have thrown');
  assert(/not enabled in this build/.test(threw.message), 'disabled message: ' + threw.message);
  assert(!called, 'loadFn must not be called for a disabled language');
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
  const r = await km.loadKernelSource('python', 'PRIMARY_CDN', (u) => { tried.push(u); return ok('v')(u); });
  eq(tried[0], 'vendor/pyodide/pyodide.js', 'local first');
  eq(r.url, 'vendor/pyodide/pyodide.js', 'returned local');
});

await test('preferLocal → missing local file falls back to CDN primary', async () => {
  const km = makeManager({ config: BUNDLED });
  const tried = [];
  const r = await km.loadKernelSource('python', 'PRIMARY_CDN',
    (u) => { tried.push(u); return failOn(['vendor/pyodide/pyodide.js'])(u); });
  eq(tried[0], 'vendor/pyodide/pyodide.js', 'tried local first');
  eq(r.url, 'PRIMARY_CDN', 'recovered on CDN primary');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
