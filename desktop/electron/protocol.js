/**
 * protocol.js — the application origin for the Windows/Electron shell.
 *
 * Why not file://
 * ---------------
 * SciREPL is an origin-sensitive application: IndexedDB (notebooks + SharedVFS),
 * a service worker, workers spawned by Pyodide/webR, WebAssembly streaming
 * instantiation and relative asset resolution all key off the page origin.
 * `file://` gives each document an *opaque* origin, which in Chromium means:
 *   - IndexedDB is unavailable or unpartitioned/unstable across loads,
 *   - service workers are not registrable at all,
 *   - `fetch()` of relative URLs is blocked,
 *   - responses carry no Content-Type, so `WebAssembly.instantiateStreaming`
 *     rejects (`.wasm` must be served as `application/wasm`).
 *
 * So the shell registers ONE stable, secure, standard scheme and serves the
 * prepared `www/` tree from it:
 *
 *     app://scirepl/index.html
 *
 * `standard` gives it real origin semantics (storage keying, relative URLs).
 * `secure` makes it a Secure Context, which is what service workers, crypto.subtle
 * and several kernel runtimes require. The origin is constant across launches and
 * across packaged/unpackaged builds, so IndexedDB survives restart and upgrade.
 *
 * This module is deliberately the only place that maps a URL to a file.
 */

const { protocol, net } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const HOST = 'scirepl';
const ORIGIN = `${SCHEME}://${HOST}`;
const START_URL = `${ORIGIN}/index.html`;

/**
 * Content types. Superset of the dev server's map (server.js) — the shell must
 * agree with the dev server so behaviour does not silently diverge between
 * `npm run serve` (browser baseline) and the packaged shell.
 */
const MIME = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.py': 'text/x-python',
  '.pl': 'text/plain',
  '.R': 'text/plain',
  '.r': 'text/plain',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.data': 'application/octet-stream',
  '.srwb': 'application/json',
  '.ipynb': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Remote origins the application is allowed to contact from the packaged shell.
 *
 * These cover the runtime/package supply chain — the kernel CDNs in
 * build-profiles.json and the release/package hosts in www/js/package_catalog.js.
 *
 * This is an ALLOWLIST, not an inventory of everything www/index.html happens to
 * reference. One origin present in the PWA is deliberately absent:
 *
 *   https://storage.ko-fi.com  — the Ko-fi support widget (www/index.html:407)
 *
 * See KOFI_EXCLUSION below for why, and desktop/electron/test/security.test.mjs
 * for the test that keeps the omission deliberate rather than accidental.
 */
const REMOTE_ORIGINS = [
  'https://cdn.jsdelivr.net',      // Pyodide, Scittle, swipl-wasm
  'https://data.jsdelivr.com',     // jsDelivr version metadata
  'https://unpkg.com',             // Pyodide/Fengari mirror
  'https://github.com',            // package + workbook releases
  'https://objects.githubusercontent.com', // GitHub release asset redirect target
  'https://api.github.com',        // release metadata
  'https://raw.githubusercontent.com',
  'https://repo.r-wasm.org',       // R/WebAssembly package repository
  'https://webr.r-wasm.org',       // webR runtime
  'https://pypi.org',              // micropip
  'https://files.pythonhosted.org',// micropip wheels
];

/**
 * A known, deliberate divergence from the PWA.
 *
 * `www/index.html:407` loads the Ko-fi support widget as a third-party script
 * from `https://storage.ko-fi.com`. It is NOT in REMOTE_ORIGINS, so the CSP
 * blocks it and the support button does not appear in the shell. The widget is
 * already guarded by `if (typeof kofiwidget2 !== 'undefined')`, so blocking it
 * degrades silently: nothing throws and no other Help content is affected.
 *
 * Why it is excluded rather than allowed:
 *
 *   - It is a third-party script with no role in running notebooks. Adding it to
 *     `script-src` grants an external host arbitrary script execution inside the
 *     same realm that runs user notebooks and holds all IndexedDB state. The
 *     supply-chain cost is out of proportion to a donate button.
 *   - The CSP's whole value here is being restrictive about origins; widening it
 *     for a non-functional widget spends exactly the property worth keeping.
 *
 * This is a divergence, not a fix. The right resolution is a shared change —
 * replace the widget with a plain `target="_blank"` link to the Ko-fi page,
 * which works identically in the PWA, on Android and here, and needs no CSP
 * exception at all. That belongs in a follow-up because it touches `www/`,
 * which this Phase 0 spike deliberately does not modify.
 *
 * Exported so the test suite can assert the exclusion stays intentional.
 */
