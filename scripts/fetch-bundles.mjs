#!/usr/bin/env node
/**
 * fetch-bundles.mjs — download the runtime assets a build profile bundles.
 *
 * Bundled runtimes (swipl, pyodide) are large (~38 MB) BUILD ARTIFACTS, not
 * committed to git (see .gitignore). This script downloads them into
 * www/vendor/<runtime>/ so `cap sync` copies them into the APK, giving the
 * `full` profile genuine offline support. A matching completion receipt makes
 * it idempotent; version/revision/source changes rebuild the whole runtime in a
 * sibling staging directory and atomically promote it only after verification.
 *
 * Exact versions and sources come from third-party-components.json; kernels
 * consume the same values through generated kernel_config.js.
 *
 * Run: node scripts/fetch-bundles.mjs [profile]   (or BUILD_PROFILE=full ...)
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { loadComponentManifest, readJson, resolvedRuntime } from './component-manifest.mjs';
import { installStagedBundle } from './bundle-staging.mjs';
import {
  PYODIDE_CORE_FILES, PYODIDE_WANTED_PACKAGES, runtimeBundleSpec,
} from './bundle-recipes.mjs';
import { verifyPyodideWheelNotices } from './pyodide-wheel-notices.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WWW = join(ROOT, 'www');
const PROFILES_PATH = join(ROOT, 'build-profiles.json');
const PROFILE_SPEC = readJson(PROFILES_PATH);
const PACKAGE_SPEC = readJson(join(ROOT, 'package.json'));
const { byId: COMPONENTS } = loadComponentManifest(ROOT);

function runtimeFor(language) {
  const componentId = PROFILE_SPEC.languages?.[language]?.component;
  const component = COMPONENTS.get(componentId);
  if (!component) throw new Error(`no component manifest entry for runtime '${language}'`);
  return { component, resolved: resolvedRuntime(component, PACKAGE_SPEC) };
}

const PYODIDE = runtimeFor('python');
const PYODIDE_WHEELS = COMPONENTS.get('pyodide-wheels');
if (!PYODIDE_WHEELS) throw new Error('pyodide-wheels component manifest entry is missing');
const SWIPL = runtimeFor('prolog');
const SCITTLE = runtimeFor('clojurescript');
const WEBR = runtimeFor('r');
const PYODIDE_BASE = PYODIDE.resolved.baseUrl;
const SWIPL_SRC = SWIPL.resolved.sources.find((source) => source.type === 'cdn').url;
const SCITTLE_SRC = SCITTLE.resolved.sources.find((source) => source.type === 'cdn').url;
const WEBR_VERSION = WEBR.resolved.version;
const BUNDLE_SPECS = {
  python: runtimeBundleSpec('python', PYODIDE.component, PYODIDE.resolved, {
    packages: PYODIDE_WHEELS.packages,
  }),
  prolog: runtimeBundleSpec('prolog', SWIPL.component, SWIPL.resolved),
  clojurescript: runtimeBundleSpec('clojurescript', SCITTLE.component, SCITTLE.resolved),
  r: runtimeBundleSpec('r', WEBR.component, WEBR.resolved),
};

function fail(msg) { console.error('[fetch-bundles] ' + msg); process.exit(1); }

async function download(url, destAbs) {
  mkdirSync(dirname(destAbs), { recursive: true });
  const partial = destAbs + '.part';
  rmSync(partial, { force: true });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error(`empty response for ${url}`);
    writeFileSync(partial, buf);
    renameSync(partial, destAbs);
    console.log(`  ↓ ${(buf.length / 1048576).toFixed(1).padStart(5)} MB  ${url}`);
  } finally {
    rmSync(partial, { force: true });
  }
}

function verifyRecordedArtifact(component, destAbs, recordedPath) {
  const record = (component.artifacts || []).find((item) => item.path === recordedPath);
  if (!record) throw new Error(`${component.id} does not record artifact ${recordedPath}`);
  const bytes = readFileSync(destAbs);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (record.sha256 && digest !== record.sha256) {
    throw new Error(`${recordedPath} does not match recorded ${component.id} SHA-256`);
  }
  if (record.size && bytes.length !== record.size) {
    throw new Error(`${recordedPath} does not match recorded ${component.id} size`);
  }
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
  const result = await installStagedBundle({
    dir,
    component: PYODIDE.component,
    bundleSpec: BUNDLE_SPECS.python,
    build: async (stage) => {
      const core = PYODIDE_CORE_FILES;
      for (const f of core) await download(`${PYODIDE_BASE}/${f}`, join(stage, f));

      // Resolve the packages the Python kernel preloads plus compiled/runtime
      // dependencies used by catalog workbooks. With a bundled Pyodide index,
      // micropip resolves these built-in packages locally rather than from the CDN.
      const lock = JSON.parse(readFileSync(join(stage, 'pyodide-lock.json'), 'utf8'));
      const wheels = resolvePyodidePackages(lock, PYODIDE_WANTED_PACKAGES);
      for (const wheel of wheels) await download(`${PYODIDE_BASE}/${wheel}`, join(stage, wheel));
      return {
        python: lock.info?.python || null,
        abiVersion: lock.info?.abi_version || null,
        files: [...core, ...wheels].sort(),
      };
    },
    validate: async (stage) => verifyPyodideWheelNotices(ROOT, { vendorDir: stage }),
  });
  if (result.reused) console.log('  ✓ complete Pyodide bundle and inventory already match');
}

async function bundleProlog() {
  const dir = join(WWW, 'vendor', 'swipl');
  const result = await installStagedBundle({
    dir,
    component: SWIPL.component,
    bundleSpec: BUNDLE_SPECS.prolog,
    build: async (stage) => {
      await download(SWIPL_SRC, join(stage, 'dynamic-import.js'));
      return {
        underlyingVersion: SWIPL.component.underlyingVersion,
        artifactSha256: SWIPL.component.artifacts?.[0]?.sha256 || null,
        files: ['dynamic-import.js'],
      };
    },
    validate: async (stage) => verifyRecordedArtifact(
      SWIPL.component, join(stage, 'dynamic-import.js'), 'www/vendor/swipl/dynamic-import.js'),
  });
  if (result.reused) console.log('  ✓ complete SWI-Prolog bundle and inventory already match');
}

async function bundleClojurescript() {
  const dir = join(WWW, 'vendor', 'scittle');
  const result = await installStagedBundle({
    dir,
    component: SCITTLE.component,
    bundleSpec: BUNDLE_SPECS.clojurescript,
    build: async (stage) => {
      await download(SCITTLE_SRC, join(stage, 'scittle.js'));
      return { files: ['scittle.js'] };
    },
    validate: async (stage) => verifyRecordedArtifact(
      SCITTLE.component, join(stage, 'scittle.js'), 'www/vendor/scittle/scittle.js'),
  });
  if (result.reused) console.log('  ✓ complete Scittle bundle and inventory already match');
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
  const dir = join(WWW, 'vendor', 'webr');
  const result = await installStagedBundle({
    dir,
    component: WEBR.component,
    bundleSpec: BUNDLE_SPECS.r,
    build: async (stage) => {
      const files = await listWebrDistFiles(WEBR_VERSION);
      console.log(`  webR ${WEBR_VERSION}: ${files.length} runtime files`);
      for (const rel of files) {
        const url = `https://cdn.jsdelivr.net/npm/webr@${WEBR_VERSION}/dist/${rel}`;
        await download(url, join(stage, rel));
      }
      // The Android/Capacitor WebView asset server returns a bad status for `.gz`
      // assets. Decompress every `.data.gz` and flip its metadata before the
      // staged tree is receipted and promoted.
      let decompressed = 0;
      for (const rel of files) {
        if (!rel.endsWith('.data.gz')) continue;
        const gz = join(stage, rel);
        if (!existsSync(gz)) continue;
        const data = gz.replace(/\.gz$/, '');
        writeFileSync(data, gunzipSync(readFileSync(gz)));
        const meta = data.replace(/\.data$/, '.js.metadata');
        if (existsSync(meta)) {
          const metadata = JSON.parse(readFileSync(meta, 'utf8'));
          if (metadata.gzip) {
            metadata.gzip = false;
            writeFileSync(meta, JSON.stringify(metadata));
          }
        }
        unlinkSync(gz);
        decompressed++;
      }
      if (decompressed) console.log(`  decompressed ${decompressed} .data.gz → .data (Android serves .gz with a bad status)`);
      return {
        underlyingRuntime: COMPONENTS.get('webr-r-runtime')?.underlyingVersion || null,
        transformedForAndroid: true,
        files: files.map((relative) => relative.replace(/\.data\.gz$/, '.data')).sort(),
      };
    },
  });
  if (result.reused) console.log('  ✓ complete webR bundle and inventory already match');
}

const HANDLERS = { python: bundlePython, prolog: bundleProlog, clojurescript: bundleClojurescript, r: bundleR };

async function main() {
  const spec = PROFILE_SPEC;
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
