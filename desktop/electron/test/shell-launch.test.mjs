/**
 * shell-launch.test.mjs — the shell starts, serves the app from the intended
 * origin, and the origin actually behaves like a real secure origin.
 *
 * This is the test that answers the spike's first question: does SciREPL load
 * at all under a custom application protocol, without a public server?
 */

import { launchShell, createReporter, waitForAppReady, attachLogs, APP_ORIGIN } from './harness.mjs';

export default async function run() {
  const r = createReporter('shell-launch');
  const shell = await launchShell();
  const logs = attachLogs(shell.page);

  try {
    const { page } = shell;

    // --- origin model ---
    const url = page.url();
    r.log('window loads from the app:// origin', url.startsWith(`${APP_ORIGIN}/`), url);

    const origin = await page.evaluate(() => window.location.origin);
    r.log('document origin is the stable app origin', origin === APP_ORIGIN, origin);

    const secure = await page.evaluate(() => window.isSecureContext);
    r.log('origin is a Secure Context', secure === true, `isSecureContext=${secure}`);

    // A non-opaque origin is the precondition for IndexedDB surviving restart.
    const opaque = await page.evaluate(() => window.origin === 'null');
    r.log('origin is not opaque', opaque === false);

    // --- the application itself booted ---
    await waitForAppReady(page);
    r.log('window.kernelManager is present', true);

    const title = await page.title();
    r.log('document title loaded', /sci\s*repl/i.test(title), title);

    // Relative asset resolution under a custom scheme is the thing most likely
    // to silently break; assert a real vendored asset resolved and executed.
    const vendored = await page.evaluate(() => ({
      katex: typeof window.katex,
      marked: typeof window.marked,
      plotly: typeof window.Plotly,
      jszip: typeof window.JSZip,
      hljs: typeof window.hljs,
    }));
    for (const [name, type] of Object.entries(vendored)) {
      r.log(`relative vendored asset executed: ${name}`, type !== 'undefined', type);
    }

    // --- fetch() of app:// URLs, used by kernel loading ---
    const fetched = await page.evaluate(async () => {
      const res = await fetch('js/kernel_config.js');
      return { ok: res.ok, status: res.status, type: res.headers.get('content-type') };
    });
    r.log('fetch() of a relative app:// asset works', fetched.ok === true, JSON.stringify(fetched));

    // --- correct MIME for WebAssembly streaming ---
    const wasmType = await page.evaluate(async () => {
      const res = await fetch('vendor/brush/brush_wasm_bg.wasm');
      return { ok: res.ok, type: res.headers.get('content-type') };
    });
    r.log('.wasm is served as application/wasm',
      wasmType.type === 'application/wasm', JSON.stringify(wasmType));

    // Prove streaming compilation actually works, not just the header.
    const streaming = await page.evaluate(async () => {
      try {
        const mod = await WebAssembly.compileStreaming(fetch('vendor/brush/brush_wasm_bg.wasm'));
        return { ok: !!mod };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    });
    r.log('WebAssembly.compileStreaming succeeds under app://',
      streaming.ok === true, streaming.error || '');

    // --- path containment ---
    // Plain `../` is normalised away by the URL parser before it reaches the
    // handler, so the case that actually exercises resolveRequestPath is the
    // percent-encoded one, which survives parsing and is decoded by us.
    const escaped = await page.evaluate(async () => {
      const out = {};
      for (const p of ['/../../package.json', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json']) {
        try {
          const res = await fetch(p);
          out[p] = res.status;
        } catch (e) {
          out[p] = 'threw';
        }
      }
      return out;
    });
    const noneServed = Object.values(escaped).every(v => v !== 200);
    r.log('traversal outside www/ is refused (raw and percent-encoded)',
      noneServed, JSON.stringify(escaped));

    // --- CSP is actually attached to the document ---
    const cspApplied = await page.evaluate(async () => {
      const res = await fetch('index.html');
      return res.headers.get('content-security-policy') || '';
    });
    r.log('document carries a Content-Security-Policy',
      cspApplied.includes("frame-ancestors 'none'") && cspApplied.includes("object-src 'none'"),
      cspApplied.slice(0, 120));

    // --- reload ---
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForAppReady(page);
    const originAfter = await page.evaluate(() => window.location.origin);
    r.log('application survives reload with the same origin', originAfter === APP_ORIGIN, originAfter);

    const fatal = logs.filter(l => l.startsWith('[pageerror]'));
    r.log('no uncaught page errors during startup', fatal.length === 0, fatal.slice(0, 3).join(' | '));
  } finally {
    await shell.close();
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
