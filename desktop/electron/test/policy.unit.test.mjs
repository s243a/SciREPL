/**
 * policy.unit.test.mjs — pure unit tests for the shell's decision functions.
 *
 * These require neither a display nor the Electron binary, so they run on any
 * CI runner and on any OS. They cover the parts of the policy that are easy to
 * get subtly wrong and hard to observe from an integration test: path
 * containment and external-URL classification.
 *
 * `security.js` and `protocol.js` both `require('electron')`, which resolves to
 * a path string outside a real Electron process. Only the module *shape* is
 * needed here, so a minimal stub is installed first.
 */

import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter, ELECTRON_DIR } from './reporter.mjs';

/* Stub `electron` before the modules under test require it. */
const originalResolve = Module._resolveFilename;
const STUB = fileURLToPath(new URL('./fixtures/electron-stub.cjs', import.meta.url));
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const protocol = require(path.join(ELECTRON_DIR, 'protocol.js'));
const security = require(path.join(ELECTRON_DIR, 'security.js'));
const ipc = require(path.join(ELECTRON_DIR, 'ipc.js'));

export default async function run() {
  const r = createReporter('policy-unit');
  const ROOT = path.resolve('/srv/app/www');

  /* ---------------- path containment ---------------- */

  const contained = [
    ['/index.html', 'index.html'],
    ['/', 'index.html'],
    ['/js/app.js', path.join('js', 'app.js')],
    ['/vendor/pyodide/pyodide.asm.wasm', path.join('vendor', 'pyodide', 'pyodide.asm.wasm')],
    ['/js/../js/app.js', path.join('js', 'app.js')],
    // A filename that merely *starts* with the root's basename must not be
    // confused for the root itself — the classic prefix-comparison bug.
    ['/wwwroot-notes.txt', 'wwwroot-notes.txt'],
  ];
  for (const [input, expectedRel] of contained) {
    const got = protocol.resolveRequestPath(ROOT, input);
    const want = path.join(ROOT, expectedRel);
    r.log(`serves contained path ${input}`, got === want, `${got}`);
  }

  const rejected = [
    '/../package.json',
    '/../../etc/passwd',
    '/js/../../package.json',
    '/%2e%2e/package.json',            // decoded by the handler into ..
    '/..%2f..%2fpackage.json',
    '/js/%2e%2e%2f%2e%2e%2fpackage.json',
    '/\0/etc/passwd',
    '/%00etc/passwd',
    '/%ZZ',                            // malformed percent-encoding
  ];
  for (const input of rejected) {
    const got = protocol.resolveRequestPath(ROOT, input);
    const escapesRoot = got !== null && !got.startsWith(ROOT + path.sep);
    r.log(`refuses to escape www/ for ${JSON.stringify(input)}`,
      got === null || !escapesRoot, String(got));
  }

  // Explicit: the traversal cases must not merely stay inside the root by
  // accident, they must be refused outright.
  const hardRejects = ['/../package.json', '/%2e%2e/package.json', '/%00etc/passwd', '/%ZZ'];
  for (const input of hardRejects) {
    r.log(`returns null for ${JSON.stringify(input)}`,
      protocol.resolveRequestPath(ROOT, input) === null);
  }

  /* ---------------- packaged vs development layout ---------------- */

  // Getting this wrong is silent — the window opens and every asset 404s — so
  // it is asserted here rather than only discovered by launching a package.
  const paths = require(path.join(ELECTRON_DIR, 'paths.js'));

  // Fixtures must be *absolute* paths for this platform. `path.join(path.sep, …)`
  // produces a drive-relative path on Windows (`\repo`), while the resolvers
  // return `path.resolve()` output (`D:\repo`), so the two never compare equal
  // and the suite failed on Windows while passing on Linux. `path.resolve()` on
  // both sides keeps the comparison platform-correct.
  const REPO = path.resolve('/repo');
  const APP_RES = path.resolve('/apps/SciREPL/resources');
  const CUSTOM = path.resolve('/custom/tree');

  const devLayout = {
    isPackaged: false,
    resourcesPath: path.resolve('/irrelevant'),
    moduleDir: path.join(REPO, 'desktop', 'electron'),
    env: {},
  };
  r.log('development: www/ resolves next to the repository root',
    paths.resolveWwwRoot(devLayout) === path.join(REPO, 'www'),
    paths.resolveWwwRoot(devLayout));
  r.log('development: the repository root is known',
    paths.resolveRepoRoot(devLayout) === REPO,
    paths.resolveRepoRoot(devLayout));

  const packagedLayout = {
    isPackaged: true,
    resourcesPath: APP_RES,
    moduleDir: path.join(APP_RES, 'app.asar'),
    env: {},
  };
  r.log('packaged: www/ resolves inside resources, not via the module directory',
    paths.resolveWwwRoot(packagedLayout) === path.join(APP_RES, 'www'),
    paths.resolveWwwRoot(packagedLayout));
  r.log('packaged: build-info.json resolves inside resources',
    paths.resolveBuildInfoPath(packagedLayout) === path.join(APP_RES, 'build-info.json'),
    paths.resolveBuildInfoPath(packagedLayout));
  r.log('packaged: there is no repository root to fall back on',
    paths.resolveRepoRoot(packagedLayout) === null);

  // Every resolved path must be absolute on this platform — the property that
  // actually broke on Windows, asserted directly rather than inferred.
  for (const [label, layout] of [['development', devLayout], ['packaged', packagedLayout]]) {
    r.log(`${label}: the resolved www/ path is absolute`,
      path.isAbsolute(paths.resolveWwwRoot(layout)), paths.resolveWwwRoot(layout));
  }

  // The override has to win in both layouts — the tests rely on it.
  for (const [label, layout] of [['development', devLayout], ['packaged', packagedLayout]]) {
    const overridden = paths.resolveWwwRoot({ ...layout, env: { SCIREPL_WWW: CUSTOM } });
    r.log(`${label}: SCIREPL_WWW overrides the resolved tree`,
      overridden === CUSTOM, overridden);
  }

  /* ---------------- the Free launcher must not reuse a Pro profile ---------------- */
  //
  // `npm run dev:windows` used to skip configuration whenever kernel_config.js
  // existed, without checking which profile it described — so a checkout left
  // configured with BUILD_PROFILE=pro would launch while identifying itself as
  // the Free Electron edition.
  const guard = require(path.join(ELECTRON_DIR, 'profile-guard.js'));

  const decisions = [
    [{ existingProfile: 'full', intendedProfile: 'full' }, 'skip', 'correct profile is reused'],
    [{ existingProfile: 'pro', intendedProfile: 'full' }, 'configure', 'a Pro-configured tree is reconfigured'],
    [{ existingProfile: 'mini', intendedProfile: 'full' }, 'configure', 'any mismatched profile is reconfigured'],
    [{ existingProfile: null, intendedProfile: 'full' }, 'configure', 'an unconfigured tree is configured'],
    [{ existingProfile: 'unknown', intendedProfile: 'full' }, 'configure', 'an unreadable profile is reconfigured'],
    [{ existingProfile: 'full', intendedProfile: 'full', force: true }, 'configure', '--force always reconfigures'],
  ];
  for (const [state, expected, what] of decisions) {
    const got = guard.decideConfiguration(state);
    r.log(`launcher: ${what}`, got.action === expected, `${got.action} — ${got.reason}`);
  }

  r.log('launcher: pro is not a profile the Free launcher will prepare',
    guard.isFreeProfile('pro') === false);
  for (const free of ['mini', 'light', 'full']) {
    r.log(`launcher: '${free}' is a Free profile`, guard.isFreeProfile(free) === true);
  }
  r.log('launcher: webr is known as Pro-only runtime content',
    guard.PRO_ONLY_RUNTIME_DIRS.includes('webr'));

  /* ---------------- runtime cache: what may be kept forever ---------------- */
  //
  // repo.r-wasm.org is a MUTABLE package repository. Caching its PACKAGES
  // indexes indefinitely would freeze the catalogue at first use, so
  // install.packages() would keep offering stale versions and a future update
  // checker would read a permanent snapshot and always report "up to date".
  const rc = require(path.join(ELECTRON_DIR, 'runtime-cache.js'));
  const u = (s) => new URL(s);

  const neverCache = [
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/PACKAGES',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/PACKAGES.gz',
    'https://repo.r-wasm.org/src/contrib/PACKAGES.rds',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/PACKAGES.json',
    'https://cdn.jsdelivr.net/npm/thing?v=latest',   // parameterised
  ];
  for (const url of neverCache) {
    r.log(`mutable metadata is never cached: ${url.replace('https://', '')}`,
      rc.isNeverCacheable(u(url)) === true);
  }

  const stillCacheable = [
    'https://webr.r-wasm.org/v0.5.4/R.wasm',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/ggplot2_3.5.1.tgz',
    'https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js',
  ];
  for (const url of stillCacheable) {
    r.log(`runtime asset is still cacheable: ${url.replace('https://', '')}`,
      rc.isNeverCacheable(u(url)) === false);
  }

  // A 404 may only be remembered for a version-pinned path. On a mutable path a
  // package that does not exist today may exist tomorrow, and caching the 404
  // would make it permanently missing for that user.
  const pinned = [
    'https://webr.r-wasm.org/v0.5.4/vfs/usr/lib/R/library/grDevices/afm.data.gz',
    'https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js',
    'https://unpkg.com/fengari-web@0.1.4/dist/fengari-web.js',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/ggplot2_3.5.1.tgz',
    'https://files.pythonhosted.org/packages/ab/cd/thing-1.0-py3-none-any.whl',
  ];
  for (const url of pinned) {
    r.log(`404 may be remembered (version-pinned): ${url.replace('https://', '').slice(0, 58)}`,
      rc.isVersionPinned(u(url)) === true);
  }

  const unpinned = [
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/',
    'https://repo.r-wasm.org/src/contrib/somepackage.tgz',
    'https://cdn.jsdelivr.net/npm/scittle/dist/scittle.js',   // no @version
  ];
  for (const url of unpinned) {
    r.log(`404 must NOT be remembered (mutable): ${url.replace('https://', '').slice(0, 58)}`,
      rc.isVersionPinned(u(url)) === false);
  }

  /* ---------------- external URL classification ---------------- */

  const allowedExternal = [
    'https://github.com/s243a/SciREPL#readme',
    'https://repo.r-wasm.org/',
    'mailto:someone@example.com',
  ];
  for (const url of allowedExternal) {
    r.log(`allows external ${url}`, security.isAllowedExternal(url) === true);
  }

  const deniedExternal = [
    'file:///etc/passwd',                  // local file disclosure
    'file://C:/Windows/System32/cmd.exe',
    'http://example.com/',                 // plaintext
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-settings:privacy',                 // Windows protocol handler
    'shell:startup',
    'app://scirepl/index.html',            // internal, not an external open
    'https://user:pass@example.com/',      // credentials in URL
    'not a url',
    '',
  ];
  for (const url of deniedExternal) {
    r.log(`denies external ${JSON.stringify(url)}`, security.isAllowedExternal(url) === false);
  }

  /* ---------------- app-origin classification ---------------- */

  r.log('recognises the app origin', security.isAppUrl('app://scirepl/index.html') === true);
  r.log('reload URL is in-app', security.isAppUrl('app://scirepl/') === true);
  r.log('a different app:// host is not in-app', security.isAppUrl('app://evil/index.html') === false);
  r.log('https is not in-app', security.isAppUrl('https://scirepl/') === false);
  r.log('an app-origin lookalike host is not in-app',
    security.isAppUrl('app://scirepl.evil.com/x') === false);

  /* ---------------- IPC allowlist ---------------- */

  const channels = ipc.listRegisteredChannels();
  r.log('IPC allowlist is exactly the two read-only operations plus locale selection',
    JSON.stringify([...channels].sort()) ===
      JSON.stringify([
        'scirepl:get-app-info',
        'scirepl:get-distribution-info',
        'scirepl:set-locale',
      ]),
    JSON.stringify(channels));

  let threw = false;
  try { ipc.assertNullary('test', ['x']); } catch { threw = true; }
  r.log('assertNullary rejects arguments', threw === true);

  let threwEmpty = false;
  try { ipc.assertNullary('test', []); } catch { threwEmpty = true; }
  r.log('assertNullary accepts no arguments', threwEmpty === false);

  const localeIds = new Set(['en', 'fr']);
  r.log('locale IPC accepts one bundled locale id',
    ipc.assertLocaleArgument('test', ['fr'], localeIds) === 'fr');
  for (const args of [[], ['fr', 'en'], [42], ['../../evil'], ['en-US']]) {
    let rejected = false;
    try { ipc.assertLocaleArgument('test', args, localeIds); } catch { rejected = true; }
    r.log(`locale IPC rejects ${JSON.stringify(args)}`, rejected === true);
  }

  /* ---------------- CSP shape ---------------- */

  const csp = protocol.buildCsp();
  const cspChecks = [
    ["object-src 'none'", "blocks plugins"],
    ["frame-ancestors 'none'", "cannot be framed"],
    ["form-action 'none'", "cannot post forms"],
    ["base-uri 'self'", "cannot rewrite the base URI"],
  ];
  for (const [needle, why] of cspChecks) {
    r.log(`CSP ${why} (${needle})`, csp.includes(needle));
  }
  r.log('CSP does not allow plaintext http: origins', !/\bhttp:\/\//.test(csp));

  /* ---------------- ordinary support links stay external ------------- */

  // Help uses a plain HTTPS link to Ko-fi. It needs no renderer request
  // origin or script-src exception: security.js sends target=_blank links to
  // the system browser. Keep the retired widget origin out of both policies.
  r.log('the retired Ko-fi widget origin is not in the remote allowlist',
    !protocol.REMOTE_ORIGINS.includes('https://storage.ko-fi.com'));
  r.log('the CSP does not permit the retired Ko-fi widget origin',
    !csp.includes('storage.ko-fi.com'));
  r.log('HTTPS support links are allowed to open in the system browser',
    security.isAllowedExternal('https://ko-fi.com/V7V51TYA76'));
  // Documented, deliberate relaxations — asserted so that removing them later
  // is a conscious decision rather than an accident.
  r.log("CSP allows 'unsafe-eval' (required by the JS/Scittle/Pyodide kernels)",
    csp.includes("'unsafe-eval'"));
  r.log("CSP allows 'wasm-unsafe-eval' (required by every WASM kernel)",
    csp.includes("'wasm-unsafe-eval'"));

  Module._resolveFilename = originalResolve;
  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
