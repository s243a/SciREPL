/**
 * probes/security.mjs — the renderer/native boundary checks, as reusable probes.
 *
 * Extracted from security.test.mjs so the packaged build is held to exactly the
 * same standard as the development shell, using the same code. A packaged app
 * that quietly regained Node access while a separate, drifting copy of the
 * assertions kept passing is precisely the failure this arrangement prevents.
 *
 * Every probe takes a Playwright `Page` and returns plain data — no assertions,
 * no reporter — so each caller decides how to grade the result.
 *
 * The probes are written from the notebook author's position: where possible
 * they execute through the real JavaScript kernel, in the main world, which is
 * how user notebook code actually runs (www/js/kernels/javascript.js).
 */

/** Run a snippet through the real JavaScript kernel, as a notebook cell would. */
export async function runNotebookCell(page, code) {
  return page.evaluate(async (src) => {
    const km = window.kernelManager;
    await km.ensureReady('javascript');
    return await km.execute(src, 'javascript');
  }, code);
}

/** Node globals visible on `window` in the renderer. All should be undefined. */
export async function probeRendererNodeGlobals(page) {
  return page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    Buffer: typeof window.Buffer,
    module: typeof window.module,
    exports: typeof window.exports,
    global: typeof window.global,
    __dirname: typeof window.__dirname,
    electron: typeof window.electron,
    ipcRenderer: typeof window.ipcRenderer,
  }));
}

/**
 * The same question asked from inside a notebook cell — the case that actually
 * matters, since notebook code shares the renderer realm with the UI.
 * Returns a map of name -> typeof, or 'ReferenceError'.
 */
export async function probeNotebookNodeGlobals(page) {
  const res = await runNotebookCell(page, `
    const probe = {};
    for (const name of ['require','process','Buffer','module','__dirname','global','electron','ipcRenderer']) {
      try { probe[name] = typeof eval(name); } catch (e) { probe[name] = 'ReferenceError'; }
    }
    JSON.stringify(probe)
  `);
  try {
    return JSON.parse(res.result?.content || '{}');
  } catch {
    return {};
  }
}

/** The classic escapes: Function constructor, top, parent. */
export async function probeNotebookEscapes(page) {
  const res = await runNotebookCell(page, `
    const out = {};
    try { out.processViaCtor = typeof (new Function('return process'))(); } catch (e) { out.processViaCtor = 'blocked:' + e.name; }
    try { out.requireViaTop = typeof top.require; } catch (e) { out.requireViaTop = 'blocked:' + e.name; }
    try { out.requireViaParent = typeof parent.require; } catch (e) { out.requireViaParent = 'blocked:' + e.name; }
    JSON.stringify(out)
  `);
  try {
    return JSON.parse(res.result?.content || '{}');
  } catch {
    return {};
  }
}

/** Anything reachable that would constitute a real capability. */
export function reachableCapabilities(map) {
  return Object.entries(map).filter(([, v]) => v === 'function' || v === 'object');
}

/** The exposed preload surface: shape, freeze state, and absence of hatches. */
export async function probeExposedSurface(page) {
  return page.evaluate(() => {
    const api = window.sciREPLPlatform;
    if (!api) return null;
    const hatches = ['invoke', 'send', 'on', 'ipc', 'ipcRenderer', 'require', 'exec', 'spawn',
      'readFile', 'writeFile', 'fs', 'shell', 'openPath', 'eval']
      .filter((k) => typeof api[k] !== 'undefined');
    return {
      keys: Object.keys(api).sort(),
      frozen: Object.isFrozen(api),
      types: Object.fromEntries(Object.keys(api).map((k) => [k, typeof api[k]])),
      hatches,
    };
  });
}

/** The two read-only calls plus the narrowly validated native-locale call. */
export async function probePlatformApi(page) {
  return page.evaluate(async () => {
    const appInfo = await window.sciREPLPlatform.getAppInfo();
    const dist = await window.sciREPLPlatform.getDistributionInfo();
    // Renderer-supplied arguments must be inert: the preload wrapper is nullary
    // and forwards nothing.
    const withArgs = await window.sciREPLPlatform.getAppInfo('extra', { evil: true }, 42);
    const locale = await window.sciREPLPlatform.setLocale('en');
    let invalidLocaleRejected = false;
    try { await window.sciREPLPlatform.setLocale('../../etc/passwd'); }
    catch { invalidLocaleRejected = true; }
    return {
      appInfo,
      dist,
      argsInert: JSON.stringify(appInfo) === JSON.stringify(withArgs),
      locale,
      invalidLocaleRejected,
    };
  });
}

