/**
 * security.js — navigation, window and permission policy for the shell.
 *
 * Threat model
 * ------------
 * There are two kinds of code inside the renderer and they are NOT separated
 * by a realm boundary:
 *
 *   1. SciREPL's own UI code (www/js/**).
 *   2. User-authored notebook code and downloaded packages.
 *
 * The JavaScript kernel executes cells with `new AsyncFunction(code)` in the
 * main world (www/js/kernels/javascript.js). Scittle, Lua/Fengari and Pyodide's
 * JS bridge likewise reach the same `window`. Therefore **anything reachable
 * from `window` is reachable by notebook code**, and the shell must assume a
 * notebook cell is hostile.
 *
 * The consequence, which drives every decision in this file and preload.js:
 * the renderer is treated as fully untrusted. It gets no Node, no `remote`,
 * no filesystem, no shell, and no privileged IPC. Capability is withheld
 * rather than filtered, because a filter would have to distinguish UI code
 * from notebook code and it cannot.
 */

const { shell } = require('electron');

const { SCHEME, HOST } = require('./protocol');

/**
 * Schemes we are willing to hand to the operating system when the application
 * asks to open something externally. `file:` is intentionally absent — an
 * external `file:` open is a local-file disclosure/exec primitive.
 */
const EXTERNAL_SCHEMES = new Set(['https:', 'mailto:']);

/**
 * Decide whether a URL may be handed to the system browser.
 * Exported so tests can assert the policy directly, without a live window.
 */
function isAllowedExternal(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return false;
  // Defend against `https://evil/@` style confusion and credential-bearing URLs.
  if (url.username || url.password) return false;
  return true;
}

/**
 * Is this URL part of the application itself?
 * Only exact scheme+host app:// URLs count. Everything else is "somewhere else".
 *
 * This compares `protocol` and `hostname` rather than `origin` on purpose.
 * `registerSchemesAsPrivileged({ standard: true })` teaches *Chromium* that
 * `app:` is a standard scheme, but this function runs in the main process,
 * which parses URLs with Node's implementation. Node has no such registry, so
 * for a non-special scheme it reports `url.origin === 'null'`. Comparing
 * origins here would therefore classify every in-app navigation as external
 * and block the application from navigating within itself.
 */
function isAppUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === `${SCHEME}:` && url.hostname === HOST;
}

/**
 * WebContents that already carry the policy. `app.on('web-contents-created')`
 * and an explicit call at window-construction time can both target the same
 * contents; without this guard the `will-navigate` listener would be attached
 * twice and a single blocked navigation would open the system browser twice.
 */
const policyApplied = new WeakSet();

/**
 * Apply navigation/window/permission policy to a WebContents.
 *
 * `openExternal` is injected so tests can observe decisions without actually
 * launching a browser; production uses `shell.openExternal`.
 */
function applyWebContentsPolicy(contents, options = {}) {
  if (policyApplied.has(contents)) return contents;
  policyApplied.add(contents);

  const openExternal = options.openExternal || ((url) => shell.openExternal(url));
  const log = options.log || (() => {});

  // 1. Top-level navigation. The app is a single document; it may reload itself
  //    and navigate within app://, but it may never navigate the shell window
  //    to remote content. An http(s) link that would replace the app is instead
  //    handed to the system browser.
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return; // in-app navigation and reloads are fine
    event.preventDefault();
    log('blocked-navigation', url);
    if (isAllowedExternal(url)) {
      openExternal(url);
    }
  });

  // 2. Never allow the renderer to be redirected into a different origin.
  contents.on('will-redirect', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    log('blocked-redirect', url);
  });

  // 3. New windows. SciREPL's external links are plain `target="_blank"`
  //    anchors (www/index.html), so this handler *is* the external-link path.
  //    No child BrowserWindow is ever created: approved links go to the OS
  //    browser, everything else is denied.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) {
      log('external-open', url);
      openExternal(url);
    } else {
      log('blocked-window-open', url);
    }
    return { action: 'deny' };
  });

  // 4. Refuse to attach any webview, and strip privileges if one is somehow
  //    requested. `webviewTag` is already false, this is belt-and-braces.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    log('blocked-webview', params && params.src);
    event.preventDefault();
  });

  // 5. Deny device/permission requests wholesale. SciREPL needs none of
  //    geolocation, camera, microphone, MIDI, USB, serial, HID or
  //    notifications for Phase 0. Anything it does need can be added here
  //    deliberately rather than inherited by default.
  const session = contents.session;
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    log('denied-permission', permission);
    callback(false);
  });
  session.setPermissionCheckHandler((_wc, permission) => {
    log('denied-permission-check', permission);
    return false;
  });
  session.setDevicePermissionHandler(() => false);

  return contents;
}

module.exports = {
  EXTERNAL_SCHEMES,
  isAllowedExternal,
  isAppUrl,
  applyWebContentsPolicy,
};
