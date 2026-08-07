/**
 * main.js — SciREPL Windows/Electron shell (Phase 0 feasibility spike, Free only).
 *
 * This is intentionally a thin shell. It does not modify, wrap or reimplement
 * any application behaviour: it establishes a stable secure origin (protocol.js),
 * locks the renderer down (security.js, preload.js), and loads the same prepared
 * `www/` tree that the PWA and the Capacitor/Android build already use.
 *
 * No Capacitor code is referenced here, and nothing in this directory is
 * reachable from the Android project.
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const {
  START_URL,
  ORIGIN,
  registerScheme,
  registerProtocolHandler,
} = require('./protocol');
const { applyWebContentsPolicy } = require('./security');
const { registerIpcHandlers } = require('./ipc');

/** Repository root, two levels up from desktop/electron/. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WWW_ROOT = process.env.SCIREPL_WWW || path.join(REPO_ROOT, 'www');

/**
 * A distinct userData directory. The shell must not collide with any other
 * Electron app's storage, and keeping it explicit makes the "does IndexedDB
 * survive restart" test meaningful and lets tests point at a scratch profile.
 */
if (process.env.SCIREPL_USER_DATA) {
  app.setPath('userData', process.env.SCIREPL_USER_DATA);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'SciREPL-Free-Electron'));
}

function readAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readProfile() {
  // scripts/configure-build.mjs writes www/js/kernel_config.js from
  // build-profiles.json. Report which profile the tree was configured with so
  // the shell never has to guess which kernels should be present.
  try {
    const src = fs.readFileSync(path.join(WWW_ROOT, 'js', 'kernel_config.js'), 'utf8');
    // Generated form is `"profile": "full"` inside window.KERNEL_CONFIG.
    const m = src.match(/["']?profile["']?\s*:\s*["']([^"']+)["']/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return 'unknown';
}

/** Scheme registration must happen before the app is ready. */
registerScheme();

// Single instance: a second launch focuses the existing window rather than
// opening a second renderer against the same IndexedDB, which would risk
// concurrent writes to notebooks and SharedVFS.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // `return` is legal at the top level of a CommonJS module and stops the rest
  // of this file from running. Without it, a losing instance called quit() and
  // then went on to register `whenReady` and build a window anyway — a process
  // that is quitting but still waiting for `ready` never becomes ready and never
  // exits, which presents as a launch that hangs until it is killed.
  app.quit();
  return;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: '#0d1117', // matches the app's theme-color, avoids white flash
    title: 'SciREPL',
    webPreferences: {
      // --- the security boundary ---
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  applyWebContentsPolicy(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(START_URL);
  return mainWindow;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/**
 * Smoke mode (SCIREPL_SMOKE_EXIT=1): load the app once, print a machine-readable
 * verdict on stdout, and exit.
 *
 * This exists because Playwright reports a failed Electron launch as an opaque
 * timeout with no output from the main process, which makes a CI-only startup
 * failure very hard to diagnose. Running the shell directly and printing what
 * happened turns that into a one-line answer. It is inert unless the variable
 * is set, and it never runs during normal use or the test suite proper.
 */
function runSmokeCheck(win) {
  const done = (line, code) => {
    console.log(line);
    setImmediate(() => app.exit(code));
  };

  const timer = setTimeout(
    () => done('SCIREPL_SMOKE_FAIL timeout: window never finished loading', 3),
    60_000
  );

  win.webContents.once('did-finish-load', () => {
    clearTimeout(timer);
    done(`SCIREPL_SMOKE_OK url=${win.webContents.getURL()}`, 0);
  });

  win.webContents.once('did-fail-load', (_e, code, desc, url) => {
    clearTimeout(timer);
    done(`SCIREPL_SMOKE_FAIL did-fail-load code=${code} desc=${desc} url=${url}`, 2);
  });

  win.webContents.once('render-process-gone', (_e, details) => {
    clearTimeout(timer);
    done(`SCIREPL_SMOKE_FAIL render-process-gone reason=${details && details.reason}`, 4);
  });
}

app.whenReady().then(() => {
  if (process.env.SCIREPL_SMOKE_EXIT === '1') {
    console.log(`SCIREPL_SMOKE_READY electron=${process.versions.electron} chrome=${process.versions.chrome} www=${WWW_ROOT}`);
  }

  registerProtocolHandler(WWW_ROOT);
  registerIpcHandlers({ appVersion: readAppVersion(), profile: readProfile() });

  createWindow();

  if (process.env.SCIREPL_SMOKE_EXIT === '1') runSmokeCheck(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Shutdown. Ask Chromium to flush the storage partition so notebook and
 * SharedVFS writes that are still buffered reach disk if the user quits while
 * a kernel is running.
 *
 * This deliberately does NOT preventDefault() and force an exit. An earlier
 * revision did, and it deadlocked graceful shutdown: the quit was cancelled and
 * restarted from inside the handler, so callers waiting for a normal exit
 * (Playwright's electronApp.close(), and by extension a user's window-close)
 * never observed one. Chromium already tears the session down correctly on a
 * normal quit; the flush is the only thing worth adding.
 */
app.on('before-quit', () => {
  try {
    session.defaultSession.flushStorageData();
  } catch { /* best effort — never block shutdown */ }
});

app.on('window-all-closed', () => {
  // Windows/Linux: quitting with the last window is the expected behaviour.
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Refuse to create any additional renderer with unsafe preferences, and apply
 * the same policy to every WebContents the app ever creates.
 */
app.on('web-contents-created', (_event, contents) => {
  applyWebContentsPolicy(contents);
});
