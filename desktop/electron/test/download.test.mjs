/**
 * download.test.mjs — the export/import plumbing under the packaged origin.
 *
 * Scope note: this does NOT re-test export *correctness*. The repository's
 * existing browser tests (test_export.mjs, test_docx_math.mjs,
 * test_latex_ipynb.mjs, test-export-workbook.mjs, …) already cover which bytes
 * each format produces, and that logic is platform-independent — it runs in the
 * same JavaScript on Android, the PWA and here.
 *
 * What Electron actually changes is the *delivery* step. In the browser,
 * `FileIO._downloadBlob` creates a blob URL and clicks `<a download>`; the
 * browser then writes the file. Inside a shell there is no browser download UI
 * unless the main process participates, and blob URLs must be creatable from
 * the custom origin at all. Those two things are what this file tests.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchShell, createReporter, waitForAppReady } from './harness.mjs';

export default async function run() {
  const r = createReporter('download');
  const downloadDir = mkdtempSync(path.join(tmpdir(), 'scirepl-dl-'));
  const shell = await launchShell();

  try {
    const { page, electronApp } = shell;
    await waitForAppReady(page);

    /* --- blob URLs must work from the app:// origin --- */

    const blobOk = await page.evaluate(async () => {
      try {
        const blob = new Blob(['hello-from-the-spike'], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const roundTrip = await (await fetch(url)).text();
        URL.revokeObjectURL(url);
        return { ok: roundTrip === 'hello-from-the-spike', scheme: url.split(':')[0] };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    });
    r.log('blob URLs are creatable and readable under app://',
      blobOk.ok === true, JSON.stringify(blobOk));

    /* --- an <a download> click must reach the main process --- */

    // Auto-accept downloads into a scratch directory so the assertion does not
    // depend on a native Save dialog. This mirrors what a real shell must do:
    // with no will-download participant, Electron shows a modal Save dialog —
    // which, in a headless test, blocks the main process message loop and wedges
    // every later electronApp.evaluate() call.
    //
    // The handler therefore must not throw. Note `require` is NOT in scope
    // inside electronApp.evaluate, so the path is joined with plain string
    // concatenation (forward slashes are valid on Windows too), and the whole
    // body is wrapped so that any error still results in a save path being set.
    await electronApp.evaluate(async ({ session }, dir) => {
      globalThis.__spikeDownloads = [];
      const base = String(dir).replace(/[\\/]+$/, '');
      // Use the separator the directory itself is written with, so a Windows
      // temp path (C:\Users\...\Temp\x) does not end up with a mixed-separator
      // save path. `require('path')` is not in scope inside this evaluate.
      const sep = base.includes('\\') ? '\\' : '/';
      session.defaultSession.on('will-download', (_event, item) => {
        let target = `${base}${sep}download.bin`;
        try {
          target = `${base}${sep}${item.getFilename()}`;
        } catch { /* keep the fallback */ }
        // Always set a path, even on error, so no modal dialog can appear.
        item.setSavePath(target);
        item.once('done', (_e, state) => {
          try {
            globalThis.__spikeDownloads.push({
              filename: item.getFilename(),
              state,
              path: target,
              bytes: item.getReceivedBytes(),
            });
          } catch { /* ignore */ }
        });
      });
    }, downloadDir);

    // Drive the application's own download helper rather than a hand-rolled
    // anchor, so the test exercises the code path exports actually use.
    const triggered = await page.evaluate(async () => {
      const io = window.fileIO;
      if (!io || typeof io._downloadBlob !== 'function') return { available: false };
      const blob = new Blob(['# spike\n\nexported from the Electron shell\n'], { type: 'text/markdown' });
      await io._downloadBlob(blob, 'spike-export.md');
      return { available: true };
    });
    r.log('FileIO._downloadBlob is the shared browser path (no Capacitor here)',
      triggered.available === true, JSON.stringify(triggered));

    // Give the download a moment to complete. Each probe of the main process is
    // bounded: if a modal dialog ever does appear, the main process stops
    // servicing evaluate() and this must fail the test rather than hang it.
    const deadline = Date.now() + 20_000;
    let recorded = [];
    let mainProcessBlocked = false;
    while (Date.now() < deadline) {
      try {
        recorded = await Promise.race([
          electronApp.evaluate(() => globalThis.__spikeDownloads || []),
          new Promise((_, rej) => setTimeout(() => rej(new Error('main process did not respond')), 5_000)),
        ]);
      } catch {
        mainProcessBlocked = true;
        break;
      }
      if (recorded.length > 0) break;
      await page.waitForTimeout(250);
    }
    r.log('main process stayed responsive during the download (no modal dialog)',
      mainProcessBlocked === false,
      mainProcessBlocked ? 'evaluate() stopped responding — a native dialog is probably blocking' : '');

    const done = recorded.find(d => d.filename === 'spike-export.md');
    r.log('an application download reaches the main process',
      Boolean(done), JSON.stringify(recorded));
    r.log('the download completes successfully',
      done && done.state === 'completed', done && done.state);

    if (done && existsSync(done.path)) {
      const content = readFileSync(done.path, 'utf8');
      r.log('downloaded bytes are intact on disk',
        content.includes('exported from the Electron shell'), `${content.length} bytes`);
    } else {
      r.log('downloaded bytes are intact on disk', false, 'file not written');
    }

    /* --- import: the file input path the app uses --- */

    const importOk = await page.evaluate(async () => {
      // DataTransfer + File is how a chosen file arrives; verify the renderer
      // can construct and read one under this origin (FileReader + File API).
      try {
        const file = new File([JSON.stringify({ cells: [], metadata: {} })],
          'spike.ipynb', { type: 'application/json' });
        const text = await file.text();
        return { ok: JSON.parse(text) && file.name === 'spike.ipynb', size: file.size };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    });
    r.log('File/FileReader import primitives work under app://',
      importOk.ok === true, JSON.stringify(importOk));

    /* --- window.print must not crash the shell (PDF export fallback) --- */

    const printSafe = await page.evaluate(() => {
      // Electron's print in a sandboxed renderer is async and must not throw
      // synchronously; we only assert it is callable and the page survives.
      return typeof window.print === 'function';
    });
    r.log('window.print is available for the PDF export fallback', printSafe === true);
    r.log('renderer is still responsive after the download',
      (await page.evaluate(() => 1 + 1)) === 2);
  } finally {
    await shell.close();
    try { rmSync(downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
