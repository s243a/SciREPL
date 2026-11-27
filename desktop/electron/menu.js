/**
 * menu.js — the application menu.
 *
 * Two reasons this exists rather than leaving Electron's default menu in place.
 *
 * 1. The default menu is Electron's, not SciREPL's. Its Help item links to
 *    electronjs.org, which is the wrong thing to offer someone evaluating
 *    SciREPL.
 *
 * 2. More importantly, the shell keeps a runtime cache in its data directory
 *    (runtime-cache.js) that the application's own **Memory & Storage** panel
 *    cannot see or clear. That panel works through the Cache API, which is
 *    always empty under `app://`:
 *
 *      - "Clear Cache" deletes two empty caches, reports success, and leaves
 *        the downloaded runtimes on disk;
 *      - the per-runtime "Clear Cache" button never appears, because it is
 *        shown only when the CDN cache has matching entries;
 *      - the storage figure comes from `navigator.storage.estimate()`, which
 *        does not count plain files in userData.
 *
 *    Shipping a cache with no way to inspect or clear it is not acceptable, and
 *    the panel lives in `www/`, which is shared with the PWA and Android and is
 *    not modified by the shell. So the shell provides the management surface it
 *    owns. Teaching the in-app panel about it needs a shared-code change and is
 *    recorded as Phase 1 work in docs/WINDOWS_ELECTRON_SPIKE.md.
 *
 * Everything here runs in the main process and is driven by the user through
 * the menu bar. The renderer can select only a bundled locale id through the
 * narrow IPC boundary; it cannot supply labels, dialog text, paths, or menu
 * actions.
 */

const fs = require('fs');
const { Menu, dialog, shell, app } = require('electron');
const { ENGLISH, interpolate } = require('./native-i18n');
const { resolveExplorerDataDir } = require('./paths');

const REPO_URL = 'https://github.com/s243a/SciREPL';

/**
 * localStorage prefix of the renderer's "this runtime loaded through the
 * shell cache" receipts (www/js/kernel_manager.js,
 * KernelManager.ELECTRON_RUNTIME_RECEIPT_PREFIX). Clearing the cache must clear
 * them too, or the download prompt would be skipped for runtimes no longer on
 * disk.
 */
const RUNTIME_RECEIPT_PREFIX = 'scirepl_electron_runtime_receipt:';

/**
 * A fixed script, no renderer- or user-supplied text: remove every receipt key
 * from the app window's localStorage and report how many went.
 */
const CLEAR_RECEIPTS_SCRIPT = `(() => {
  const prefix = ${JSON.stringify(RUNTIME_RECEIPT_PREFIX)};
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
  return keys.length;
})()`;

/** Best effort: a missing or crashed window has no receipts to keep. */
async function clearRuntimeReceipts(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return 0;
  const wc = win.webContents;
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return 0;
  try {
    return await wc.executeJavaScript(CLEAR_RECEIPTS_SCRIPT, false);
  } catch (_) {
    return 0;
  }
}

function formatBytes(bytes, locale = 'en') {
  const units = ['B', 'kB', 'MB', 'GB'];
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `${new Intl.NumberFormat(locale).format(0)} ${units[0]}`;
  }
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / Math.pow(1000, i);
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: i === 0 ? 0 : 1,
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(value);
  return `${number} ${units[i]}`;
}

/** Windows-style mnemonic without putting accelerator syntax in catalogues. */
function mnemonic(label) {
  return `&${String(label).replace(/&/g, '&&')}`;
}

/**
 * @param {object} deps
 * @param {() => import('./runtime-cache').RuntimeCache|null} deps.getCache
 * @param {() => object|null} deps.getBuildInfo
 * @param {() => Electron.BrowserWindow|null} deps.getWindow
 * @param {string} deps.appVersion
 * @param {(key:string, values?:object) => string} deps.t plain-text host translator
 * @param {() => string} deps.getLocale
 * @param {(value:unknown) => string} deps.literal bidi-safe literal formatter
 */
