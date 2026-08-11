/**
 * preload.js — the entire renderer-visible native surface.
 *
 * Design rule for Phase 0: because notebook code shares the renderer realm with
 * SciREPL's UI code (see security.js), every operation exposed here must be
 * safe when invoked by hostile notebook code. Operations that are not safe
 * under that assumption are simply not exposed.
 *
 * That leaves two read-only operations plus one narrowly validated locale
 * notification. They carry no ambient authority: the first two return static
 * build/platform facts, and the third can only select a bundled locale for the
 * native menu. Nothing here can read a file, write a file, spawn a process, or
 * reach an arbitrary IPC channel.
 *
 * Deliberately NOT exposed in Phase 0, and why:
 *   - a generic `invoke`/`send` escape hatch — it would export the whole main
 *     process to notebook code in one line;
 *   - `require`, `process`, `Buffer`, `__dirname` — Node is off entirely
 *     (nodeIntegration: false, sandbox: true);
 *   - filesystem or shell operations — the browser download/upload paths in
 *     www/js/file_io.js already work under the app:// origin, so native file
 *     access buys nothing for the feasibility question while adding a
 *     capability notebook code could reach;
 *   - `openExternal` — SciREPL's external links are `target="_blank"` anchors,
 *     which the main process already handles via setWindowOpenHandler. Routing
 *     them there keeps the decision in the main process where it belongs.
 *
 * When Phase 1 introduces saveFile/openFile, each must be its own narrow,
 * schema-validated channel that shows a native dialog, so the user — not the
 * calling code — chooses the path. See docs/WINDOWS_ELECTRON_SPIKE.md.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The complete IPC allowlist. Adding a channel here is the only way to widen
 * the surface. The information calls are nullary; SET_LOCALE forwards only the
 * locale id, which the main process validates against its bundled allowlist.
 */
const CHANNELS = Object.freeze({
  APP_INFO: 'scirepl:get-app-info',
  DISTRIBUTION_INFO: 'scirepl:get-distribution-info',
  SET_LOCALE: 'scirepl:set-locale',
});

/**
 * Validation belongs in the main process (ipc.js), never here — the preload
 * runs in the renderer process and a compromised renderer could bypass any
 * check made on this side. The wrapper still deliberately drops arguments to
 * the two read-only calls; SET_LOCALE forwards exactly its one declared value.
 */
const api = {
  /** Static application/build identity. */
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.APP_INFO),

  /** Which container/edition this is, for adapter selection. */
  getDistributionInfo: () => ipcRenderer.invoke(CHANNELS.DISTRIBUTION_INFO),

  /** Select the matching bundled locale for Electron-native menu/dialog UI. */
  setLocale: (localeId) => ipcRenderer.invoke(CHANNELS.SET_LOCALE, localeId),
};

contextBridge.exposeInMainWorld('sciREPLPlatform', Object.freeze(api));

/**
 * Ask Chromium to make this origin's storage exempt from eviction.
 *
 * Chromium storage is "best-effort" by default: under disk pressure it may
 * discard an origin's IndexedDB, which here means the user's notebooks and
 * SharedVFS contents. `navigator.storage.persist()` is what marks an origin
 * durable, and nothing was calling it — measured, not assumed.
 *
 * This lives in the preload rather than in the application because `www/` is
 * shared with the PWA and the Android build and is deliberately not modified by
 * the shell. Durability is a property of *this container*, so the container
 * asks for it. It runs in the isolated world, changes nothing the page can see,
 * and exposes no new surface: storage permission is per-origin, so requesting
 * it here applies to the document.
 *
 * Best-effort and non-blocking. If it is refused the application still works;
 * it is simply back to evictable storage, which is what the PWA has.
 */
navigator.storage?.persist?.().catch(() => { /* durability is a bonus, not a requirement */ });

// Nothing is exported: this file runs as a sandboxed preload, which cannot
// `require` relative modules. The channel names above are duplicated in
// ipc.js, which owns the canonical allowlist; test/preload-boundary.test.mjs
// asserts the two agree by exercising the running application.
