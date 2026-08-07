/**
 * security.test.mjs — regression tests for the renderer/native boundary.
 *
 * These are written from the notebook author's position: everything here is
 * executed the way a hostile notebook cell would execute it, i.e. in the main
 * world of the renderer, via the JavaScript kernel where possible. The point is
 * not that SciREPL's own code behaves — it is that *arbitrary user code* cannot
 * reach Node or unrestricted Electron capability.
 */

import { launchShell, createReporter, waitForAppReady, attachLogs } from './harness.mjs';

/** Run a snippet through the real JavaScript kernel, as a notebook cell would. */
async function runNotebookCell(page, code) {
  return page.evaluate(async (src) => {
    const km = window.kernelManager;
    await km.ensureReady('javascript');
    return await km.execute(src, 'javascript');
  }, code);
}

export default async function run() {
  const r = createReporter('security');
  const shell = await launchShell();
  attachLogs(shell.page);

  try {
    const { page } = shell;
    await waitForAppReady(page);

    // Record whether the OS sandbox was actually on, so a relaxed CI run can
    // never be mistaken for a clean one in the report.
    const sandboxRelaxed = process.env.SCIREPL_ELECTRON_NO_SANDBOX === '1';
    r.log('renderer ran with the OS sandbox enabled', !sandboxRelaxed,
      sandboxRelaxed ? 'SCIREPL_ELECTRON_NO_SANDBOX=1 — result does not attest to OS sandboxing' : '');

    /* ---------------- Node is absent from the renderer ---------------- */

    const nodeGlobals = await page.evaluate(() => ({
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
    for (const [name, type] of Object.entries(nodeGlobals)) {
      r.log(`renderer global \`${name}\` is undefined`, type === 'undefined', type);
    }

    /* ------- the same, but executed as a notebook cell (the real threat) ------- */

    const cellProbe = await runNotebookCell(page, `
      const probe = {};
      for (const name of ['require','process','Buffer','module','__dirname','global','electron','ipcRenderer']) {
        try { probe[name] = typeof eval(name); } catch (e) { probe[name] = 'ReferenceError'; }
      }
      JSON.stringify(probe)
    `);
    let cellGlobals = {};
    try { cellGlobals = JSON.parse(cellProbe.result?.content || '{}'); } catch { /* leave empty */ }
    const reachable = Object.entries(cellGlobals).filter(([, v]) => v !== 'undefined' && v !== 'ReferenceError');
    r.log('notebook cell cannot reach any Node global',
      reachable.length === 0, JSON.stringify(cellGlobals));

    // The classic escapes.
    const escapes = await runNotebookCell(page, `
      const out = {};
      try { out.processViaCtor = typeof (new Function('return process'))(); } catch (e) { out.processViaCtor = 'blocked:' + e.name; }
      try { out.requireViaTop = typeof top.require; } catch (e) { out.requireViaTop = 'blocked:' + e.name; }
      try { out.requireViaParent = typeof parent.require; } catch (e) { out.requireViaParent = 'blocked:' + e.name; }
      JSON.stringify(out)
    `);
    let escapeResult = {};
    try { escapeResult = JSON.parse(escapes.result?.content || '{}'); } catch { /* leave empty */ }
    const escaped = Object.entries(escapeResult).filter(([, v]) => v === 'function' || v === 'object');
    r.log('notebook cell cannot reach Node via Function constructor / top / parent',
      escaped.length === 0, JSON.stringify(escapeResult));

    /* ---------------- the exposed surface is exactly the allowlist ---------------- */

    const surface = await page.evaluate(() => {
      const api = window.sciREPLPlatform;
      if (!api) return null;
      return {
        keys: Object.keys(api).sort(),
        frozen: Object.isFrozen(api),
        types: Object.fromEntries(Object.keys(api).map(k => [k, typeof api[k]])),
      };
    });
    r.log('preload exposes the platform API', surface !== null, JSON.stringify(surface));
    r.log('exposed surface is exactly [getAppInfo, getDistributionInfo]',
      surface && JSON.stringify(surface.keys) === JSON.stringify(['getAppInfo', 'getDistributionInfo']),
      surface && JSON.stringify(surface.keys));
    r.log('exposed API object is frozen', surface?.frozen === true);

    // No generic escape hatch of any name.
    const hatches = await page.evaluate(() => {
      const api = window.sciREPLPlatform || {};
      return ['invoke', 'send', 'on', 'ipc', 'ipcRenderer', 'require', 'exec', 'spawn',
        'readFile', 'writeFile', 'fs', 'shell', 'openPath', 'eval']
        .filter(k => typeof api[k] !== 'undefined');
    });
    r.log('no generic invoke/send/fs/shell escape hatch is exposed',
      Array.isArray(hatches) && hatches.length === 0, JSON.stringify(hatches));

    /* ---------------- the allowlisted ops are safe and work ---------------- */

    const appInfo = await page.evaluate(() => window.sciREPLPlatform.getAppInfo());
    r.log('getAppInfo returns build facts only',
      !!appInfo && typeof appInfo.electronVersion === 'string' && !('cwd' in appInfo) && !('env' in appInfo),
      JSON.stringify(appInfo));

    const dist = await page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
    r.log('getDistributionInfo reports the Free edition',
      dist && dist.edition === 'free' && dist.container === 'electron', JSON.stringify(dist));
    r.log('no entitlement/licence value is fabricated',
      dist && dist.store === null, JSON.stringify(dist && dist.store));

    // Renderer-supplied arguments are inert: the preload wrapper takes no
    // parameters and forwards none, so nothing the caller passes can reach the
    // main process or influence the reply. (The main process independently
    // rejects arguments on the channel — see ipc.unit.test.mjs, which covers
    // assertNullary directly; that guard matters if the channel is ever reached
    // by something other than this wrapper.)
    const argEffect = await page.evaluate(async () => {
      const plain = await window.sciREPLPlatform.getAppInfo();
      const withArgs = await window.sciREPLPlatform.getAppInfo('extra', { evil: true }, 42);
      return { same: JSON.stringify(plain) === JSON.stringify(withArgs), withArgs };
    });
    r.log('renderer-supplied arguments to the platform API are inert',
      argEffect.same === true, JSON.stringify(argEffect.withArgs));

    /* ---------------- navigation policy ---------------- */

    // A notebook cell trying to navigate the shell to a remote origin.
    const beforeUrl = page.url();
    await runNotebookCell(page, `try { window.location.href = 'https://example.com/'; } catch (e) {} ; 1`);
    await page.waitForTimeout(1500);
    const afterUrl = page.url();
    r.log('notebook cell cannot navigate the window off the app origin',
      afterUrl === beforeUrl, `${beforeUrl} -> ${afterUrl}`);

    // The mirror image, and a regression guard: navigation *within* the app
    // must still work. The will-navigate policy classifies URLs in the main
    // process, where Node reports `origin === 'null'` for the custom scheme;
    // an origin-based check silently blocked all in-app navigation here.
    await page.evaluate(() => { window.location.href = 'privacy.html'; });
    await page.waitForURL(/privacy\.html$/, { timeout: 30_000 }).catch(() => {});
    const navigatedInApp = page.url();
    r.log('in-app navigation is permitted', /privacy\.html$/.test(navigatedInApp), navigatedInApp);

    await page.goto('app://scirepl/index.html', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForAppReady(page);
    r.log('can navigate back to the application root', /index\.html$/.test(page.url()), page.url());

    // window.open must never produce a second renderer.
    const windowCount = await shell.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await runNotebookCell(page, `try { window.open('https://example.com/'); } catch (e) {}; 1`);
    await page.waitForTimeout(1500);
    const windowCountAfter = await shell.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    r.log('window.open does not create a new Electron window',
      windowCountAfter === windowCount, `${windowCount} -> ${windowCountAfter}`);

    /* ---------------- webPreferences are as declared ---------------- */

    const prefs = await shell.electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const wc = w.webContents;
      return {
        // These are the values the main process actually constructed the window with.
        nodeIntegration: wc.getLastWebPreferences()?.nodeIntegration ?? null,
        contextIsolation: wc.getLastWebPreferences()?.contextIsolation ?? null,
        sandbox: wc.getLastWebPreferences()?.sandbox ?? null,
        webSecurity: wc.getLastWebPreferences()?.webSecurity ?? null,
        webviewTag: wc.getLastWebPreferences()?.webviewTag ?? null,
      };
    });
    r.log('nodeIntegration is false', prefs.nodeIntegration === false, String(prefs.nodeIntegration));
    r.log('contextIsolation is true', prefs.contextIsolation === true, String(prefs.contextIsolation));
    r.log('sandbox is true', prefs.sandbox === true, String(prefs.sandbox));
    r.log('webSecurity is enabled', prefs.webSecurity !== false, String(prefs.webSecurity));
    r.log('webviewTag is disabled', prefs.webviewTag === false, String(prefs.webviewTag));

    /* ---------------- no remote module ---------------- */

    const remote = await shell.electronApp.evaluate(async ({ app }) => {
      let hasRemote = false;
      try {
        // @electron/remote is not a dependency; if it were reachable this throws not.
        require('@electron/remote/main');
        hasRemote = true;
      } catch { hasRemote = false; }
      return { hasRemote, packaged: app.isPackaged };
    });
    r.log('the remote module is not enabled', remote.hasRemote === false);
  } finally {
    await shell.close();
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
