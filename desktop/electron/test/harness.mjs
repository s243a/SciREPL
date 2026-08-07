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
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Reporting and path constants live in reporter.mjs, which imports nothing.
// Re-exported here so the Electron-driven suites have a single import.
export { createReporter, ELECTRON_DIR, REPO_ROOT, WWW_ROOT, APP_ORIGIN } from './reporter.mjs';
import { ELECTRON_DIR, REPO_ROOT, WWW_ROOT } from './reporter.mjs';

/* ------------------------------------------------------------------ */
/* Electron                                                            */
/* ------------------------------------------------------------------ */

const requireFromHere = createRequire(import.meta.url);

/**
 * Absolute path to the Electron executable for THIS platform.
 *
 * The executable name is platform-specific — `electron` on Linux,
 * `electron.exe` on Windows, `Electron.app/Contents/MacOS/Electron` on macOS —
 * so it must never be hardcoded. (It was, and the first Windows CI run failed
 * with Playwright's opaque "Process failed to launch!" because
 * `dist/electron` does not exist there.)
 *
 * The `electron` package already solves this: its entry point exports the
 * absolute path, resolved from the `path.txt` its installer writes. Ask the
 * package rather than guessing, and fall back to reading `path.txt` directly if
 * the entry point is unavailable.
 *
 * Playwright cannot resolve this itself here: Electron lives in
 * `desktop/electron/node_modules`, deliberately isolated from the root
 * dependency tree, so `executablePath` must be passed explicitly.
 */
function electronExecutable() {
  const pkgDir = path.join(ELECTRON_DIR, 'node_modules', 'electron');
  if (!existsSync(pkgDir)) {
    throw new Error(
      'Electron is not installed. Run `npm --prefix desktop/electron install` first.'
    );
  }

  let exe;
  try {
    // electron/index.js exports the absolute path to the binary.
    exe = requireFromHere(pkgDir);
  } catch (err) {
    try {
      const rel = readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
      exe = path.join(pkgDir, 'dist', rel);
    } catch {
      throw new Error(
        `Could not determine the Electron executable path under ${pkgDir}. ` +
        'The install may have been run with --ignore-scripts, which skips the ' +
        'binary download. Re-run `npm --prefix desktop/electron install`.\n' +
        `Original error: ${err && err.message}`
      );
    }
  }

  if (typeof exe !== 'string' || !existsSync(exe)) {
    throw new Error(
      `The Electron executable was not found at ${exe}. ` +
      'The binary download may have been skipped (ELECTRON_SKIP_BINARY_DOWNLOAD / ' +
      '--ignore-scripts). Re-run `npm --prefix desktop/electron install`.'
    );
  }
  return exe;
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

  const executablePath = electronExecutable();
  let electronApp;
  try {
    electronApp = await electron.launch({
      executablePath,
      args,
      env: {
        ...process.env,
        SCIREPL_USER_DATA: userDataDir,
        SCIREPL_WWW: opts.www || WWW_ROOT,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: 120_000,
    });
  } catch (err) {
    // Playwright reports launch failures as a bare "Process failed to launch!"
    // with no indication of what it tried to run. Attach the details that
    // actually narrow it down — this is what the first Windows CI failure
    // needed and did not have.
    throw new Error(
      `Failed to launch the Electron shell.\n` +
      `  executable: ${executablePath}\n` +
      `  args:       ${JSON.stringify(args)}\n` +
      `  platform:   ${process.platform}-${process.arch}\n` +
      `  www root:   ${opts.www || WWW_ROOT}\n` +
      `  userData:   ${userDataDir}\n` +
      `If the executable path looks wrong for this platform, the Electron install ` +
      `is incomplete. If it looks right, the main process most likely threw during ` +
      `startup — run it directly to see the error:\n` +
      `  npm --prefix desktop/electron start\n` +
      `Original error: ${err && err.message}`
    );
  }

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
