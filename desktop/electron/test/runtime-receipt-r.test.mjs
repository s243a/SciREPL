/**
 * runtime-receipt-r.test.mjs — the R upgrade path from MSIX pilot run 4.
 *
 * Pilot run 4 builds left a populated userData/runtime-cache/ with no
 * journal.log and no renderer receipt. This suite rebuilds that layout for R
 * (download webR through the shell cache, then delete journal.log and the
 * receipt) and checks, with the network cut throughout:
 *
 *   1. intact old cache: the first start shows the prompt once (no receipt);
 *      Download loads R from disk; the next start skips the prompt and runs;
 *   2. a startup support file (R.wasm, the webR binary) deleted while a receipt exists:
 *      the prompt comes back on the next start;
 *   3. the same file missing in an old-format cache (no journal, no receipt):
 *      the prompt shows.
 *
 * In 2 and 3 no webR request may reach the network handler before the user
 * confirms. SCIREPL_RUNTIME_CACHE_DEBUG=1 makes the shell log every https
 * request it sees (runtime-cache.js), so "nothing logged for webR before the
 * click" is checked directly, not inferred from the modal.
 *
 * Optional webR files that R has not tried to load yet are not covered: the
 * cache has never stored them, so nothing can be known about them (the
 * documented gap in kernel_manager.js).
 *
 * ~50 MB download, needs network for the first launch; opt-in:
 *
 *   node desktop/electron/test/run-all.mjs runtime-receipt-r
 */

import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchShell, createReporter, waitForAppReady } from './harness.mjs';

const PREFIX = 'scirepl_electron_runtime_receipt:';
const R = { lang: 'r', code: 'cat(6*7)' };
const ENV = { SCIREPL_RUNTIME_CACHE_DEBUG: '1' };
const WEBR = /webr\.r-wasm\.org|\/webr@/;

function makeProfile() {
  const base = process.env.SCIREPL_TEST_TMP || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'scirepl-receipt-r-'));
}

async function goOffline(shell) {
  await shell.electronApp.evaluate(async ({ session }) => {
    await session.defaultSession.setProxy({ proxyRules: 'http=127.0.0.1:1;https=127.0.0.1:1' });
    await session.defaultSession.closeAllConnections();
  });
}

async function runKernel(page, { lang, code }, timeoutMs = 240_000) {
  return page.evaluate(async ({ lang, code, timeoutMs }) => {
    try {
      await Promise.race([
        window.kernelManager.ensureReady(lang),
        new Promise((_, rj) => setTimeout(() => rj(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
      const r = await window.kernelManager.execute(code, lang);
      return { ok: !r.error, out: ((r.stdout || '') + (r.result?.content || '')).trim(), error: r.error || null };
    } catch (e) {
      return { ok: false, error: String(e && e.message).slice(0, 200) };
    }
  }, { lang, code, timeoutMs });
}

const receiptKeys = (page) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)), PREFIX);
const removeReceipts = (page) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k)), PREFIX);
const cachedCheck = (page) => page.evaluate(() => window.kernelManager._hasCompleteCachedRuntime('r'));
const disableAutoDownload = (page) => page.evaluate(() => localStorage.removeItem('scirepl_auto_download'));
const promptVisible = (page) => page.evaluate(() => {
  const modal = document.getElementById('runtime-download-modal');
  const actions = document.getElementById('runtime-download-actions');
  return !!modal && !modal.classList.contains('hidden')
    && !!actions && !actions.classList.contains('hidden');
});

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((res) => setTimeout(res, stepMs));
  }
  return last;
}

async function promptShown(page) {
  page.evaluate(() => window.kernelManager.ensureReady('r').catch(() => {})).catch(() => {});
  return (await waitFor(() => promptVisible(page), 20_000)) === true;
}

/** webR requests the shell's https handler has seen in this profile so far. */
function webrRequestsLogged(userDataDir) {
  const log = path.join(userDataDir, 'runtime-cache-debug.log');
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').split('\n').filter((l) => WEBR.test(l)).length;
}
const clearDebugLog = (userDataDir) => rmSync(path.join(userDataDir, 'runtime-cache-debug.log'), { force: true });

function journalUrls(userDataDir) {
  const p = path.join(userDataDir, 'runtime-cache', 'journal.log');
  if (!existsSync(p)) return [];
  return [...new Set(readFileSync(p, 'utf8').split('\n').filter(Boolean))];
}

function deleteCachedBody(userDataDir, pattern) {
  const dir = path.join(userDataDir, 'runtime-cache');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue;
    const meta = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    if (meta.method === 'GET' && pattern.test(meta.url)) {
      unlinkSync(path.join(dir, f.slice(0, -'.meta.json'.length)));
      return meta.url;
    }
  }
  return null;
}

