/**
 * smoke.mjs — launch the shell directly and report exactly what happened.
 *
 * Playwright reports a failed Electron launch as `Timeout 120000ms exceeded`
 * with none of the main process's own output, which is close to undiagnosable
 * on a CI machine you cannot log into. This script bypasses Playwright: it
 * spawns the Electron binary itself, captures raw stdout/stderr, and prints
 * them.
 *
 * If the default launch fails it retries once with the flags that most often
 * unblock Electron on a headless/virtualised Windows or Linux CI host
 * (`--disable-gpu`, `--no-sandbox`, `--disable-software-rasterizer`). Reporting
 * which of the two attempts succeeded is the point: it distinguishes "the shell
 * is broken" from "this CI host needs a GPU flag", in a single run.
 *
 *   node desktop/electron/test/smoke.mjs
 *
 * Exit code 0 means the application loaded.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ELECTRON_DIR, WWW_ROOT } from './reporter.mjs';

const requireFromHere = createRequire(import.meta.url);

function electronExecutable() {
  const pkgDir = path.join(ELECTRON_DIR, 'node_modules', 'electron');
  if (!existsSync(pkgDir)) throw new Error(`Electron is not installed at ${pkgDir}`);
  try {
    return requireFromHere(pkgDir);
  } catch {
    const rel = readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
    return path.join(pkgDir, 'dist', rel);
  }
}

function attempt(label, extraArgs, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const exe = electronExecutable();
    const userData = mkdtempSync(path.join(tmpdir(), 'scirepl-smoke-'));
    const args = [ELECTRON_DIR, ...extraArgs];

    console.log(`\n--- attempt: ${label} ---`);
    console.log(`executable : ${exe}`);
    console.log(`args       : ${JSON.stringify(args)}`);
    console.log(`www        : ${WWW_ROOT}`);
    console.log(`platform   : ${process.platform}-${process.arch}`);

    const child = spawn(exe, args, {
      env: {
        ...process.env,
        SCIREPL_SMOKE_EXIT: '1',
        SCIREPL_USER_DATA: userData,
        SCIREPL_WWW: WWW_ROOT,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });

    const timer = setTimeout(() => {
      console.log(`RESULT     : TIMEOUT after ${timeoutMs}ms — killing`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      console.log(`RESULT     : SPAWN ERROR ${e.message}`);
      resolve({ ok: false, label, reason: 'spawn-error' });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // Electron writes a lot of routine noise to stderr; print all of it,
      // because on a failing CI host the answer is usually in there.
      if (out.trim()) console.log(`stdout     :\n${out.trim()}`);
      if (err.trim()) console.log(`stderr     :\n${err.trim()}`);
      console.log(`RESULT     : exit code=${code} signal=${signal}`);

      const ok = code === 0 && out.includes('SCIREPL_SMOKE_OK');
      try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve({ ok, label, code, signal });
    });
  });
}

const plain = await attempt('default (as the test suite launches it)', []);
if (plain.ok) {
  console.log('\nSMOKE PASSED — the shell starts and loads the application with default flags.');
  process.exit(0);
}

const relaxed = await attempt(
  'fallback (--disable-gpu --no-sandbox --disable-software-rasterizer)',
  ['--disable-gpu', '--no-sandbox', '--disable-software-rasterizer']
);

console.log('\n=== smoke summary ===');
console.log(`  default flags : ${plain.ok ? 'OK' : 'FAILED'}`);
console.log(`  relaxed flags : ${relaxed.ok ? 'OK' : 'FAILED'}`);

if (relaxed.ok) {
  console.log(
    '\nThe shell itself works; this host needs GPU/sandbox flags to start Electron.\n' +
    'Fix belongs in the launcher (harness + npm start), not in the application.'
  );
} else {
  console.log(
    '\nThe shell failed to load under both configurations. The stderr above is the\n' +
    'main process\'s own output and should name the actual failure.'
  );
}
process.exit(relaxed.ok ? 0 : 1);
