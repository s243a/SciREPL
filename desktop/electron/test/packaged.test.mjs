/**
 * packaged.test.mjs — verify the PACKAGED preview, not the development shell.
 *
 * This is the suite that answers "can someone download the ZIP, run
 * SciREPL.exe, and get a working, still-locked-down SciREPL?". Everything here
 * drives the real packaged binary with no repository present in the equation:
 * `SCIREPL_WWW` is deliberately not set, so the app has to find its own bundled
 * `resources/www` or fail.
 *
 * It reuses the existing probes rather than restating them —
 * `probes/security.mjs` for the renderer/native boundary and
 * `probes/kernels.mjs` for execution — so the packaged build is held to exactly
 * the same standard as the development shell. A packaged app that quietly
 * regained Node access, or lost a kernel, fails here on the same assertions.
 *
 *   npm run package:windows          # build it first
 *   node desktop/electron/test/packaged.test.mjs
 *
 *   SCIREPL_PACKAGED_EXE=/path/to/SciREPL.exe node .../packaged.test.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  launchPackagedShell, createReporter, waitForAppReady, attachLogs, ELECTRON_DIR, APP_ORIGIN,
} from './harness.mjs';
import { assertBoundary } from './probes/security.mjs';
import { KERNEL_CASES, runKernel, enabledKernels } from './probes/kernels.mjs';

/** Locate the packaged executable produced by packaging/build-portable.mjs. */
function findPackagedExe() {
  if (process.env.SCIREPL_PACKAGED_EXE) return process.env.SCIREPL_PACKAGED_EXE;

  const outDir = path.join(ELECTRON_DIR, 'out');
  if (!existsSync(outDir)) return null;

  const exeName = process.platform === 'win32' ? 'SciREPL.exe' : 'SciREPL';
  // Prefer a build matching this host, since that is the only one we can run.
  const preferred = `SciREPL-${process.platform}-${process.arch}`;
  const candidates = readdirSync(outDir).sort((a, b) =>
    (b === preferred ? 1 : 0) - (a === preferred ? 1 : 0));

  for (const dir of candidates) {
    const exe = path.join(outDir, dir, exeName);
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** Total size of a directory tree. */
function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

export default async function run() {
  const r = createReporter('packaged');

  const exe = findPackagedExe();
  if (!exe) {
    r.log('a packaged build is available to test', false,
      'none found under desktop/electron/out — run `npm run package:windows` first');
    return r.summary();
  }

  const appDir = path.dirname(exe);
  const resources = path.join(appDir, 'resources');
  r.log('packaged executable found', true, exe);

  /* ---------------- static checks on the artifact ---------------- */

  r.log('the app ships its own www/ tree',
    existsSync(path.join(resources, 'www', 'index.html')),
    path.join(resources, 'www', 'index.html'));
  r.log('the shell itself is packed into an asar',
    existsSync(path.join(resources, 'app.asar')));

  // Free-only boundary, asserted against what would actually be distributed.
  const webrDir = path.join(resources, 'www', 'vendor', 'webr');
  r.log('the artifact contains no offline R runtime (that is the Pro profile)',
    !existsSync(webrDir), webrDir);

  const proDirs = ['pro', 'Pro'].map((d) => path.join(resources, 'www', d)).filter(existsSync);
  r.log('the artifact contains no Pro application directory',
    proDirs.length === 0, proDirs.join(', '));

  let buildInfo = null;
  try {
    buildInfo = JSON.parse(readFileSync(path.join(resources, 'build-info.json'), 'utf8'));
  } catch { /* reported below */ }
  r.log('build metadata is present in the packaged layout', buildInfo !== null);
  r.log('build metadata reports the Free edition',
    buildInfo && buildInfo.edition === 'free', JSON.stringify(buildInfo));
  r.log('build metadata reports a non-Pro profile',
    buildInfo && buildInfo.profile !== 'pro', buildInfo && buildInfo.profile);
  r.log('build metadata marks this a preview, not a release',
    buildInfo && buildInfo.channel === 'preview', buildInfo && buildInfo.channel);

  // Build machinery must not reach a tester's machine.
  for (const leaked of ['test', 'packaging', 'node_modules']) {
    r.log(`the artifact does not ship desktop/electron/${leaked}`,
      !existsSync(path.join(resources, 'app', leaked)));
  }

  r.log('artifact size measured', true, `${(dirSize(appDir) / 1e6).toFixed(1)} MB unpacked`);

  /* ---------------- the packaged app actually runs ---------------- */

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'scirepl-pkg-run-'));
  let shell = await launchPackagedShell({ exePath: exe, userDataDir });
  const logs = attachLogs(shell.page);

  try {
    const { page } = shell;

    const url = page.url();
    r.log('the packaged app loads app://scirepl/index.html',
      url === `${APP_ORIGIN}/index.html`, url);

    await waitForAppReady(page);
    r.log('the application booted inside the package', true);

    const origin = await page.evaluate(() => window.location.origin);
    r.log('the packaged origin is the same stable app origin', origin === APP_ORIGIN, origin);

    const secure = await page.evaluate(() => window.isSecureContext);
    r.log('the packaged origin is a Secure Context', secure === true, String(secure));

    // The app must be serving its OWN www/, not a repository tree.
    const servesOwnTree = await page.evaluate(async () => {
      const res = await fetch('js/kernel_config.js');
      return { ok: res.ok, type: res.headers.get('content-type') };
    });
    r.log('the packaged app serves its bundled assets',
      servesOwnTree.ok === true, JSON.stringify(servesOwnTree));

    // Version and profile must survive the packaged layout — this is what
    // breaks if main.js keeps deriving paths from a repository that is gone.
    const info = await page.evaluate(async () => ({
      app: await window.sciREPLPlatform.getAppInfo(),
      dist: await window.sciREPLPlatform.getDistributionInfo(),
    }));
    r.log('the packaged app reports itself as packaged',
      info.app.packaged === true && info.dist.packaged === true, JSON.stringify(info.app));
    r.log('the application version resolves in the packaged layout',
      typeof info.app.appVersion === 'string'
        && info.app.appVersion !== '0.0.0'
        && info.app.appVersion === (buildInfo && buildInfo.appVersion),
      info.app.appVersion);
    r.log('the build profile resolves in the packaged layout',
      info.dist.profile && info.dist.profile !== 'unknown' && info.dist.profile !== 'pro',
      info.dist.profile);
    r.log('the packaged app reports the Free edition',
      info.dist.edition === 'free', JSON.stringify(info.dist));
    r.log('the packaged app fabricates no entitlement', info.dist.store === null);
    r.log('build provenance is reportable from the packaged app',
      typeof info.dist.commit === 'string' && info.dist.commit.length > 0,
      info.dist.commit);

    /* ---------------- the security boundary, unchanged ---------------- */
    //
    // The same probes the development shell is held to. This is the acceptance
    // criterion that matters most: packaging must not relax anything.
    await assertBoundary(r, page, shell.electronApp, 'packaged');

    /* ---------------- DevTools is available, and costs nothing ---------------- */
    //
    // DevTools in the packaged build is a genuine advantage over Android, where
    // inspecting the WebView needs chrome://inspect, USB debugging and a second
    // machine. It is worth asserting *both* halves: that it still works once
    // packaged (some builds disable it), and that opening it does not widen
    // what the page can reach.
    //
    // It does not, and cannot: the boundary is contextIsolation + sandbox +
    // nodeIntegration:false, which apply to whoever is typing. A user at the
    // DevTools console has exactly what a notebook cell has — which is why this
    // is parity with pressing F12 on the PWA, not an escalation.
    const devtools = await shell.electronApp.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.openDevTools({ mode: 'detach' });
      await new Promise((r) => setTimeout(r, 2500));
      return { open: wc.isDevToolsOpened() };
    });
    r.log('packaged: DevTools can be opened', devtools.open === true);

    const withDevtools = await page.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      viaCtor: (() => {
        try { return typeof (new Function('return process'))(); } catch { return 'blocked'; }
      })(),
      api: Object.keys(window.sciREPLPlatform || {}).sort(),
    }));
    r.log('packaged: DevTools does not expose Node',
      withDevtools.require === 'undefined' && withDevtools.process === 'undefined'
        && withDevtools.viaCtor !== 'object' && withDevtools.viaCtor !== 'function',
      JSON.stringify(withDevtools));
    r.log('packaged: DevTools does not widen the platform API',
      JSON.stringify(withDevtools.api) === JSON.stringify(['getAppInfo', 'getDistributionInfo']));

    await shell.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.closeDevTools();
    });

    /* ---------------- representative bundled kernels ---------------- */

    const enabled = await enabledKernels(page);
    r.log('the packaged build enables the expected Free kernel set',
      enabled.length > 0, enabled.join(','));

    // Bundled (non-network) kernels only. A preview must not be judged on CDN
    // runtimes: the service worker cache is inert under app:// (see
    // docs/WINDOWS_ELECTRON_SPIKE.md §5), so those need the network every run
    // and are not part of what this artifact guarantees.
    const bundledCases = KERNEL_CASES.filter((k) => !k.network && enabled.includes(k.lang));
    for (const kase of bundledCases) {
      const res = await runKernel(page, kase, 180_000);
      r.log(`packaged: ${kase.label} runs`, res.status === 'ok',
        res.status === 'ok' ? `init ${res.initMs}ms, exec ${res.execMs}ms`
                            : `${res.status} ${res.error || ''}`);
      if (res.status === 'ok' && !kase.knownIssue) {
        r.log(`packaged: ${kase.label} produces expected output`,
          kase.expect.test(res.output || ''), JSON.stringify(res.output || ''));
      }
    }

    /* ---------------- SharedVFS + persistence marker ---------------- */

    const marker = `packaged-preview-${Date.now()}`;
    const wrote = await page.evaluate(async (m) => {
      const vfs = window.sharedVFS;
      vfs.writeFile('/shared/packaged.txt', m, 'test');
      await vfs.saveToIndexedDB();
      localStorage.setItem('scirepl_packaged_marker', m);
      return {
        vfs: vfs.readFile('/shared/packaged.txt') === m,
        ls: localStorage.getItem('scirepl_packaged_marker') === m,
      };
    }, marker);
    r.log('packaged: SharedVFS round-trips', wrote.vfs === true, JSON.stringify(wrote));

    const pageErrors = logs.filter((l) => l.startsWith('[pageerror]'));
    r.log('no uncaught page errors in the packaged app',
      pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    /* ---------------- restart the packaged app ---------------- */

    // Report what the app looked like going in, so a shutdown failure says why
    // rather than just "timed out".
    const preClose = await shell.electronApp.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      return {
        windows: wins.length,
        devtoolsOpen: wins[0] ? wins[0].webContents.isDevToolsOpened() : null,
        titles: wins.map((w) => w.getTitle()),
      };
    });
    const closeStarted = Date.now();
    const { timedOut } = await shell.close();
    const closeSeconds = ((Date.now() - closeStarted) / 1000).toFixed(1);
    r.log('the packaged app shuts down gracefully', timedOut === false,
      timedOut
        ? `close() timed out after ${closeSeconds}s and needed SIGKILL — state going in: ${JSON.stringify(preClose)}`
        : `${closeSeconds}s`);

    shell = await launchPackagedShell({ exePath: exe, userDataDir });
    await waitForAppReady(shell.page);

    const restored = await shell.page.evaluate(async (m) => {
      const out = { ls: localStorage.getItem('scirepl_packaged_marker') === m };
      try {
        const vfs = window.sharedVFS;
        if (typeof vfs.loadFromIndexedDB === 'function') await vfs.loadFromIndexedDB();
        out.vfs = vfs.readFile('/shared/packaged.txt') === m;
      } catch (e) {
        out.vfs = false;
        out.error = String(e && e.message);
      }
      return out;
    }, marker);

    r.log('SharedVFS state survives a packaged-app restart',
      restored.vfs === true, restored.error || '');
    r.log('notebook/localStorage state survives a packaged-app restart',
      restored.ls === true);
  } finally {
    await shell.close();
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0));
}
