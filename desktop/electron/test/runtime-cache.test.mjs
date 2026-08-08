/**
 * runtime-cache.test.mjs — CDN runtimes must survive a restart, offline.
 *
 * This is the suite that guards the fix for the shell's one real functional
 * regression against the PWA. `www/sw.js` keeps a `CDN_CACHE` so a runtime
 * fetched once keeps working offline; that cache cannot function under the
 * `app://` origin, because the Cache API only accepts http/https. Chromium's
 * own HTTP cache covered Lua but not webR, and raising `--disk-cache-size` to
 * 2 GB did not change that.
 *
 * `runtime-cache.js` replaces it with a cache in the application's own data
 * directory. The assertions below are the ones that matter: fetch once online,
 * restart, cut the network, and the kernel still runs.
 *
 * Needs network for the first half, so it is opt-in rather than part of the
 * default run:
 *
 *   node desktop/electron/test/run-all.mjs runtime-cache
 */

import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchShell, createReporter, waitForAppReady } from './harness.mjs';

/** Cut the network at the session level, leaving app:// untouched. */
async function goOffline(shell) {
  await shell.electronApp.evaluate(async ({ session }) => {
    await session.defaultSession.setProxy({ proxyRules: 'http=127.0.0.1:1;https=127.0.0.1:1' });
    await session.defaultSession.closeAllConnections();
  });
}

async function runKernel(page, lang, code, timeoutMs) {
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

function cacheSize(userDataDir) {
  const dir = path.join(userDataDir, 'runtime-cache');
  if (!existsSync(dir)) return { entries: 0, bytes: 0 };
  let bytes = 0;
  let entries = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.meta.json') || f.endsWith('.partial')) continue;
    bytes += statSync(path.join(dir, f)).size;
    entries++;
  }
  return { entries, bytes };
}

/** One kernel, end to end: online once, then offline after a real restart. */
async function checkKernel(r, { lang, label, code, timeoutMs }) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), `scirepl-rc-${lang}-`));
  try {
    let shell = await launchShell({ userDataDir });
    try {
      await waitForAppReady(shell.page);
      const online = await runKernel(shell.page, lang, code, timeoutMs);
      r.log(`${label}: runs online`, online.ok === true, online.error || online.out);
      if (!online.ok) return; // nothing cached; the offline half would be meaningless
    } finally {
      await shell.close();
    }

    const size = cacheSize(userDataDir);
    r.log(`${label}: bytes were written to userData/runtime-cache`,
      size.entries > 0, `${size.entries} entries, ${(size.bytes / 1e6).toFixed(1)} MB`);

    // Fresh process, same profile, no network.
    shell = await launchShell({ userDataDir });
    try {
      await goOffline(shell);
      await shell.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
      await waitForAppReady(shell.page);

      const remote = await shell.page.evaluate(async () => {
        try { await fetch('https://example.com/', { cache: 'no-store' }); return 'reachable'; }
        catch { return 'blocked'; }
      });
      r.log(`${label}: network really is cut for the offline half`, remote === 'blocked', remote);

      const offline = await runKernel(shell.page, lang, code, timeoutMs);
      r.log(`${label}: still runs OFFLINE after a restart`, offline.ok === true,
        offline.error || offline.out);
      r.log(`${label}: offline output is correct`, /42/.test(offline.out || ''),
        JSON.stringify(offline.out || ''));
    } finally {
      await shell.close();
    }
  } finally {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export default async function run() {
  const r = createReporter('runtime-cache');

  // Lua is small and was already covered by Chromium's HTTP cache; R is the one
  // that failed, and is the reason this cache exists. Both are checked so a
  // regression in either is visible.
  await checkKernel(r, {
    lang: 'lua', label: 'Lua / Fengari (~200 kB)',
    code: 'print(6*7)', timeoutMs: 90_000,
  });
  await checkKernel(r, {
    lang: 'r', label: 'R / webR (~50 MB)',
    code: 'cat(6*7)', timeoutMs: 240_000,
  });

  /* ---- the cache must not be reached without a prior online fetch ---- */
  //
  // Guards against the cache appearing to work because something else is
  // serving the bytes: a profile that never went online must still fail.
  const coldDir = mkdtempSync(path.join(tmpdir(), 'scirepl-rc-cold-'));
  const cold = await launchShell({ userDataDir: coldDir });
  try {
    await waitForAppReady(cold.page);
    await goOffline(cold);
    await cold.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForAppReady(cold.page);
    const res = await runKernel(cold.page, 'lua', 'print(6*7)', 45_000);
    r.log('a cold profile with no network still fails (the cache is not fabricating hits)',
      res.ok === false, res.error || res.out);
  } finally {
    await cold.close();
    try { rmSync(coldDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0));
}
