/**
 * runtime-receipt.test.mjs — a runtime downloaded once must not prompt again.
 *
 * MSIX pilot run 4: R (and Lua) were downloaded online, the app restarted, and
 * the download confirmation came back, even offline, although the runtime was
 * on disk in userData/runtime-cache/ and loaded from there in about a second
 * once Download was clicked. The pre-prompt check (`_hasCompleteCachedRuntime`)
 * looked for a receipt in the Cache API, which is always empty under app://.
 *
 * The renderer now keeps an Electron-only receipt in localStorage, written
 * only when the shell reports its runtime cache active (getDistributionInfo
 * `runtimeCache`). This suite checks the whole loop with Lua (~200 kB, rather
 * than R's ~50 MB; the receipt logic is language-independent):
 *
 *   1. online: Lua downloads and runs, and a receipt is written;
 *   2. restart, offline, auto-download off: no prompt, Lua loads from disk;
 *   3. a runtime file deleted from userData/runtime-cache by hand brings the
 *      prompt back at the next start (the receipt alone is not enough), and
 *      after downloading again the prompt stays away;
 *   4. Runtimes → Clear downloaded runtimes… removes the receipts, and after a
 *      restart the prompt is back;
 *   5. upgrading from a cache written before journal.log existed: one prompt,
 *      Download served offline from disk, then no prompt; a damaged old cache
 *      still prompts;
 *   6. a journal that cannot be written: Lua still downloads and runs, but no
 *      receipt is written, so the next start prompts again;
 *   7. with SCIREPL_RUNTIME_CACHE=0 no receipt is written.
 *
 * Needs network for the online half, so it is opt-in:
 *
 *   node desktop/electron/test/run-all.mjs runtime-receipt
 */

import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchShell, createReporter, waitForAppReady } from './harness.mjs';

const PREFIX = 'scirepl_electron_runtime_receipt:';
const LUA = { lang: 'lua', code: 'print(6*7)' };

/** Profiles go under SCIREPL_TEST_TMP when set (the default tmpdir otherwise). */
function makeProfile(tag) {
  const base = process.env.SCIREPL_TEST_TMP || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, `scirepl-receipt-${tag}-`));
}

/** Cut the network at the session level, leaving app:// untouched. */
async function goOffline(shell) {
  await shell.electronApp.evaluate(async ({ session }) => {
    await session.defaultSession.setProxy({ proxyRules: 'http=127.0.0.1:1;https=127.0.0.1:1' });
    await session.defaultSession.closeAllConnections();
  });
}

