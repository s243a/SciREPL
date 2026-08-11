/**
 * build-portable.mjs — build the unsigned, portable Windows preview.
 *
 * Produces a directory containing a directly launchable `SciREPL.exe`, with no
 * installer and nothing to register with the operating system. Extract and run.
 *
 *   node desktop/electron/packaging/build-portable.mjs
 *   node desktop/electron/packaging/build-portable.mjs --platform win32 --arch x64
 *
 * This is a PREVIEW build, not a release:
 *   - unsigned, so Windows SmartScreen will warn (see the README);
 *   - Free edition only — no Pro content, no Store or entitlement code;
 *   - no auto-update, no installer, no Store packaging.
 *
 * Layout produced (win32):
 *
 *   SciREPL-win32-x64/
 *     SciREPL.exe
 *     resources/
 *       app.asar          ← the shell itself (main, protocol, security, preload, ipc, native i18n)
 *       www/              ← the prepared application tree, OUTSIDE the asar
 *       build-info.json   ← version / profile / commit, read by main.js
 *
 * `www/` stays outside the asar deliberately: protocol.js serves it with
 * `net.fetch(file://…)`, which reads real files and does not go through
 * Electron's asar layer, and the kernel runtimes are ~100 MB — packing them
 * would buy nothing and slow startup.
 */

import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ELECTRON_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..', '..');
const WWW_ROOT = path.join(REPO_ROOT, 'www');
const OUT_DIR = path.join(ELECTRON_DIR, 'out');

/* ------------------------------ arguments ------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const platform = arg('platform', 'win32');
const arch = arg('arch', 'x64');

/* ------------------------------ preflight ------------------------------ */

function fail(message) {
  console.error(`\n[build-portable] ${message}\n`);
  process.exit(1);
}

if (!existsSync(WWW_ROOT)) {
  fail(`No prepared application tree at ${WWW_ROOT}.\nRun:  npm run configure && npm run fetch:bundles`);
}

const kernelConfig = path.join(WWW_ROOT, 'js', 'kernel_config.js');
if (!existsSync(kernelConfig)) {
  fail(`www/js/kernel_config.js is missing — the tree has not been configured.\nRun:  npm run configure`);
}

const profileMatch = readFileSync(kernelConfig, 'utf8')
  .match(/["']?profile["']?\s*:\s*["']([^"']+)["']/);
const profile = profileMatch ? profileMatch[1] : 'unknown';

// Free-only boundary, enforced at build time rather than trusted. `pro` is the
// profile that bundles the R runtime offline; a preview must never ship it.
if (profile === 'pro') {
  fail(`Refusing to package the 'pro' profile. This preview is Free-only.\nRun:  npm run configure   (which selects the default Free profile)`);
}
if (existsSync(path.join(WWW_ROOT, 'vendor', 'webr'))) {
  fail(`www/vendor/webr/ is present — that is the Pro offline R runtime.\nThis preview is Free-only. Remove it and re-run npm run fetch:bundles.`);
}

// A tree configured but never populated produces an app that launches and then
// fails to load every kernel. Catch it here rather than in the tester's hands.
const bundled = ['pyodide', 'swipl', 'scittle'].filter(
  (d) => !existsSync(path.join(WWW_ROOT, 'vendor', d))
);
if (bundled.length) {
  fail(`Bundled runtimes missing from www/vendor: ${bundled.join(', ')}\nRun:  npm run fetch:bundles`);
}

const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const appVersion = rootPkg.version || '0.0.0';

function gitCommit() {
  // GitHub Actions provides the SHA directly; fall back to git for local builds.
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/* --------------------------- build metadata --------------------------- */

// Timestamps and commit are staged into a temp directory rather than written
// into the working tree, so a build never leaves generated files behind for
// someone to commit by accident.
const stage = mkdtempSync(path.join(tmpdir(), 'scirepl-pkg-'));

/**
 * Paths under `www/` that are omitted from the **packaged desktop artifact**,
 * as `path.relative(WWW_ROOT, …)` prefixes.
 *
 * >  This filter applies ONLY to the copy staged into the .exe. It does not
 * >  touch the repository, and it does not affect the website: `www/pro/**`
 * >  remains tracked in git and is still published by
 * >  `.github/workflows/deploy-pages.yml`, whose trigger is unchanged. The Pro
 * >  landing page is required and is not going anywhere.
 *
 * `pro/` is the Pro **landing page** — marketing copy, a separate privacy
 * policy, a testing page, and ~800 kB of Pro branding (app icon and Play Store
 * feature graphic). It is in this repository so GitHub Pages can serve it, not
 * because the Free application uses it: nothing under `www/js` links to it, and
 * the shell never navigates there.
 *
 * It is left out of the desktop preview because that artifact is Free-only —
 * shipping Pro branding inside a Free build to a tester adds no function and
 * misrepresents what they are running. The absence is asserted after packaging.
 */
const EXCLUDED_FROM_PACKAGE = ['pro'];

// Stage a filtered copy of the application tree. `extraResource` copies whole
// directories, so filtering has to happen before the packager sees it. The
// source tree is only read, never modified.
const stagedWww = path.join(stage, 'www');
cpSync(WWW_ROOT, stagedWww, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(WWW_ROOT, src);
    if (!rel) return true;
    return !EXCLUDED_FROM_PACKAGE.some(
      (ex) => rel === ex || rel.startsWith(ex + path.sep)
    );
  },
});

const buildInfoPath = path.join(stage, 'build-info.json');
const buildInfo = {
  appVersion,
  profile,
  edition: 'free',
  channel: 'preview',
  commit: gitCommit(),
  builtAt: new Date().toISOString(),
  electron: JSON.parse(
    readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8')
  ).devDependencies.electron,
  note: 'Unsigned portable preview. Not a release build; not Store packaging.',
};
writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));

