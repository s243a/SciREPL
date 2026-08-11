/**
 * ipc.js — the canonical IPC allowlist, owned by the main process.
 *
 * Every handler here is registered explicitly. There is no dynamic dispatch,
 * no `invoke(name, ...args)` router, and no channel derived from renderer
 * input — those patterns collapse the allowlist into a single generic hole.
 *
 * The two information operations are nullary. The only state-changing call is
 * SET_LOCALE: it accepts exactly one locale id from a fixed bundled allowlist
 * and delegates menu rebuilding to the host. No translated text crosses IPC.
 */

const { ipcMain, app } = require('electron');

const CHANNELS = Object.freeze({
  APP_INFO: 'scirepl:get-app-info',
  DISTRIBUTION_INFO: 'scirepl:get-distribution-info',
  SET_LOCALE: 'scirepl:set-locale',
});

/** Reject any call that carries arguments. */
function assertNullary(channel, args) {
  if (args.length > 0) {
    throw new Error(`${channel}: expected no arguments, received ${args.length}`);
  }
}

/** Validate the one narrow renderer -> host value used by native i18n. */
function assertLocaleArgument(channel, args, supportedLocales) {
  if (args.length !== 1 || typeof args[0] !== 'string') {
    throw new TypeError(`${channel}: expected exactly one locale id string`);
  }
  if (!supportedLocales || !supportedLocales.has(args[0])) {
    throw new RangeError(`${channel}: unsupported locale id ${JSON.stringify(args[0])}`);
  }
  return args[0];
}

/**
 * @param {object} options
 * @param {string} options.appVersion  version read from the repo package.json
 * @param {string} options.profile     build profile the www/ tree was configured with
 * @param {Iterable<string>} options.supportedLocales fixed bundled locale ids
 * @param {(locale:string) => string} options.setLocale host-side locale adapter
 */
function registerIpcHandlers(options = {}) {
  const appVersion = options.appVersion || '0.0.0';
  const profile = options.profile || 'unknown';
  const buildInfo = options.buildInfo || null;
  const supportedLocales = new Set(options.supportedLocales || []);
  const setLocale = typeof options.setLocale === 'function' ? options.setLocale : null;

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
      // Build provenance for a packaged preview, so a tester can say exactly
      // which build they are looking at. Null in development. These are inert
      // facts — no behaviour keys off them.
      commit: (buildInfo && buildInfo.commit) || null,
      builtAt: (buildInfo && buildInfo.builtAt) || null,
      channel: (buildInfo && buildInfo.channel) || 'development',
    };
  });

  ipcMain.handle(CHANNELS.SET_LOCALE, (_event, ...args) => {
    const locale = assertLocaleArgument(CHANNELS.SET_LOCALE, args, supportedLocales);
    if (!setLocale) throw new Error(`${CHANNELS.SET_LOCALE}: host locale adapter unavailable`);
    return { locale: setLocale(locale) };
  });
}

/** Used by tests to assert the surface has not silently grown. */
function listRegisteredChannels() {
  return Object.values(CHANNELS);
}

module.exports = {
  CHANNELS,
  registerIpcHandlers,
  listRegisteredChannels,
  assertNullary,
  assertLocaleArgument,
};
