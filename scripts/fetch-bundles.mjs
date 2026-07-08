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

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WWW = join(ROOT, 'www');
const PROFILES_PATH = join(ROOT, 'build-profiles.json');

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full';
const SWIPL_SRC = 'https://SWI-Prolog.github.io/npm-swipl-wasm/3/latest/dynamic-import.js';
const SCITTLE_SRC = 'https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js'; // keep in sync with kernels/clojurescript.js
const WEBR_VERSION = '0.5.4'; // npm version; keep in sync with kernels/r.js DEFAULT_WEBR_VERSION ('v' + this)

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

// webR is a multi-file runtime (R.wasm + a packaged VFS) loaded from a base URL,
// not a single script. Enumerate the runtime files under the npm package's dist/
// via the jsdelivr data API, then mirror them into www/vendor/webr/ preserving
// paths, so r.js can point webR's baseUrl at the local copy. ~50 MB total.
async function listWebrDistFiles(version) {
  const api = `https://data.jsdelivr.com/v1/packages/npm/webr@${version}`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`HTTP ${res.status} listing webr@${version}`);
  const tree = await res.json();
  const out = [];
  // Dev-only files webR never fetches at runtime.
  const skip = (rel) =>
    rel.endsWith('.map') || rel.endsWith('.d.ts') || rel.endsWith('.cjs') ||
    rel === 'esbuild.d.ts' || rel.startsWith('tests/') || rel.startsWith('repl/');
  const walk = (node, prefix) => {
    for (const f of node.files || []) {
      const p = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.type === 'directory') walk(f, p);
      else if (p.startsWith('dist/')) {
        const rel = p.slice('dist/'.length);
        if (!skip(rel)) out.push(rel);
      }
    }
  };
  walk(tree, '');
  return out;
}

async function bundleR() {
  const files = await listWebrDistFiles(WEBR_VERSION);
  console.log(`  webR ${WEBR_VERSION}: ${files.length} runtime files`);
  for (const rel of files) {
    // Skip downloading a .data.gz we've already decompressed to .data (idempotent).
    if (rel.endsWith('.data.gz')) {
      const dataAbs = join(WWW, 'vendor', 'webr', rel.replace(/\.gz$/, ''));
      if (existsSync(dataAbs) && statSync(dataAbs).size > 0) { console.log(`  ✓ cached  vendor/webr/${rel.replace(/\.gz$/, '')}`); continue; }
    }
    const url = `https://cdn.jsdelivr.net/npm/webr@${WEBR_VERSION}/dist/${rel}`;
    await download(url, join(WWW, 'vendor', 'webr', rel));
  }
  // The Android/Capacitor WebView asset server returns a bad status for `.gz`
  // assets (it serves `.js.metadata` and plain binaries fine), which breaks
  // webR's on-demand image mounts. Decompress every `.data.gz` to a plain
  // `.data` and flip the sibling metadata's gzip flag so webR fetches `.data`.
  // The APK zip re-compresses these, so on-device size is ~unchanged.
  let decompressed = 0;
  for (const rel of files) {
    if (!rel.endsWith('.data.gz')) continue;
    const gz = join(WWW, 'vendor', 'webr', rel);
    if (!existsSync(gz)) continue;
    const data = gz.replace(/\.gz$/, '');
    writeFileSync(data, gunzipSync(readFileSync(gz)));
    const meta = data.replace(/\.data$/, '.js.metadata');
    if (existsSync(meta)) {
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      if (m.gzip) { m.gzip = false; writeFileSync(meta, JSON.stringify(m)); }
    }
    unlinkSync(gz);
    decompressed++;
  }
  if (decompressed) console.log(`  decompressed ${decompressed} .data.gz → .data (Android serves .gz with a bad status)`);
}

const HANDLERS = { python: bundlePython, prolog: bundleProlog, clojurescript: bundleClojurescript, r: bundleR };

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
