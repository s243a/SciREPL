/**
 * preload.js — the entire renderer-visible native surface.
 *
 * Design rule for Phase 0: because notebook code shares the renderer realm with
 * SciREPL's UI code (see security.js), every operation exposed here must be
 * safe when invoked by hostile notebook code. Operations that are not safe
 * under that assumption are simply not exposed.
 *
 * That leaves two read-only, side-effect-free operations. They carry no
 * authority: they return static build/platform facts that the application uses
 * for display and for adapter selection. Nothing here can read a file, write a
 * file, spawn a process, or reach an arbitrary IPC channel.
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
 * the surface, and each entry is invoked with no renderer-supplied arguments.
 */
const CHANNELS = Object.freeze({
  APP_INFO: 'scirepl:get-app-info',
  DISTRIBUTION_INFO: 'scirepl:get-distribution-info',
});

/**
 * Both operations take zero arguments by design. There is no argument to
 * validate and therefore no argument-shaped attack surface. If a future
 * operation needs arguments, validation belongs in the main process
 * (ipc.js), never here — the preload runs in the renderer process and a
 * compromised renderer could bypass any check made on this side.
 */
const api = {
  /** Static application/build identity. */
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.APP_INFO),

  /** Which container/edition this is, for adapter selection. */
  getDistributionInfo: () => ipcRenderer.invoke(CHANNELS.DISTRIBUTION_INFO),
};

contextBridge.exposeInMainWorld('sciREPLPlatform', Object.freeze(api));

// Nothing is exported: this file runs as a sandboxed preload, which cannot
// `require` relative modules. The channel names above are duplicated in
// ipc.js, which owns the canonical allowlist; test/preload-boundary.test.mjs
// asserts the two agree by exercising the running application.