/** webPreferences as the main process actually constructed the window. */
export async function probeWebPreferences(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const p = wc.getLastWebPreferences() || {};
    return {
      nodeIntegration: p.nodeIntegration ?? null,
      contextIsolation: p.contextIsolation ?? null,
      sandbox: p.sandbox ?? null,
      webSecurity: p.webSecurity ?? null,
      webviewTag: p.webviewTag ?? null,
    };
  });
}

/**
 * Attempt to navigate the window off the app origin from a notebook cell, and
 * to open a new window. Neither may succeed.
 */
export async function probeNavigationPolicy(page, electronApp) {
  const beforeUrl = page.url();
  await runNotebookCell(page, `try { window.location.href = 'https://example.com/'; } catch (e) {} ; 1`);
  await page.waitForTimeout(1500);
  const afterUrl = page.url();

  const windowsBefore = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await runNotebookCell(page, `try { window.open('https://example.com/'); } catch (e) {}; 1`);
  await page.waitForTimeout(1500);
  const windowsAfter = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  return { beforeUrl, afterUrl, navigated: beforeUrl !== afterUrl, windowsBefore, windowsAfter };
}

/**
 * Grade the core boundary probes against one page. Shared by the development
 * and packaged suites so both enforce an identical standard.
 *
 * @param {object} r reporter (createReporter)
 * @param {string} label prefix for assertion names
 */
export async function assertBoundary(r, page, electronApp, label = '') {
  const p = label ? `${label}: ` : '';

  const rendererGlobals = await probeRendererNodeGlobals(page);
  const leaked = Object.entries(rendererGlobals).filter(([, v]) => v !== 'undefined');
  r.log(`${p}no Node global is exposed on window`,
    leaked.length === 0, JSON.stringify(rendererGlobals));

  const cellGlobals = await probeNotebookNodeGlobals(page);
  const cellLeaked = Object.entries(cellGlobals)
    .filter(([, v]) => v !== 'undefined' && v !== 'ReferenceError');
  r.log(`${p}a notebook cell cannot reach any Node global`,
    cellLeaked.length === 0, JSON.stringify(cellGlobals));

  const escapes = await probeNotebookEscapes(page);
  r.log(`${p}a notebook cell cannot reach Node via Function constructor / top / parent`,
    reachableCapabilities(escapes).length === 0, JSON.stringify(escapes));

  const surface = await probeExposedSurface(page);
  r.log(`${p}the exposed surface is exactly [getAppInfo, getDistributionInfo, setLocale]`,
    surface && JSON.stringify(surface.keys) ===
      JSON.stringify(['getAppInfo', 'getDistributionInfo', 'setLocale']),
    surface && JSON.stringify(surface.keys));
  r.log(`${p}the exposed API object is frozen`, surface?.frozen === true);
  r.log(`${p}no generic invoke/send/fs/shell escape hatch is exposed`,
    surface && surface.hatches.length === 0, JSON.stringify(surface && surface.hatches));

  const api = await probePlatformApi(page);
  r.log(`${p}getAppInfo returns build facts only`,
    !!api.appInfo && typeof api.appInfo.electronVersion === 'string'
      && !('cwd' in api.appInfo) && !('env' in api.appInfo),
    JSON.stringify(api.appInfo));
  r.log(`${p}renderer-supplied arguments to the platform API are inert`, api.argsInert === true);
  r.log(`${p}the native locale bridge accepts only a bundled locale id`,
    api.locale?.locale === 'en' && api.invalidLocaleRejected === true,
    JSON.stringify(api.locale));
  r.log(`${p}no entitlement/licence value is fabricated`, api.dist.store === null,
    JSON.stringify(api.dist.store));

  const prefs = await probeWebPreferences(electronApp);
  r.log(`${p}nodeIntegration is false`, prefs.nodeIntegration === false, String(prefs.nodeIntegration));
  r.log(`${p}contextIsolation is true`, prefs.contextIsolation === true, String(prefs.contextIsolation));
  r.log(`${p}sandbox is true`, prefs.sandbox === true, String(prefs.sandbox));
  r.log(`${p}webSecurity is enabled`, prefs.webSecurity !== false, String(prefs.webSecurity));
  r.log(`${p}webviewTag is disabled`, prefs.webviewTag === false, String(prefs.webviewTag));

  const nav = await probeNavigationPolicy(page, electronApp);
  r.log(`${p}a notebook cell cannot navigate the window off the app origin`,
    nav.navigated === false, `${nav.beforeUrl} -> ${nav.afterUrl}`);
  r.log(`${p}window.open does not create a new Electron window`,
    nav.windowsAfter === nav.windowsBefore, `${nav.windowsBefore} -> ${nav.windowsAfter}`);

  return { rendererGlobals, cellGlobals, escapes, surface, api, prefs, nav };
}
