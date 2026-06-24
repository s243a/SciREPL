#!/usr/bin/env node
/**
 * fetch-bundles.mjs — download the runtime assets a build profile bundles.
 *
 * Bundled runtimes (swipl, pyodide) are large (~38 MB) BUILD ARTIFACTS, not
 * committed to git (see .gitignore). This script downloads them into
 * www/vendor/<runtime>/ so `cap sync` copies them into the APK, giving the
 * `full` profile genuine offline support. It is idempotent — files already
 * present (non-empty) are skipped — and a no-op for profiles with no `bundle`.
 *
 * Keep versions in sync with the kernels:
 *   - pyodide → kernels/python.js primary (v0.27.4)
 *   - swipl   → kernels/prolog.js cdnUrl() (npm-swipl-wasm/3/latest)
 *
 * Run: node scripts/fetch-bundles.mjs [profile]   (or BUILD_PROFILE=full ...)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WWW = join(ROOT, 'www');
const PROFILES_PATH = join(ROOT, 'build-profiles.json');

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full';
const SWIPL_SRC = 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/latest/dynamic-import.js';
const SCITTLE_SRC = 'https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js'; // keep in sync with kernels/clojurescript.js

function fail(msg) { console.error('[fetch-bundles] ' + msg); process.exit(1); }

async function download(url, destAbs) {
  if (existsSync(destAbs) && statSync(destAbs).size > 0) {
    console.log(`  ✓ cached  ${destAbs.replace(WWW + '/', '')}`);
    return;
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destAbs, buf);
  console.log(`  ↓ ${(buf.length / 1048576).toFixed(1).padStart(5)} MB  ${destAbs.replace(WWW + '/', '')}`);
}

// Resolve a pyodide package + its transitive deps to wheel file names.
function resolvePyodidePackages(lockJson, wanted) {
  const pkgs = lockJson.packages;
  const byName = (n) => pkgs[n.toLowerCase()] || pkgs[n]
    || Object.values(pkgs).find((p) => p.name.toLowerCase() === n.toLowerCase());
  const seen = new Set(), files = [];
  const add = (name) => {
    const p = byName(name);
    if (!p) throw new Error('pyodide-lock.json missing package: ' + name);
    if (seen.has(p.name)) return;
    seen.add(p.name);
    files.push(p.file_name);
    (p.depends || []).forEach(add);
  };
  wanted.forEach(add);
  return files;
}

async function bundlePython() {
  const dir = join(WWW, 'vendor', 'pyodide');
  const core = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
  for (const f of core) await download(`${PYODIDE_BASE}/${f}`, join(dir, f));

  // Resolve the packages the Python kernel preloads (numpy, sympy, micropip).
  const lock = JSON.parse(readFileSync(join(dir, 'pyodide-lock.json'), 'utf8'));
  const wheels = resolvePyodidePackages(lock, ['numpy', 'sympy', 'micropip']);
  for (const w of wheels) await download(`${PYODIDE_BASE}/${w}`, join(dir, w));
}

async function bundleProlog() {
  await download(SWIPL_SRC, join(WWW, 'vendor', 'swipl', 'dynamic-import.js'));
}

async function bundleClojurescript() {
  await download(SCITTLE_SRC, join(WWW, 'vendor', 'scittle', 'scittle.js'));
}

const HANDLERS = { python: bundlePython, prolog: bundleProlog, clojurescript: bundleClojurescript };

async function main() {
  const spec = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
  const profileName = process.env.BUILD_PROFILE || process.argv[2] || spec.default;
  const profile = spec.profiles && spec.profiles[profileName];
  if (!profile) fail(`unknown profile '${profileName}'`);

  const bundle = profile.bundle || [];
  if (bundle.length === 0) {
    console.log(`[fetch-bundles] profile '${profileName}' bundles nothing — skipping.`);
    return;
  }
  console.log(`[fetch-bundles] profile '${profileName}' bundles: ${bundle.join(', ')}`);
  for (const lang of bundle) {
    const handler = HANDLERS[lang];
    if (!handler) { console.warn(`  ! no bundler for '${lang}' — skipping`); continue; }
    console.log(`[fetch-bundles] ${lang}:`);
    await handler();
  }
  console.log('[fetch-bundles] done.');
}

main().catch((e) => fail(e && e.message || String(e)));
