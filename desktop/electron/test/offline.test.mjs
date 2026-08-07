/**
 * offline.test.mjs — does the shell still work with no network?
 *
 * This matters more for a packaged desktop application than for the PWA: a
 * Store user may launch it offline on day one. The Free `full` profile bundles
 * Bash, ClojureScript, SWI-Prolog and Python locally and leaves Lua and R on a
 * CDN, so the expected offline result is *partial*: the bundled kernels must
 * work with no network at all, and the CDN kernels must fail cleanly rather
 * than hang or corrupt the application.
 *
 * Network is cut at the session level in the main process, which is a truer
 * simulation than toggling `navigator.onLine` in the renderer.
 */

import { launchShell, createReporter, waitForAppReady } from './harness.mjs';
import { KERNEL_CASES, runKernel } from './probes/kernels.mjs';

export default async function run() {
  const r = createReporter('offline');
  const shell = await launchShell();

  try {
    const { page, electronApp } = shell;
    await waitForAppReady(page);

    // Cut the network by pointing http/https at a dead proxy.
    //
    // An earlier revision used `webRequest.onBeforeRequest` and cancelled
    // everything that was not `app://`. That broke the application itself:
    // installing a webRequest handler routes custom-protocol requests through
    // the network delegate too, and even returning `{cancel: false}` for
    // `app://` URLs made them fail with net::ERR_UNEXPECTED, so the page could
    // no longer reload. A proxy only affects http/https, leaving the custom
    // scheme served entirely by protocol.handle() — which is both a truer
    // simulation of "no network" and harmless to the app origin.
    const blocked = await electronApp.evaluate(async ({ session }) => {
      await session.defaultSession.setProxy({ proxyRules: 'http=127.0.0.1:1;https=127.0.0.1:1' });
      await session.defaultSession.closeAllConnections();
      return true;
    });
    r.log('network cut for the offline run (http/https proxied to a dead port)', blocked === true);

    // Sanity: a remote request really is refused now.
    const remote = await page.evaluate(async () => {
      try {
        await fetch('https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js', { cache: 'no-store' });
        return 'reachable';
      } catch {
        return 'blocked';
      }
    });
    r.log('remote origins are unreachable during the offline run', remote === 'blocked', remote);

    // The application itself must still load and reload from local assets.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForAppReady(page);
    r.log('application still starts and reloads with no network', true);

    const localAsset = await page.evaluate(async () => {
      const res = await fetch('js/kernel_config.js');
      return res.ok;
    });
    r.log('local app:// assets still load with no network', localAsset === true);

    // Bundled kernels must work offline.
    const offlineCapable = KERNEL_CASES.filter(k => !k.network);
    for (const kase of offlineCapable) {
      const res = await runKernel(page, kase, 120_000);
      const ran = res.status === 'ok';
      r.log(`offline: ${kase.label} still runs`, ran,
        ran ? `init ${res.initMs}ms` : `${res.status} ${res.error || ''}`);
      if (ran && !kase.knownIssue) {
        r.log(`offline: ${kase.label} still produces expected output`,
          kase.expect.test(res.output || ''), JSON.stringify(res.output || ''));
      }
    }

    // CDN-backed kernels must fail cleanly, not hang or wedge the app.
    const cdnCase = KERNEL_CASES.find(k => k.lang === 'lua');
    const cdnRes = await runKernel(page, cdnCase, 60_000);
    r.log('offline: a CDN-only kernel fails rather than succeeding silently',
      cdnRes.status !== 'ok', `${cdnRes.status} ${cdnRes.error || ''}`.slice(0, 200));

    // And the application must survive that failure.
    const alive = await page.evaluate(() => ({
      responsive: 1 + 1 === 2,
      kernelManager: !!window.kernelManager,
      vfs: !!window.sharedVFS,
    }));
    r.log('application remains responsive after an offline kernel failure',
      alive.responsive && alive.kernelManager && alive.vfs, JSON.stringify(alive));

    // A bundled kernel must still work after the failed one.
    const afterFailure = await runKernel(page, KERNEL_CASES.find(k => k.lang === 'bash'), 120_000);
    r.log('a bundled kernel still runs after a CDN kernel failed offline',
      afterFailure.status === 'ok', `${afterFailure.status} ${afterFailure.error || ''}`);
  } finally {
    await shell.close();
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
