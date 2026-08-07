/**
 * ipc.js — the canonical IPC allowlist, owned by the main process.
 *
 * Every handler here is registered explicitly. There is no dynamic dispatch,
 * no `invoke(name, ...args)` router, and no channel derived from renderer
 * input — those patterns collapse the allowlist into a single generic hole.
 *
 * Each handler validates that it received no arguments. Both Phase 0
 * operations are nullary, so any argument at all means the caller is not the
 * preload API and the call is rejected rather than tolerated.
 */

const { ipcMain, app } = require('electron');

const CHANNELS = Object.freeze({
  APP_INFO: 'scirepl:get-app-info',
  DISTRIBUTION_INFO: 'scirepl:get-distribution-info',
});

/** Reject any call that carries arguments. */
function assertNullary(channel, args) {
  if (args.length > 0) {
    throw new Error(`${channel}: expected no arguments, received ${args.length}`);
  }
}

/**
 * @param {object} options
 * @param {string} options.appVersion  version read from the repo package.json
 * @param {string} options.profile     build profile the www/ tree was configured with
 */
function registerIpcHandlers(options = {}) {
  const appVersion = options.appVersion || '0.0.0';
  const profile = options.profile || 'unknown';

  ipcMain.handle(CHANNELS.APP_INFO, (_event, ...args) => {
    assertNullary(CHANNELS.APP_INFO, args);
    return {
      appVersion,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    };
  });

  ipcMain.handle(CHANNELS.DISTRIBUTION_INFO, (_event, ...args) => {
    assertNullary(CHANNELS.DISTRIBUTION_INFO, args);
    return {
      // Phase 0 is Free-only by construction. This value is a build fact, not
      // an entitlement: it is not a licence check and must never become one.
      // The future Microsoft Store seam (StoreContext.GetAppLicenseAsync) would
      // live in the main process behind its own narrow channel and is
      // deliberately NOT stubbed here — a placeholder that always returns
      // "licensed" would be worse than no implementation.
      edition: 'free',
      container: 'electron',
      packaged: app.isPackaged,
      profile,
      store: null,
    };
  });
}

/** Used by tests to assert the surface has not silently grown. */
function listRegisteredChannels() {
  return Object.values(CHANNELS);
}

module.exports = { CHANNELS, registerIpcHandlers, listRegisteredChannels, assertNullary };
