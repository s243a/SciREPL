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
 * the menu bar. None of it is reachable from the renderer, so the boundary in
 * security.js is unchanged.
 */

const { Menu, dialog, shell, app } = require('electron');

const REPO_URL = 'https://github.com/s243a/SciREPL';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${(bytes / Math.pow(1000, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * @param {object} deps
 * @param {() => import('./runtime-cache').RuntimeCache|null} deps.getCache
 * @param {() => object|null} deps.getBuildInfo
 * @param {() => Electron.BrowserWindow|null} deps.getWindow
 * @param {string} deps.appVersion
 */
function buildApplicationMenu(deps) {
  const { getCache, getBuildInfo, getWindow, appVersion } = deps;

  async function showCacheInfo() {
    const cache = getCache();
    const win = getWindow();
    if (!cache) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Downloaded runtimes',
        message: 'The runtime cache is disabled.',
        detail: 'SCIREPL_RUNTIME_CACHE=0 is set, so downloaded runtimes are not '
          + 'kept in the application data directory.',
      });
      return;
    }
    const { bytes, entries } = await cache.size();
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Downloaded runtimes',
      message: entries === 0
        ? 'No runtimes have been downloaded yet.'
        : `${formatBytes(bytes)} across ${entries} file${entries === 1 ? '' : 's'}.`,
      detail: 'Language runtimes fetched from the internet (Lua, R) are kept here '
        + 'so they keep working offline.\n\n' + cache.dir,
    });
  }

  async function clearCache() {
    const cache = getCache();
    const win = getWindow();
    if (!cache) return;

    const { bytes, entries } = await cache.size();
    if (entries === 0) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Clear downloaded runtimes',
        message: 'There is nothing to clear.',
      });
      return;
    }

    // Destructive and not obviously reversible without a network connection,
    // so it is confirmed rather than done on a single click.
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Clear'],
      defaultId: 0,
      cancelId: 0,
      title: 'Clear downloaded runtimes',
      message: `Delete ${formatBytes(bytes)} of downloaded runtimes?`,
      detail: 'Lua and R will need to be downloaded again the next time you use '
        + 'them, which requires an internet connection.\n\n'
        + 'Your notebooks and files are not affected.',
    });
    if (response !== 1) return;

    await cache.clear();
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Clear downloaded runtimes',
      message: `Cleared ${formatBytes(bytes)}.`,
      detail: 'Runtimes already loaded stay available until you restart.',
    });
  }

  async function showAbout() {
    const info = getBuildInfo();
    const lines = [
      `Version ${appVersion}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    ];
    if (info) {
      if (info.profile) lines.push(`Build profile: ${info.profile}`);
      if (info.channel) lines.push(`Channel: ${info.channel}`);
      if (info.commit) lines.push(`Commit: ${String(info.commit).slice(0, 12)}`);
    }
    await dialog.showMessageBox(getWindow(), {
      type: 'info',
      title: 'About SciREPL',
      message: 'SciREPL',
      detail: lines.join('\n'),
    });
  }

  const template = [
    {
      label: '&File',
      submenu: [
        { role: 'reload' },
        // Force Reload discards Chromium's own HTTP cache. It deliberately does
        // NOT touch the runtime cache: reloading the interface should not throw
        // away a 20 MB download.
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      // Essential for a REPL — without these, copy and paste have no menu
      // accelerators on Windows.
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Runtimes',
      submenu: [
        { label: 'Downloaded runtimes…', click: showCacheInfo },
        { label: 'Clear downloaded runtimes…', click: clearCache },
        { type: 'separator' },
        {
          label: 'Open application data folder',
          click: () => {
            // A fixed, application-owned path. No renderer input reaches this.
            shell.openPath(app.getPath('userData'));
          },
        },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'About SciREPL', click: showAbout },
        {
          label: 'SciREPL on GitHub',
          // Goes through the same policy as an in-page link: https only.
          click: () => shell.openExternal(REPO_URL),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** Build and install the menu. */
function installApplicationMenu(deps) {
  const menu = buildApplicationMenu(deps);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { installApplicationMenu, buildApplicationMenu, formatBytes, REPO_URL };