async function runKernel(page, { lang, code }, timeoutMs = 90_000) {
  return page.evaluate(async ({ lang, code, timeoutMs }) => {
    try {
      await Promise.race([
        window.kernelManager.ensureReady(lang),
        new Promise((_, rj) => setTimeout(() => rj(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
      const r = await window.kernelManager.execute(code, lang);
      return { ok: !r.error, out: ((r.stdout || '') + (r.result?.content || '')).trim(), error: r.error || null };
    } catch (e) {
      return { ok: false, error: String(e && e.message).slice(0, 160) };
    }
  }, { lang, code, timeoutMs });
}

const receiptKeys = (page) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)), PREFIX);

const cachedCheck = (page, lang) => page.evaluate((l) => window.kernelManager._hasCompleteCachedRuntime(l), lang);

/** Turn the prompt back on: the harness primes auto-download for kernel suites. */
const disableAutoDownload = (page) => page.evaluate(() => localStorage.removeItem('scirepl_auto_download'));

/** Whether the confirmation (with its Download/Cancel actions) is on screen. */
const promptVisible = (page) => page.evaluate(() => {
  const modal = document.getElementById('runtime-download-modal');
  const actions = document.getElementById('runtime-download-actions');
  return !!modal && !modal.classList.contains('hidden')
    && !!actions && !actions.classList.contains('hidden');
});

function cacheEntries(userDataDir) {
  const dir = path.join(userDataDir, 'runtime-cache');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => !f.endsWith('.meta.json') && !f.endsWith('.partial')
    && f !== 'journal.log').length;
}

/** Delete a cached body by hand, as a user poking at userData would. */
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

/** Start the kernel without awaiting it and report whether the prompt shows. */
async function promptShownFor(page, lang, timeoutMs = 15_000) {
  page.evaluate((l) => window.kernelManager.ensureReady(l).catch(() => {}), lang).catch(() => {});
  return (await waitFor(() => promptVisible(page), timeoutMs)) === true;
}

/** Drive the real native menu item, auto-confirming its dialogs. */
async function clickClearDownloadedRuntimes(shell) {
  return shell.electronApp.evaluate(async ({ Menu, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    const find = (menu) => {
      for (const item of (menu && menu.items) || []) {
        if (/Clear downloaded runtimes/.test(item.label || '')) return item;
        const sub = find(item.submenu);
        if (sub) return sub;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu());
    if (!item) return false;
    item.click();
    return true;
  });
}

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

export default async function run() {
  const r = createReporter('runtime-receipt');

  /* ---------------- cache on: download, restart offline, clear ---------------- */
  const userDataDir = makeProfile('on');
  try {
    // 1. online
    let shell = await launchShell({ userDataDir });
    try {
      await waitForAppReady(shell.page);
      const dist = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('getDistributionInfo reports the runtime cache active',
        dist.runtimeCache === true && dist.runtimeCacheHosts.includes('cdn.jsdelivr.net'),
        JSON.stringify({ runtimeCache: dist.runtimeCache, hosts: dist.runtimeCacheHosts }));
      r.log('fresh profile: Lua is not reported cached', (await cachedCheck(shell.page, 'lua')) === false);
      const online = await runKernel(shell.page, LUA);
      r.log('Lua downloads and runs online', online.ok && /42/.test(online.out || ''),
        online.error || online.out);
      const keys = await receiptKeys(shell.page);
      r.log('a receipt for Lua at its expected version is written',
        keys.length === 1 && keys[0].startsWith(`${PREFIX}lua:`), JSON.stringify(keys));
    } finally {
      await shell.close();
    }
    r.log('Lua bytes are in userData/runtime-cache', cacheEntries(userDataDir) > 0,
      `${cacheEntries(userDataDir)} entries`);

    // 2. restart, offline, prompt enabled
    shell = await launchShell({ userDataDir });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      r.log('after restart offline, _hasCompleteCachedRuntime(lua) is true',
        (await cachedCheck(shell.page, 'lua')) === true);

      const started = shell.page.evaluate(() => window.kernelManager.ensureReady('lua')
        .then(() => 'ready', (e) => `rejected: ${e && e.message}`));
      let promptSeen = false;
      const outcome = await Promise.race([
        started,
        (async () => {
          const end = Date.now() + 30_000;
          while (Date.now() < end) {
            if (await promptVisible(shell.page)) { promptSeen = true; return 'prompted'; }
            await new Promise((res) => setTimeout(res, 200));
          }
          return 'timeout';
        })(),
      ]);
      r.log('no download confirmation is shown; Lua becomes ready without a click',
        outcome === 'ready' && !promptSeen, outcome);
      const offline = await runKernel(shell.page, LUA, 30_000);
      r.log('Lua runs offline from the on-disk cache', offline.ok && /42/.test(offline.out || ''),
        offline.error || offline.out);
    } finally {
      await shell.close();
    }

    // 3. a file deleted by hand: the receipt alone must not skip the prompt
    const deleted = deleteCachedBody(userDataDir, /fengari-web/);
    r.log('deleted the cached Lua body by hand', !!deleted, deleted || 'not found');
    shell = await launchShell({ userDataDir });
    try {
      await waitForAppReady(shell.page);
      await disableAutoDownload(shell.page);
      const dist = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('startup snapshot reports the deleted file missing and not present',
        dist.runtimeCacheMissing.includes(deleted) && !dist.runtimeCachePresent.includes(deleted),
        JSON.stringify({ missing: dist.runtimeCacheMissing, present: dist.runtimeCachePresent.length }));
      r.log('receipt still there, but _hasCompleteCachedRuntime(lua) is false',
        (await receiptKeys(shell.page)).length === 1 && (await cachedCheck(shell.page, 'lua')) === false);
      r.log('a missing runtime file brings the download confirmation back',
        await promptShownFor(shell.page, 'lua'));
      await shell.page.click('#runtime-download-btn');
      const again = await runKernel(shell.page, LUA);
      r.log('choosing Download fetches it again and runs', again.ok && /42/.test(again.out || ''),
        again.error || again.out);
    } finally {
      await shell.close();
    }

    shell = await launchShell({ userDataDir });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      r.log('after downloading again, the next offline start skips the prompt',
        (await cachedCheck(shell.page, 'lua')) === true);

      // 4. clear through the real menu
      const clicked = await clickClearDownloadedRuntimes(shell);
      r.log('Runtimes → Clear downloaded runtimes… menu item found and clicked', clicked === true);
      const gone = await waitFor(async () => (await receiptKeys(shell.page)).length === 0, 15_000);
      r.log('clearing removes the renderer receipts', gone === true,
        JSON.stringify(await receiptKeys(shell.page)));
    } finally {
      await shell.close();
    }
    r.log('clearing removes the on-disk runtime files', cacheEntries(userDataDir) === 0,
      `${cacheEntries(userDataDir)} entries`);

    shell = await launchShell({ userDataDir });
    try {
      await waitForAppReady(shell.page);
      await disableAutoDownload(shell.page);
      r.log('after clearing and restarting, Lua is not reported cached',
        (await cachedCheck(shell.page, 'lua')) === false);
      r.log('the download confirmation returns after clearing', await promptShownFor(shell.page, 'lua'));
    } finally {
      await shell.close();
    }
  } finally {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ---------------- upgrade: a cache written before journal.log existed ---------------- */
  //
  // Pilot run 4 builds populated runtime-cache/ with no journal and wrote no
  // receipt. Expected on the new build: the prompt shows once (no receipt);
  // Download is served from disk, offline; that writes the receipt and
  // journals the hit, so the next start skips the prompt. If the old cache is
  // damaged (the loader body gone), the prompt keeps coming back.
  const upDir = makeProfile('upgrade');
  try {
    let shell = await launchShell({ userDataDir: upDir });
    try {
      await waitForAppReady(shell.page);
      const online = await runKernel(shell.page, LUA);
      r.log('upgrade: populate the cache online', online.ok, online.error || online.out);
      await shell.page.evaluate((prefix) => Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k)), PREFIX);
    } finally {
      await shell.close();
    }
    const journalPath = path.join(upDir, 'runtime-cache', 'journal.log');
    rmSync(journalPath, { force: true });
    r.log('upgrade: old layout built (entries, no journal.log, no receipt)',
      cacheEntries(upDir) > 0 && !existsSync(journalPath));

    shell = await launchShell({ userDataDir: upDir });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      const dist = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('upgrade: the un-journaled intact entry counts as present, nothing missing',
        dist.runtimeCachePresent.some((u) => /fengari-web/.test(u)) && dist.runtimeCacheMissing.length === 0,
        JSON.stringify({ present: dist.runtimeCachePresent, missing: dist.runtimeCacheMissing }));
      r.log('upgrade: no receipt yet, so the prompt shows once', await promptShownFor(shell.page, 'lua'));
      await shell.page.click('#runtime-download-btn');
      const fromDisk = await runKernel(shell.page, LUA, 30_000);
      r.log('upgrade: Download works offline, served from the old cache',
        fromDisk.ok && /42/.test(fromDisk.out || ''), fromDisk.error || fromDisk.out);
      r.log('upgrade: the receipt is written', (await receiptKeys(shell.page)).length === 1);
    } finally {
      await shell.close();
    }
    const journal = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
    r.log('upgrade: the cache hit journaled the old entry', /^GET .*fengari-web/m.test(journal),
      JSON.stringify(journal.trim()));

    shell = await launchShell({ userDataDir: upDir });
    try {
      await waitForAppReady(shell.page);
      await goOffline(shell);
      await disableAutoDownload(shell.page);
      r.log('upgrade: next offline start reports Lua cached', (await cachedCheck(shell.page, 'lua')) === true);
      const outcome = await Promise.race([
        shell.page.evaluate(() => window.kernelManager.ensureReady('lua').then(() => 'ready', (e) => `rejected: ${e && e.message}`)),
        waitFor(() => promptVisible(shell.page), 30_000).then((shown) => (shown ? 'prompted' : 'timeout')),
      ]);
      r.log('upgrade: no prompt, Lua becomes ready', outcome === 'ready', outcome);
      const run2 = await runKernel(shell.page, LUA, 30_000);
      r.log('upgrade: runs offline', run2.ok && /42/.test(run2.out || ''), run2.error || run2.out);
    } finally {
      await shell.close();
    }

    // A damaged old cache: no journal, loader body gone, stale receipt kept.
    rmSync(journalPath, { force: true });
    const gone = deleteCachedBody(upDir, /fengari-web/);
    shell = await launchShell({ userDataDir: upDir });
    try {
      await waitForAppReady(shell.page);
      await disableAutoDownload(shell.page);
      r.log('upgrade, damaged old cache: the prompt comes back despite the receipt',
        !!gone && (await receiptKeys(shell.page)).length === 1
          && (await cachedCheck(shell.page, 'lua')) === false
          && await promptShownFor(shell.page, 'lua'));
    } finally {
      await shell.close();
    }
  } finally {
    try { rmSync(upDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ---------------- journal write fails: usable, but no receipt ---------------- */
  //
  // journal.log is made a directory, so every append fails (EISDIR). Entries
  // are still stored and served, but the next start's inventory could not
  // report one of them missing, so no receipt may be written for this load.
  const jfDir = makeProfile('journal-fail');
  try {
    mkdirSync(path.join(jfDir, 'runtime-cache', 'journal.log'), { recursive: true });
    let shell = await launchShell({ userDataDir: jfDir });
    try {
      await waitForAppReady(shell.page);
      const before = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('journal failure: the flag starts false', before.runtimeCacheJournalFailed === false,
        String(before.runtimeCacheJournalFailed));
      const online = await runKernel(shell.page, LUA);
      r.log('journal failure: Lua still downloads and runs', online.ok && /42/.test(online.out || ''),
        online.error || online.out);
      const after = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('journal failure: getDistributionInfo reports it', after.runtimeCacheJournalFailed === true,
        String(after.runtimeCacheJournalFailed));
      r.log('journal failure: no receipt is written', (await receiptKeys(shell.page)).length === 0,
        JSON.stringify(await receiptKeys(shell.page)));
      r.log('journal failure: the bytes were still cached', cacheEntries(jfDir) > 0,
        `${cacheEntries(jfDir)} entries`);
    } finally {
      await shell.close();
    }
    shell = await launchShell({ userDataDir: jfDir });
    try {
      await waitForAppReady(shell.page);
      await disableAutoDownload(shell.page);
      r.log('journal failure: the next start is not trusted to skip the prompt',
        (await cachedCheck(shell.page, 'lua')) === false && await promptShownFor(shell.page, 'lua'));
    } finally {
      await shell.close();
    }
  } finally {
    try { rmSync(jfDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ---------------- cache off: no receipt ---------------- */
  const offDir = makeProfile('off');
  try {
    const shell = await launchShell({ userDataDir: offDir, env: { SCIREPL_RUNTIME_CACHE: '0' } });
    try {
      await waitForAppReady(shell.page);
      const dist = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
      r.log('SCIREPL_RUNTIME_CACHE=0: getDistributionInfo reports the cache off',
        dist.runtimeCache === false && dist.runtimeCacheHosts.length === 0
          && dist.runtimeCachePresent.length === 0 && dist.runtimeCacheMissing.length === 0,
        JSON.stringify({ runtimeCache: dist.runtimeCache, hosts: dist.runtimeCacheHosts }));
      const online = await runKernel(shell.page, LUA);
      r.log('SCIREPL_RUNTIME_CACHE=0: Lua still runs online', online.ok && /42/.test(online.out || ''),
        online.error || online.out);
      r.log('SCIREPL_RUNTIME_CACHE=0: no receipt is written',
        (await receiptKeys(shell.page)).length === 0);
      r.log('SCIREPL_RUNTIME_CACHE=0: Lua is not reported cached (prompt as before)',
        (await cachedCheck(shell.page, 'lua')) === false);
    } finally {
      await shell.close();
    }
    r.log('SCIREPL_RUNTIME_CACHE=0: nothing written to userData/runtime-cache',
      cacheEntries(offDir) === 0);
  } finally {
    try { rmSync(offDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0));
}