export default async function run() {
  const r = createReporter('runtime-receipt-r');
  const userDataDir = makeProfile();
  const journalPath = path.join(userDataDir, 'runtime-cache', 'journal.log');
  try {
    // Build the old-format profile: download R, then drop journal + receipt.
    let shell = await launchShell({ userDataDir, env: ENV });
    try {
      await waitForAppReady(shell.page);
      const online = await runKernel(shell.page, R);
      r.log('R downloads and runs online (populating the cache)', online.ok && /42/.test(online.out || ''),
        online.error || online.out);
      await removeReceipts(shell.page);
    } finally {
      await shell.close();
    }
    const journaled = journalUrls(userDataDir);
    console.log(`  journaled webR entries:\n    ${journaled.join('\n    ')}`);
    rmSync(journalPath, { force: true });
    r.log('old layout built (entries, no journal.log, no receipt)', !existsSync(journalPath)
      && journaled.length > 0, `${journaled.length} entries had been journaled`);

    // 1. intact old cache, offline
    clearDebugLog(userDataDir);
    shell = await launchShell({ userDataDir, env: ENV });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      r.log('intact old cache: the prompt shows once (no receipt yet)', await promptShown(shell.page));
      r.log('intact old cache: no webR request before the user confirms',
        webrRequestsLogged(userDataDir) === 0, `${webrRequestsLogged(userDataDir)} logged`);
      await shell.page.click('#runtime-download-btn');
      const fromDisk = await runKernel(shell.page, R, 120_000);
      r.log('intact old cache: after Download, R loads OFFLINE from disk',
        fromDisk.ok && /42/.test(fromDisk.out || ''), fromDisk.error || fromDisk.out);
      r.log('intact old cache: the receipt is written', (await receiptKeys(shell.page)).length === 1);
    } finally {
      await shell.close();
    }
    const rejournaled = journalUrls(userDataDir);
    r.log('the cache hits journaled the inherited entries',
      rejournaled.some((l) => /webr\.mjs$/.test(l)) && rejournaled.length >= journaled.length - 1,
      `${rejournaled.length} lines`);

    shell = await launchShell({ userDataDir, env: ENV });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      r.log('next offline start: R reported cached', (await cachedCheck(shell.page)) === true);
      const outcome = await Promise.race([
        shell.page.evaluate(() => window.kernelManager.ensureReady('r').then(() => 'ready', (e) => `rejected: ${e && e.message}`)),
        waitFor(() => promptVisible(shell.page), 120_000).then((shown) => (shown ? 'prompted' : 'timeout')),
      ]);
      r.log('next offline start: no prompt, R becomes ready', outcome === 'ready', outcome);
      const again = await runKernel(shell.page, R, 60_000);
      r.log('next offline start: R runs', again.ok && /42/.test(again.out || ''), again.error || again.out);
    } finally {
      await shell.close();
    }

    // 2. a startup support file deleted while a receipt exists
    const removed = deleteCachedBody(userDataDir, /\/R\.wasm$/);
    r.log('deleted the startup support file R.wasm from the cache', !!removed, removed || 'not found');
    clearDebugLog(userDataDir);
    shell = await launchShell({ userDataDir, env: ENV });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      const dist = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('startup snapshot: R.wasm missing, loader present',
        dist.runtimeCacheMissing.includes(removed)
          && dist.runtimeCachePresent.some((u) => /webr\.mjs$/.test(u)),
        JSON.stringify(dist.runtimeCacheMissing));
      r.log('with a receipt and R.wasm missing: not reported cached',
        (await receiptKeys(shell.page)).length === 1 && (await cachedCheck(shell.page)) === false);
      r.log('with a receipt and R.wasm missing: the prompt comes back', await promptShown(shell.page));
      r.log('with a receipt and R.wasm missing: no webR request before the user confirms',
        webrRequestsLogged(userDataDir) === 0, `${webrRequestsLogged(userDataDir)} logged`);
    } finally {
      await shell.close();
    }

    // 3. old-format cache with the same file missing: no journal, no receipt
    rmSync(journalPath, { force: true });
    clearDebugLog(userDataDir);
    shell = await launchShell({ userDataDir, env: ENV });
    try {
      await waitForAppReady(shell.page);
      await removeReceipts(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      r.log('old cache, R.wasm missing: the prompt shows', await promptShown(shell.page));
      r.log('old cache, R.wasm missing: no webR request before the user confirms',
        webrRequestsLogged(userDataDir) === 0, `${webrRequestsLogged(userDataDir)} logged`);
    } finally {
      await shell.close();
    }
  } finally {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0));
}
