/**
 * harness.mjs — shared test plumbing for the Electron shell.
 *
 * The point of this file is that the *probes* (test/probes/*.mjs) never learn
 * whether they are driving an Electron window or a plain Chromium page. Both
 * runners hand them a Playwright `Page`, so the same assertions produce a
 * genuine A/B comparison between the browser baseline and the packaged origin.
 */

import { _electron as electron, chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Reporting and path constants live in reporter.mjs, which imports nothing.
// Re-exported here so the Electron-driven suites have a single import.
export { createReporter, ELECTRON_DIR, REPO_ROOT, WWW_ROOT, APP_ORIGIN } from './reporter.mjs';
import { ELECTRON_DIR, REPO_ROOT, WWW_ROOT } from './reporter.mjs';

/* ------------------------------------------------------------------ */
/* Electron                                                            */
/* ------------------------------------------------------------------ */

function electronBinary() {
  const p = path.join(ELECTRON_DIR, 'node_modules', 'electron');
  if (!existsSync(p)) {
    throw new Error(
      'Electron is not installed. Run `npm --prefix desktop/electron install` first.'
    );
  }
  return p;
}

/**
 * Launch the shell.
 *
 * @param {object} opts
 * @param {string} [opts.userDataDir] persist storage here (for restart tests).
 *                                    Omit to get a throwaway profile.
 * @param {boolean} [opts.keepUserData] don't delete the profile on close.
 * @param {boolean} [opts.prime=true] grant the privacy + auto-download consents
 *   before exercising kernels, matching what the repo's existing browser tests
 *   do. Without this, `KernelManager` opens a confirmation modal and awaits a
 *   click before fetching any CDN runtime, so CDN-backed kernels appear to hang
 *   rather than fail — pass `prime: false` only when testing that gate itself.
 */
export async function launchShell(opts = {}) {
  const userDataDir = opts.userDataDir || mkdtempSync(path.join(tmpdir(), 'scirepl-electron-'));
  const ownsUserData = !opts.userDataDir && !opts.keepUserData;

  const args = [ELECTRON_DIR];
  // WSL/CI containers frequently lack a usable setuid sandbox helper. We only
  // relax this when explicitly asked, and every security probe records whether
  // it ran with the sandbox on so the report cannot overclaim.
  if (process.env.SCIREPL_ELECTRON_NO_SANDBOX === '1') args.push('--no-sandbox');

  const electronApp = await electron.launch({
    executablePath: path.join(electronBinary(), 'dist', 'electron'),
    args,
    env: {
      ...process.env,
      SCIREPL_USER_DATA: userDataDir,
      SCIREPL_WWW: opts.www || WWW_ROOT,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    timeout: 120_000,
  });

  const page = await electronApp.firstWindow({ timeout: 120_000 });

  if (opts.prime !== false) {
    // localStorage is per-origin, so it must be written from a loaded document
    // and then picked up by a reload. This is also, incidentally, a reload test.
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_auto_download', '1');
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  }

  return {
    electronApp,
    page,
    userDataDir,
    /**
     * Close the shell. A graceful close is attempted first because that is the
     * path a real user takes and the one the persistence tests depend on, but
     * it is bounded: a shell that refuses to exit must fail the test rather
     * than wedge the whole suite.
     */
    async close({ graceful = true, timeoutMs = 20_000 } = {}) {
      let timedOut = false;
      if (graceful) {
        const closed = electronApp.close().then(() => true).catch(() => true);
        const timer = new Promise(res => setTimeout(() => { timedOut = true; res(false); }, timeoutMs));
        await Promise.race([closed, timer]);
      }
      if (timedOut || !graceful) {
        try { electronApp.process().kill('SIGKILL'); } catch { /* already gone */ }
      }
      if (ownsUserData) {
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return { timedOut };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Browser baseline                                                    */
/* ------------------------------------------------------------------ */

const DEV_SERVER_PORT = Number(process.env.SCIREPL_TEST_PORT) || 8085;

/** Start the repo's own dev server (server.js) so the baseline is the real one. */
export async function startDevServer() {
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(DEV_SERVER_PORT) },
    stdio: 'ignore',
  });
  // Poll until it answers rather than sleeping a fixed amount.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${DEV_SERVER_PORT}/index.html`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return {
    url: `http://localhost:${DEV_SERVER_PORT}`,
    stop() { try { proc.kill('SIGTERM'); } catch { /* ignore */ } },
  };
}

/** Launch plain Chromium against the dev server — the comparison baseline. */
export async function launchBrowserBaseline() {
  const server = await startDevServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    server.stop();
    // `npm install` installs the Playwright package but not its browser
    // binaries. Say so plainly instead of surfacing Playwright's stack.
    throw new Error(
      'Could not launch Chromium for the browser baseline. Playwright browser ' +
      'binaries are not provisioned by `npm install` — run `npx playwright install chromium`.\n' +
      `Original error: ${err && err.message}`
    );
  }
  const context = await browser.newContext();
  await primeContext(context);
  const page = await context.newPage();
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  return {
    page,
    origin: server.url,
    async close() {
      await browser.close().catch(() => {});
      server.stop();
    },
  };
}

/**
 * The app gates startup behind a privacy prompt and an auto-download opt-in.
 * The existing browser tests set the same two keys, so both runners start from
 * the same application state.
 */
export async function primeContext(context) {
  await context.addInitScript(() => {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_auto_download', '1');
  });
}

/** Wait until the app's kernel manager exists and the UI has booted. */
export async function waitForAppReady(page, timeout = 120_000) {
  await page.waitForFunction(() => !!window.kernelManager, null, { timeout });
}

/** Collect console + page errors for diagnosis. */
export function attachLogs(page) {
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  return logs;
}