console.log('[build-portable] packaging');
for (const [k, v] of Object.entries({ platform, arch, appVersion, profile, commit: buildInfo.commit })) {
  console.log(`  ${k.padEnd(12)} ${v}`);
}

/* ------------------------------ package ------------------------------- */

const appPaths = await packager({
  dir: ELECTRON_DIR,
  out: OUT_DIR,
  name: 'SciREPL',
  platform,
  arch,
  appVersion,
  buildVersion: appVersion,
  overwrite: true,
  asar: true,
  // Strip devDependencies from the packaged app. Electron itself is a
  // devDependency here, so without this the runtime would be shipped twice.
  prune: true,
  // The app is just the shell's own source. Everything else in this directory
  // is build/test machinery and must not reach a tester's machine.
  ignore: [
    /^\/node_modules($|\/)/,
    /^\/test($|\/)/,
    /^\/packaging($|\/)/,
    /^\/scripts($|\/)/, // dev-windows.mjs is setup machinery, not app code
    /^\/out($|\/)/,
    /^\/README\.md$/,
    /^\/package-lock\.json$/,
  ],
  extraResource: [stagedWww, buildInfoPath],
  // Desktop-environment icon. `icon-512.png` is the PWA's own icon, so the
  // desktop builds show what users already recognise. @electron/packager wants
  // a .ico for Windows and ignores a .png there, so the Windows executable
  // keeps the default Electron icon for now — noted in the report as polish,
  // not a blocker for an unsigned preview.
  icon: path.join(WWW_ROOT, 'icons', 'icon-512'),
  win32metadata: {
    CompanyName: 'SciREPL',
    FileDescription: 'SciREPL — scientific REPL (Free, unsigned preview)',
    ProductName: 'SciREPL',
    OriginalFilename: 'SciREPL.exe',
  },
  // Quieter output; packager is chatty about every file it copies.
  quiet: true,
});

rmSync(stage, { recursive: true, force: true });

const appDir = appPaths[0];

/* ------------------------------- verify ------------------------------- */

// Assert the layout main.js depends on actually exists. A packaging change that
// silently moves www/ produces an app that opens a window and 404s everything,
// which is exactly the failure worth catching here rather than on Windows.
const expectedExe = platform === 'win32' ? 'SciREPL.exe' : 'SciREPL';
const checks = [
  [path.join(appDir, expectedExe), 'the launchable executable'],
  [path.join(appDir, 'resources', 'app.asar'), 'the packaged shell'],
  [path.join(appDir, 'resources', 'www', 'index.html'), 'the application entry point'],
  [path.join(appDir, 'resources', 'www', 'js', 'kernel_config.js'), 'the build profile'],
  [path.join(appDir, 'resources', 'build-info.json'), 'build metadata'],
];
const missing = checks.filter(([p]) => !existsSync(p));
if (missing.length) {
  fail(`Packaged layout is wrong. Missing:\n` + missing.map(([p, what]) => `  ${what}: ${p}`).join('\n'));
}

// The Free boundary again, this time against what was actually produced.
if (existsSync(path.join(appDir, 'resources', 'www', 'vendor', 'webr'))) {
  fail('The packaged output contains the Pro offline R runtime. Refusing to continue.');
}
for (const excluded of EXCLUDED_FROM_PACKAGE) {
  if (existsSync(path.join(appDir, 'resources', 'www', excluded))) {
    fail(`The packaged output contains www/${excluded}, which must not ship in the Free preview.`);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

console.log(`\n[build-portable] done`);
console.log(`  output   ${appDir}`);
console.log(`  exe      ${path.join(appDir, expectedExe)}`);
console.log(`  size     ${(dirSize(appDir) / 1e6).toFixed(1)} MB unpacked`);
console.log(`\n  Unsigned preview — Windows SmartScreen will warn on first run.`);

// Emit the path so CI can pick it up without guessing the directory name.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `app-dir=${appDir}\n`, { flag: 'a' });
}