const KOFI_EXCLUSION = Object.freeze({
  origin: 'https://storage.ko-fi.com',
  site: 'www/index.html:407',
  effect: 'the Ko-fi support button does not render in the Electron shell',
  degradesSilently: true,
  resolution: 'replace the widget with a plain external link in a shared follow-up change',
});

/**
 * Content-Security-Policy for the application origin.
 *
 * `'unsafe-eval'` is present deliberately and cannot be removed: SciREPL's
 * JavaScript kernel compiles cells with `new AsyncFunction(...)`, Scittle
 * compiles ClojureScript at runtime, and Pyodide/webR rely on eval-family
 * constructs. WebAssembly compilation also requires `'wasm-unsafe-eval'`.
 * The CSP is therefore restrictive about *where code and data may come from*,
 * which is the property that actually protects the packaged app, and permissive
 * about eval, which the product fundamentally requires.
 *
 * Note this is defence in depth, not the security boundary. The boundary is
 * contextIsolation + sandbox + the absence of an exposed privileged API
 * (see preload.js and security.js).
 */
function buildCsp() {
  const remote = REMOTE_ORIGINS.join(' ');
  return [
    `default-src 'self' ${ORIGIN}`,
    `script-src 'self' ${ORIGIN} 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob: ${remote}`,
    `style-src 'self' ${ORIGIN} 'unsafe-inline' ${remote}`,
    `img-src 'self' ${ORIGIN} data: blob: ${remote}`,
    `font-src 'self' ${ORIGIN} data: ${remote}`,
    `connect-src 'self' ${ORIGIN} data: blob: ${remote}`,
    `worker-src 'self' ${ORIGIN} blob:`,
    `child-src 'self' ${ORIGIN} blob:`,
    // No plugins, and the page may never be framed.
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    // Keep form posts and <base> hijacking off the table.
    `base-uri 'self'`,
    `form-action 'none'`,
  ].join('; ');
}

/**
 * Must be called before `app.whenReady()`. Chromium needs privileged scheme
 * registration during startup, before the network stack is created.
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,        // real origin => stable storage key, relative URLs
        secure: true,          // Secure Context => service worker, crypto.subtle
        supportFetchAPI: true, // fetch() of app:// URLs (kernels load assets this way)
        corsEnabled: true,
        stream: true,          // range/streaming responses for large WASM payloads
        allowServiceWorkers: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Resolve an app:// pathname to a real file inside `root`, refusing anything
 * that escapes the root. Returns null when the request is not serviceable.
 */
function resolveRequestPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }

  // Reject NUL and any traversal before touching the filesystem.
  if (decoded.includes('\0')) return null;

  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative === '' ? 'index.html' : relative);

  // Containment check. path.relative is the reliable form: it must not start
  // with '..' and must not be absolute.
  const rel = path.relative(root, candidate);
  if (rel === '' ) return null;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return candidate;
}

/**
 * Install the app:// handler. `root` is the prepared www/ directory.
 * Called after `app.whenReady()`.
 */
function registerProtocolHandler(root) {
  const csp = buildCsp();

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);

    if (url.hostname !== HOST) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    // Only GET/HEAD are meaningful for a static application bundle.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { 'content-type': 'text/plain' } });
    }

    let filePath = resolveRequestPath(root, url.pathname);
    if (!filePath) {
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      try {
        const indexStat = await fsp.stat(indexPath);
        if (!indexStat.isFile()) throw new Error('not a file');
        filePath = indexPath;
      } catch {
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
    }

    const ext = path.extname(filePath);
    const type = MIME[ext] || MIME[ext.toLowerCase()] || 'application/octet-stream';

    const headers = {
      'content-type': type,
      // The bundle is local and immutable for the life of a build; the service
      // worker still manages its own cache identity on top of this.
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    };

    // Apply the CSP to documents and workers only. Attaching it to every asset
    // is redundant and, for worker scripts, is what actually governs them.
    if (type === 'text/html' || type === 'text/javascript') {
      headers['content-security-policy'] = csp;
    }

    // Delegate the actual byte delivery to Electron's net stack so we get
    // streaming and range support for the large runtime payloads (Pyodide,
    // webR) without buffering them in the main process.
    const response = await net.fetch(pathToFileURL(filePath).toString());
    return new Response(response.body, { status: 200, headers });
  });
}

module.exports = {
  SCHEME,
  HOST,
  ORIGIN,
  START_URL,
  MIME,
  REMOTE_ORIGINS,
  KOFI_EXCLUSION,
  buildCsp,
  registerScheme,
  registerProtocolHandler,
  resolveRequestPath,
};