function createMenuTemplate(deps) {
  const { getCache, getBuildInfo, getWindow, appVersion } = deps;
  const t = deps.t || ((key, values) => interpolate(ENGLISH[key] || key, values));
  const getLocale = deps.getLocale || (() => 'en');
  const literal = deps.literal || String;
  // Injectable for pure unit tests; production always uses Electron's objects.
  const hostDialog = deps.dialog || dialog;
  const hostShell = deps.shell || shell;
  const hostApp = deps.app || app;
  const hostProcess = deps.process || process;
  const folderExists = deps.folderExists || ((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });

  async function openAppData() {
    // A fixed, application-owned path. No renderer input reaches this.
    const folder = resolveExplorerDataDir({
      userData: hostApp.getPath('userData'),
      appData: hostApp.getPath('appData'),
      localAppData: (hostProcess.env || {}).LOCALAPPDATA,
      windowsStore: hostProcess.windowsStore === true,
      execPath: hostProcess.execPath,
      exists: folderExists,
    });
    const error = await hostShell.openPath(folder);
    if (!error) return;
    // Explorer could not open it: show where it is rather than nothing.
    await hostDialog.showMessageBox(getWindow(), {
      type: 'info',
      title: t('electron.menu.openAppData'),
      message: literal(folder),
    });
  }

  async function showCacheInfo() {
    const cache = getCache();
    const win = getWindow();
    if (!cache) {
      await hostDialog.showMessageBox(win, {
        type: 'info',
        title: t('electron.cache.infoTitle'),
        message: t('electron.cache.disabled'),
        detail: t('electron.cache.disabledDetail'),
      });
      return;
    }
    const { bytes, entries } = await cache.size();
    await hostDialog.showMessageBox(win, {
      type: 'info',
      title: t('electron.cache.infoTitle'),
      message: entries === 0
        ? t('electron.cache.empty')
        : t('electron.cache.summary', {
            bytes: formatBytes(bytes, getLocale()),
            entries: new Intl.NumberFormat(getLocale()).format(entries),
          }),
      detail: t('electron.cache.locationDetail') + '\n\n' + literal(cache.dir),
    });
  }

  async function clearCache() {
    const cache = getCache();
    const win = getWindow();
    if (!cache) return;

    const { bytes, entries } = await cache.size();
    if (entries === 0) {
      // Files already gone (e.g. deleted by hand): drop any stale receipts so
      // the prompt comes back.
      await clearRuntimeReceipts(win);
      await hostDialog.showMessageBox(win, {
        type: 'info',
        title: t('electron.cache.clearTitle'),
        message: t('electron.cache.nothingToClear'),
      });
      return;
    }

    // Destructive and not obviously reversible without a network connection,
    // so it is confirmed rather than done on a single click.
    const { response } = await hostDialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('electron.cache.cancel'), t('electron.cache.clear')],
      defaultId: 0,
      cancelId: 0,
      title: t('electron.cache.clearTitle'),
      message: t('electron.cache.confirm', { bytes: formatBytes(bytes, getLocale()) }),
      detail: t('electron.cache.confirmDetail'),
    });
    if (response !== 1) return;

    await cache.clear();
    await clearRuntimeReceipts(win);
    await hostDialog.showMessageBox(win, {
      type: 'info',
      title: t('electron.cache.clearTitle'),
      message: t('electron.cache.cleared', { bytes: formatBytes(bytes, getLocale()) }),
      detail: t('electron.cache.clearedDetail'),
    });
  }

  async function showAbout() {
    const info = getBuildInfo();
    const lines = [
      `${t('electron.about.version')} ${literal(appVersion)}`,
      literal(`Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`),
    ];
    if (info) {
      if (info.profile) lines.push(`${t('electron.about.buildProfile')}: ${literal(info.profile)}`);
      if (info.channel) lines.push(`${t('electron.about.channel')}: ${literal(info.channel)}`);
      if (info.commit) {
        lines.push(`${t('electron.about.commit')}: ${literal(String(info.commit).slice(0, 12))}`);
      }
    }
    await hostDialog.showMessageBox(getWindow(), {
      type: 'info',
      title: t('electron.about.title'),
      message: 'SciREPL',
      detail: lines.join('\n'),
    });
  }

  const template = [
    {
      label: mnemonic(t('electron.menu.file')),
      submenu: [
        { role: 'reload', label: t('electron.menu.reload') },
        // Force Reload discards Chromium's own HTTP cache. It deliberately does
        // NOT touch the runtime cache: reloading the interface should not throw
        // away a 20 MB download.
        { role: 'forceReload', label: t('electron.menu.forceReload') },
        { type: 'separator' },
        { role: 'quit', label: t('electron.menu.quit') },
      ],
    },
    {
      // Essential for a REPL — without these, copy and paste have no menu
      // accelerators on Windows.
      label: mnemonic(t('electron.menu.edit')),
      submenu: [
        { role: 'undo', label: t('electron.menu.undo') },
        { role: 'redo', label: t('electron.menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('electron.menu.cut') },
        { role: 'copy', label: t('electron.menu.copy') },
        { role: 'paste', label: t('electron.menu.paste') },
        { role: 'selectAll', label: t('electron.menu.selectAll') },
      ],
    },
    {
      label: mnemonic(t('electron.menu.view')),
      submenu: [
        { role: 'resetZoom', label: t('electron.menu.resetZoom') },
        { role: 'zoomIn', label: t('electron.menu.zoomIn') },
        { role: 'zoomOut', label: t('electron.menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('electron.menu.toggleFullscreen') },
        { role: 'toggleDevTools', label: t('electron.menu.toggleDevTools') },
        // Ctrl+= as a second Zoom In shortcut: the role's own Ctrl+Plus needs
        // Shift on a US keyboard (see zoom.js). Hidden, so the menu shows one
        // Zoom In; the accelerator still works.
        {
          role: 'zoomIn',
          label: t('electron.menu.zoomIn'),
          accelerator: 'CommandOrControl+=',
          visible: false,
          acceleratorWorksWhenHidden: true,
        },
      ],
    },
    {
      label: mnemonic(t('electron.menu.runtimes')),
      submenu: [
        { label: t('electron.menu.downloadedRuntimes'), click: showCacheInfo },
        { label: t('electron.menu.clearDownloadedRuntimes'), click: clearCache },
        { type: 'separator' },
        {
          label: t('electron.menu.openAppData'),
          click: openAppData,
        },
      ],
    },
    {
      label: mnemonic(t('electron.menu.help')),
      submenu: [
        { label: t('electron.menu.about'), click: showAbout },
        {
          label: t('electron.menu.github'),
          // Goes through the same policy as an in-page link: https only.
          click: () => hostShell.openExternal(REPO_URL),
        },
      ],
    },
  ];

  return template;
}

function buildApplicationMenu(deps) {
  return Menu.buildFromTemplate(createMenuTemplate(deps));
}

/** Build and install the menu. */
function installApplicationMenu(deps) {
  const menu = buildApplicationMenu(deps);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = {
  installApplicationMenu,
  buildApplicationMenu,
  createMenuTemplate,
  formatBytes,
  mnemonic,
  REPO_URL,
  RUNTIME_RECEIPT_PREFIX,
  CLEAR_RECEIPTS_SCRIPT,
};
