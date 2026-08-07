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
  r.log('IPC allowlist is exactly the two read-only operations',
    JSON.stringify([...channels].sort()) ===
      JSON.stringify(['scirepl:get-app-info', 'scirepl:get-distribution-info']),
    JSON.stringify(channels));

  let threw = false;
  try { ipc.assertNullary('test', ['x']); } catch { threw = true; }
  r.log('assertNullary rejects arguments', threw === true);

  let threwEmpty = false;
  try { ipc.assertNullary('test', []); } catch { threwEmpty = true; }
  r.log('assertNullary accepts no arguments', threwEmpty === false);

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

  /* ---------------- known, deliberate PWA divergence ---------------- */

  // www/index.html:407 loads the Ko-fi widget from storage.ko-fi.com. It is
  // excluded from the allowlist on purpose (a third-party script would get
  // arbitrary execution in the realm that runs notebooks). These assertions
  // exist so the omission stays a decision: allowing the origin, or dropping
  // the documented exclusion, fails here and forces the choice to be re-made.
  const kofi = protocol.KOFI_EXCLUSION;
  r.log('the Ko-fi divergence is documented in the shell',
    !!kofi && kofi.origin === 'https://storage.ko-fi.com', JSON.stringify(kofi));
  r.log('storage.ko-fi.com is not in the remote allowlist',
    !protocol.REMOTE_ORIGINS.includes('https://storage.ko-fi.com'));
  r.log('the CSP does not permit the Ko-fi widget origin',
    !csp.includes('ko-fi.com'));
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
