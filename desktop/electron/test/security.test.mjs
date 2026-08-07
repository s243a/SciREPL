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
import { assertBoundary, runNotebookCell } from './probes/security.mjs';

export default async function run() {
  const r = createReporter('security');
  const shell = await launchShell();
  const attachedLogs = attachLogs(shell.page);

  try {
    const { page } = shell;
    await waitForAppReady(page);

    // Record whether the OS sandbox was actually on, so a relaxed CI run can
    // never be mistaken for a clean one in the report.
    const sandboxRelaxed = process.env.SCIREPL_ELECTRON_NO_SANDBOX === '1';
    r.log('renderer ran with the OS sandbox enabled', !sandboxRelaxed,
      sandboxRelaxed ? 'SCIREPL_ELECTRON_NO_SANDBOX=1 — result does not attest to OS sandboxing' : '');

    /* ------------- the shared renderer/native boundary probes -------------- */
    //
    // These live in probes/security.mjs and are run identically against the
    // packaged build by packaged.test.mjs. One definition of the boundary, so a
    // packaged app cannot regain Node access while a drifting copy of the
    // assertions keeps passing here.
    await assertBoundary(r, page, shell.electronApp);

    // Development-shell specifics, not part of the shared boundary.
    const dist = await page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
    r.log('getDistributionInfo reports the Free edition',
      dist && dist.edition === 'free' && dist.container === 'electron', JSON.stringify(dist));
    r.log('an unpackaged run reports itself as unpackaged',
      dist && dist.packaged === false, String(dist && dist.packaged));

    /* ------- in-app navigation must still be PERMITTED (regression) ------- */
    //
    // assertBoundary already proved off-origin navigation and window.open are
    // refused. The mirror image needs its own guard: the will-navigate policy
    // classifies URLs in the main process, where Node reports
    // `origin === 'null'` for the custom scheme, and an origin-based check
    // silently blocked the app from navigating within itself.

    await page.evaluate(() => { window.location.href = 'privacy.html'; });
    await page.waitForURL(/privacy\.html$/, { timeout: 30_000 }).catch(() => {});
    r.log('in-app navigation is permitted', /privacy\.html$/.test(page.url()), page.url());

    await page.goto('app://scirepl/index.html', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForAppReady(page);
    r.log('can navigate back to the application root', /index\.html$/.test(page.url()), page.url());

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
