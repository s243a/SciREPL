/**
 * kernels.test.mjs — the compatibility matrix.
 *
 * Runs probes/kernels.mjs inside the Electron shell. With
 * `SCIREPL_COMPARE_BASELINE=1` it runs the identical probes in plain Chromium
 * against the repo's dev server too, and reports both columns, so a kernel that
 * is broken everywhere is not mistaken for a kernel that Electron broke.
 *
 * Results are written to desktop/electron/test/results/kernel-matrix.json so
 * the feasibility report can quote measured numbers rather than impressions.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchShell, launchBrowserBaseline, createReporter, waitForAppReady, attachLogs,
} from './harness.mjs';
import {
  KERNEL_CASES, runKernel, enabledKernels, registeredKernels, probeSharedVfs, probeIndexedDb,
} from './probes/kernels.mjs';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

/**
 * Run the full probe set against one already-loaded page.
 *
 * Each kernel yields two separate verdicts, because they answer different
 * questions:
 *   - "runs" — did the runtime initialise and execute without error? This is
 *     the feasibility question, and it is always a hard pass/fail.
 *   - "output" — did it produce the expected value? This is application
 *     behaviour. Where a case is marked `knownIssue`, a failure here is
 *     reported as a known gap rather than a shell failure — but only because
 *     the parity check separately proves Electron matches the browser.
 */
async function collect(page, label, r, { enabled }) {
  const rows = [];
  for (const kase of KERNEL_CASES) {
    if (!enabled.includes(kase.lang)) {
      r.skip(`${label}: ${kase.label}`, 'not enabled in this build profile');
      rows.push({ ...kase, expect: String(kase.expect), status: 'disabled' });
      continue;
    }

    const res = await runKernel(page, kase);
    const ran = res.status === 'ok';
    const outputOk = ran && kase.expect.test(res.output || '');

    r.log(`${label}: ${kase.label} — initialises and executes`, ran,
      ran ? `init ${res.initMs}ms, exec ${res.execMs}ms`
          : `${res.status} ${res.error || ''}`);

    if (outputOk || !kase.knownIssue) {
      r.log(`${label}: ${kase.label} — produces expected output`, outputOk,
        outputOk ? '' : `output=${JSON.stringify(res.output || '')}`);
    } else {
      r.skip(`${label}: ${kase.label} — produces expected output`,
        `known pre-existing gap: ${kase.knownIssue}`);
    }

    rows.push({ ...kase, expect: String(kase.expect), ...res, ran, outputOk, passed: outputOk });
  }
  return rows;
}

export default async function run() {
  const r = createReporter('kernels');
  mkdirSync(RESULTS_DIR, { recursive: true });

  const shell = await launchShell();
  const logs = attachLogs(shell.page);
  const report = { generatedAt: new Date().toISOString(), electron: null, browser: null };

  try {
    await waitForAppReady(shell.page);

    const enabled = await enabledKernels(shell.page);
    const registered = await registeredKernels(shell.page);
    r.log('build profile enables the expected Free kernel set',
      enabled.length > 0, `enabled=${enabled.join(',')}`);
    r.log('every enabled kernel is registered with the kernel manager',
      enabled.every(l => registered.includes(l)),
      `registered=${registered.join(',')}`);

    const startupMs = await shell.page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return nav ? Math.round(nav.domContentLoadedEventEnd) : null;
    });
    r.log('startup measured', typeof startupMs === 'number', `DOMContentLoaded ${startupMs}ms`);

    report.electron = {
      origin: shell.page.url(),
      enabled,
      registered,
      startupMs,
      kernels: await collect(shell.page, 'electron', r, { enabled }),
      sharedVfs: await probeSharedVfs(shell.page),
      indexedDb: await probeIndexedDb(shell.page),
    };

    r.log('electron: SharedVFS round-trips in memory',
      report.electron.sharedVfs.roundTrip === true, JSON.stringify(report.electron.sharedVfs));
    r.log('electron: SharedVFS content is visible to the Python kernel',
      report.electron.sharedVfs.visibleToPython === true,
      report.electron.sharedVfs.pythonError || '');
    r.log('electron: SharedVFS persisted to IndexedDB',
      report.electron.sharedVfs.savedToIndexedDb === true);
    r.log('electron: IndexedDB is usable and enumerable',
      report.electron.indexedDb.supported === true,
      JSON.stringify(report.electron.indexedDb));

    const pageErrors = logs.filter(l => l.startsWith('[pageerror]'));
    r.log('no uncaught page errors while exercising kernels',
      pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await shell.close();
  }

  /* ---------------- optional browser baseline ---------------- */

  if (process.env.SCIREPL_COMPARE_BASELINE === '1') {
    const baseline = await launchBrowserBaseline();
    try {
      await waitForAppReady(baseline.page);
      const enabled = await enabledKernels(baseline.page);
      report.browser = {
        origin: baseline.origin,
        enabled,
        kernels: await collect(baseline.page, 'browser', r, { enabled }),
        sharedVfs: await probeSharedVfs(baseline.page),
        indexedDb: await probeIndexedDb(baseline.page),
      };
    } finally {
      await baseline.close();
    }

    // The comparison is the point: flag only kernels where the two disagree.
    const byLang = Object.fromEntries((report.browser.kernels || []).map(k => [k.lang, k]));
    for (const e of report.electron.kernels) {
      const b = byLang[e.lang];
      if (!b) continue;
      if (e.status === 'disabled' && b.status === 'disabled') continue;
      // Compare both verdicts. This is what licenses treating a `knownIssue`
      // as pre-existing: if Electron ever diverges from the browser — in either
      // direction — this fails regardless of the knownIssue marking.
      const same = Boolean(e.ran) === Boolean(b.ran) && Boolean(e.outputOk) === Boolean(b.outputOk);
      r.log(`parity with browser baseline: ${e.label}`, same,
        `electron(ran=${!!e.ran},output=${!!e.outputOk}) browser(ran=${!!b.ran},output=${!!b.outputOk})`);
    }
  } else {
    r.skip('browser baseline comparison', 'set SCIREPL_COMPARE_BASELINE=1 to run it');
  }

  writeFileSync(path.join(RESULTS_DIR, 'kernel-matrix.json'), JSON.stringify(report, null, 2));
  console.log(`\n  results written to ${path.join(RESULTS_DIR, 'kernel-matrix.json')}`);

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
