/**
 * probes/kernels.mjs — one representative execution per kernel, plus the
 * cross-kernel SharedVFS path.
 *
 * These probes take a Playwright `Page` and nothing else. The Electron runner
 * and the browser-baseline runner both drive this same module, so any
 * difference in the results is a real difference between the packaged origin
 * and the browser, not a difference between two test suites.
 *
 * The probes deliberately reuse the application's own entry points
 * (`window.kernelManager.ensureReady` / `.execute`, `window.sharedVFS`) — the
 * same ones the existing browser tests in the repository root use — rather than
 * reaching into kernel internals.
 */

/** Kernels and a minimal program whose output is unambiguous. */
export const KERNEL_CASES = [
  {
    lang: 'javascript',
    label: 'JavaScript (native)',
    code: 'console.log(6 * 7)',
    expect: /42/,
    network: false,
  },
  {
    lang: 'bash',
    label: 'Bash / Brush (WASM, bundled)',
    code: 'echo $((6 * 7))',
    expect: /42/,
    network: false,
  },
  {
    lang: 'typr',
    label: 'TypR (WASM, bundled + webR)',
    code: 'let x <- 42\ncat(x)',
    expect: /42/,
    network: true, // TypR's init calls ensureReady('r'), which fetches webR
    // Measured in this spike: the kernel initialises and executes without
    // error, but `cat()` output does not reach `execute()`'s stdout, so the
    // output assertion fails. The browser baseline fails identically, and the
    // repository's own test_typr_kernel.mjs already tolerates empty output
    // here — so this is a pre-existing application gap, not something the
    // Electron origin introduced. Tracked as such rather than silently
    // relaxed; the parity check below still fails if Electron ever diverges.
    knownIssue: 'cat() output is not surfaced through execute() stdout; reproduces identically in the browser baseline',
  },
  {
    lang: 'lua',
    label: 'Lua / Fengari (CDN)',
    code: 'print(6 * 7)',
    expect: /42/,
    network: true,
  },
  {
    lang: 'clojurescript',
    label: 'ClojureScript / Scittle (bundled)',
    code: '(println (* 6 7))',
    expect: /42/,
    network: false,
  },
  {
    lang: 'prolog',
    label: 'SWI-Prolog (WASM, bundled)',
    code: 'X is 6 * 7, format("~w~n", [X]).',
    expect: /42/,
    network: false,
  },
  {
    lang: 'python',
    label: 'Python / Pyodide (WASM, bundled)',
    code: 'print(6 * 7)',
    expect: /42/,
    network: false,
  },
  {
    lang: 'r',
    label: 'R / webR (WASM, CDN in the Free profile)',
    code: 'cat(6 * 7)',
    expect: /42/,
    network: true,
  },
];

/** Which kernels the running build actually enables, per kernel_config.js. */
export async function enabledKernels(page) {
  return page.evaluate(() => {
    const cfg = window.KERNEL_CONFIG || { languages: {} };
    return Object.entries(cfg.languages || {})
      .filter(([, v]) => v && v.enabled)
      .map(([k]) => k);
  });
}

export async function registeredKernels(page) {
  return page.evaluate(() => Object.keys((window.kernelManager && window.kernelManager._registry) || {}));
}

/**
 * Initialise and run one kernel. Returns a structured result rather than
 * throwing, so one broken kernel does not hide the rest of the matrix.
 */
export async function runKernel(page, { lang, code }, timeoutMs = 240_000) {
  return page.evaluate(async ({ lang, code, timeoutMs }) => {
    const started = performance.now();
    const withTimeout = (p, ms, what) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
    ]);

    try {
      const km = window.kernelManager;
      if (!km || !km._registry || !km._registry[lang]) {
        return { status: 'unregistered', lang };
      }

      await withTimeout(km.ensureReady(lang), timeoutMs, `${lang} init`);
      const readyAt = performance.now();

      const res = await withTimeout(km.execute(code, lang), timeoutMs, `${lang} execute`);
      const doneAt = performance.now();

      const text = [
        res && res.stdout ? res.stdout : '',
        res && res.result && res.result.content ? res.result.content : '',
      ].join('\n').trim();

      return {
        status: res && res.error ? 'error' : 'ok',
        lang,
        output: text,
        error: res && res.error ? String(res.error) : null,
        initMs: Math.round(readyAt - started),
        execMs: Math.round(doneAt - readyAt),
      };
    } catch (e) {
      return { status: 'threw', lang, error: String((e && e.message) || e), initMs: null, execMs: null };
    }
  }, { lang, code, timeoutMs });
}

/**
 * Cross-kernel SharedVFS: write from one kernel's side, read from another.
 * This is the path that would break first if workers or storage misbehaved
 * under a custom origin.
 */
export async function probeSharedVfs(page) {
  return page.evaluate(async () => {
    const out = {};
    try {
      const vfs = window.sharedVFS;
      if (!vfs) return { available: false };
      out.available = true;

      const marker = 'electron-spike-' + Date.now();
      vfs.writeFile('/shared/spike.txt', marker, 'test');
      out.roundTrip = vfs.readFile('/shared/spike.txt') === marker;
      out.exists = vfs.exists('/shared/spike.txt') === true;

      // Visible to a kernel? Python mounts /shared through sharedfs.py.
      try {
        const km = window.kernelManager;
        await km.ensureReady('python');
        const res = await km.execute(
          "open('/shared/spike.txt').read()", 'python');
        const seen = ((res.stdout || '') + (res.result?.content || ''));
        out.visibleToPython = seen.includes(marker);
        out.pythonError = res.error || null;
      } catch (e) {
        out.visibleToPython = false;
        out.pythonError = String(e && e.message);
      }

      // Persist to IndexedDB — the operation the restart test depends on.
      if (typeof vfs.saveToIndexedDB === 'function') {
        await vfs.saveToIndexedDB();
        out.savedToIndexedDb = true;
      }
      out.marker = marker;
      return out;
    } catch (e) {
      return { available: false, error: String(e && e.message) };
    }
  });
}

/** Enumerate IndexedDB databases the application created. */
export async function probeIndexedDb(page) {
  return page.evaluate(async () => {
    if (!indexedDB || typeof indexedDB.databases !== 'function') {
      return { supported: !!indexedDB, enumerable: false };
    }
    const dbs = await indexedDB.databases();
    return { supported: true, enumerable: true, names: dbs.map(d => d.name).filter(Boolean).sort() };
  });
}
