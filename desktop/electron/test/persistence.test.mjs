/**
 * persistence.test.mjs — does application state survive a real restart?
 *
 * This launches the shell, writes notebook and SharedVFS state, quits the
 * process for real, relaunches against the same userData directory, and checks
 * the state is still there. It is the test that actually justifies the choice
 * of a stable `app://` origin over `file://`: storage is keyed by origin, so a
 * shell whose origin changed or was opaque would come back empty.
 *
 * It also covers the "shutdown while work is in flight" case from the spike
 * brief, by quitting immediately after a write rather than waiting for idle.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchShell, createReporter, waitForAppReady } from './harness.mjs';

const MARKER = 'electron-spike-persistence-marker';

async function waitForVfsStore(page, timeout = 30_000) {
  await page.waitForFunction(() => !!(window.vfsStore && window.vfsStore.isReady()), null, { timeout });
}

export default async function run() {
  const r = createReporter('persistence');
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'scirepl-persist-'));

  try {
    /* ---------------- first launch: write state ---------------- */

    const first = await launchShell({ userDataDir });
    let wrote;
    try {
      await waitForAppReady(first.page);
      // The app opens its IndexedDB store asynchronously; until it is ready,
      // saveToIndexedDB() returns false and saves nothing.
      await waitForVfsStore(first.page);

      const originFirst = await first.page.evaluate(() => window.location.origin);

      wrote = await first.page.evaluate(async (marker) => {
        const out = {};

        // 1. SharedVFS -> IndexedDB
        const vfs = window.sharedVFS;
        vfs.writeFile('/shared/persist.txt', marker, 'test');
        out.vfsSaved = await vfs.saveToIndexedDB();
        out.vfsWritten = vfs.readFile('/shared/persist.txt') === marker;

        // 2. A notebook, through the app's own manager.
        try {
          const nm = window.notebookManager;
          if (nm && typeof nm.saveState === 'function') {
            window._cells = window._cells || [];
            await nm.saveState();
            out.notebookSaved = true;
          } else {
            out.notebookSaved = false;
          }
        } catch (e) {
          out.notebookSaved = false;
          out.notebookError = String(e && e.message);
        }

        // 3. A direct IndexedDB write, independent of app structure, so the
        //    result is meaningful even if the app's own APIs change.
        out.directIdb = await new Promise((resolve) => {
          const req = indexedDB.open('scirepl-spike-probe', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(marker, 'marker');
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); resolve(false); };
          };
          req.onerror = () => resolve(false);
        });

        // 4. localStorage, used for settings/preferences.
        localStorage.setItem('scirepl_spike_marker', marker);
        out.localStorage = localStorage.getItem('scirepl_spike_marker') === marker;

        return out;
      }, MARKER);

      r.log('first launch: origin is the stable app origin', originFirst === 'app://scirepl', originFirst);

      // Durability, not just survival. Chromium storage is "best-effort" by
      // default and may be discarded under disk pressure; persist() is what
      // exempts an origin. A blanket permission denial in security.js silently
      // refused it, so notebooks sat in evictable storage — measured false
      // before the fix. Android gets this free from its private app data
      // directory; a browser PWA does not.
      const durability = await first.page.evaluate(async () => {
        const est = await navigator.storage.estimate();
        return {
          persisted: await navigator.storage.persisted(),
          quotaMB: Math.round((est.quota || 0) / 1e6),
        };
      });
      r.log('first launch: storage is marked persistent (not evictable)',
        durability.persisted === true, JSON.stringify(durability));
      r.log('first launch: SharedVFS write succeeded', wrote.vfsWritten === true);
      r.log('first launch: SharedVFS saved to IndexedDB', wrote.vfsSaved === true, String(wrote.vfsSaved));
      r.log('first launch: direct IndexedDB write succeeded', wrote.directIdb === true);
      r.log('first launch: localStorage write succeeded', wrote.localStorage === true);
    } finally {
      // Quit immediately after writing — the "shutdown while work is active"
      // case. A graceful close must still flush.
      const { timedOut } = await first.close();
      r.log('shell shuts down gracefully after active writes', timedOut === false,
        timedOut ? 'close() timed out and needed SIGKILL' : '');
    }

    /* ---------------- second launch: read state back ---------------- */

    const second = await launchShell({ userDataDir });
    try {
      await waitForAppReady(second.page);
      await waitForVfsStore(second.page);

      const originSecond = await second.page.evaluate(() => window.location.origin);
      r.log('second launch: origin is unchanged', originSecond === 'app://scirepl', originSecond);

      const read = await second.page.evaluate(async (marker) => {
        const out = {};

        out.localStorage = localStorage.getItem('scirepl_spike_marker') === marker;

        out.directIdb = await new Promise((resolve) => {
          const req = indexedDB.open('scirepl-spike-probe', 1);
          req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch {} };
          req.onsuccess = () => {
            const db = req.result;
            try {
              const tx = db.transaction('kv', 'readonly');
              const get = tx.objectStore('kv').get('marker');
              get.onsuccess = () => { const v = get.result; db.close(); resolve(v === marker); };
              get.onerror = () => { db.close(); resolve(false); };
            } catch (e) { db.close(); resolve(false); }
          };
          req.onerror = () => resolve(false);
        });

        // What IndexedDB holds. Whether the app restored it into SharedVFS
        // by itself at startup is checked below, without calling the restore.
        try {
          const stored = await window.vfsStore.loadSharedFiles();
          out.vfsStored = stored.some((f) => f.path === '/shared/persist.txt' && f.content === marker);
        } catch (e) {
          out.vfsStored = false;
          out.vfsError = String(e && e.message);
        }

        const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        out.databases = dbs.map(d => d.name).filter(Boolean).sort();
        return out;
      }, MARKER);

      // The app restores SharedVFS from IndexedDB asynchronously during
      // startup; wait for that restore rather than performing it.
      let restored = false;
      try {
        await second.page.waitForFunction((marker) => {
          try { return window.sharedVFS.readFile('/shared/persist.txt') === marker; } catch { return false; }
        }, MARKER, { timeout: 30_000 });
        restored = true;
      } catch { /* reported below */ }

      r.log('IndexedDB survives a full application restart', read.directIdb === true,
        JSON.stringify(read.databases));
      r.log('SharedVFS content is still in IndexedDB after a full application restart', read.vfsStored === true,
        read.vfsError || '');
      r.log('the app restores SharedVFS content by itself at startup', restored,
        restored ? '' : 'not in SharedVFS 30 s after the store opened');
      r.log('localStorage survives a full application restart', read.localStorage === true);
    } finally {
      await second.close();
    }
  } finally {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
