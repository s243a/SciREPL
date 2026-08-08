/**
 * dev-windows.mjs — first-time setup and launch, in one command.
 *
 *   npm run dev:windows
 *
 * Does everything a fresh Windows checkout needs, in order, and stops with an
 * actionable message rather than a stack trace when a prerequisite is missing:
 *
 *   1. check Node (>= 22) and report the platform
 *   2. configure the Free build profile
 *   3. fetch the Free bundled runtimes (~100 MB, first run only)
 *   4. install the isolated Electron dependencies under desktop/electron/
 *   5. provision the Electron binary deterministically
 *   6. launch the shell
 *
 * It installs nothing system-wide and needs no administrator privileges.
 * Steps that are already done are detected and skipped, so re-running it is
 * cheap — it doubles as "just launch the thing".
 *
 *   --skip-launch   do the setup only
 *   --force         redo steps even if they look complete
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ELECTRON_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { decideConfiguration, isFreeProfile, FREE_PROFILES, PRO_ONLY_RUNTIME_DIRS } =
  createRequire(import.meta.url)(path.join(
    path.resolve(fileURLToPath(new URL('..', import.meta.url))), 'profile-guard.js'));
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..', '..');
const WWW_ROOT = path.join(REPO_ROOT, 'www');

const force = process.argv.includes('--force');
const skipLaunch = process.argv.includes('--skip-launch');

const MIN_NODE_MAJOR = 22;

let step = 0;
const say = (msg) => console.log(msg);
const heading = (msg) => console.log(`\n[${++step}] ${msg}`);

function fail(title, ...lines) {
  console.error(`\n  ${title}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

/** Run a command, inheriting stdio, and stop the script if it fails. */
function run(command, args, { cwd = REPO_ROOT, what } = {}) {
  const res = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // npm on Windows is npm.cmd, which is not directly executable by CreateProcess.
    shell: process.platform === 'win32',
  });
  if (res.error && res.error.code === 'ENOENT') {
    fail(`Could not run \`${command}\`.`, `It is not on PATH.`,
      command === 'npm' ? 'Install Node.js 22 or newer from https://nodejs.org/ and reopen your terminal.' : '');
  }
  if (res.status !== 0) {
    fail(`Step failed: ${what || command}`,
      `\`${command} ${args.join(' ')}\` exited with code ${res.status}.`,
      'The output above should say why.');
  }
}

/* ---------------------------- 1. environment ---------------------------- */

heading('Checking prerequisites');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  fail(
    `Node ${MIN_NODE_MAJOR} or newer is required — this is Node ${process.versions.node}.`,
    'Install it from https://nodejs.org/ (the LTS build is fine),',
    'then close and reopen your terminal so PATH is refreshed.'
  );
}
say(`    Node ${process.versions.node}  (>= ${MIN_NODE_MAJOR} required)`);

if (process.platform === 'win32') {
  say(`    Platform win32-${process.arch} — native Windows build`);
} else {
  // Deliberately a warning, not an error. Running this under WSL with WSLg is a
  // genuinely useful preview, but it launches the LINUX Electron build shown on
  // a Windows desktop — it is not the native Windows executable, and it cannot
  // stand in for Windows verification.
  say(`    Platform ${process.platform}-${process.arch}`);
  say('');
  say('    Note: this is not Windows. The shell will still run, but you are');
  say('    launching the Linux Electron build (via WSLg, if you are in WSL),');
  say('    not the native Windows executable. Fine for a look at the UI;');
  say('    not a substitute for testing on Windows.');
}

// A checkout under \\wsl.localhost or a UNC path breaks Node tooling on Windows
// in confusing ways. Say so plainly instead of letting it fail later.
if (process.platform === 'win32' && /^\\\\/.test(REPO_ROOT)) {
  fail(
    'This repository is on a UNC path.',
    `  ${REPO_ROOT}`,
    'Windows Node tooling and Electron do not handle \\\\wsl.localhost or network',
    'paths reliably. Copy the repository to a local path such as',
    '  C:\\Users\\<you>\\Projects\\SciREPL',
    'and run this again from there.'
  );
}

/* ------------------------- 2. build profile ---------------------------- */

const kernelConfig = path.join(WWW_ROOT, 'js', 'kernel_config.js');

/** The profile in the generated config, or null when there is none. */
function configuredProfile() {
  if (!existsSync(kernelConfig)) return null;
  const m = readFileSync(kernelConfig, 'utf8').match(/["']?profile["']?\s*:\s*["']([^"']+)["']/);
  return m ? m[1] : 'unknown';
}

// The profile this launch intends to prepare. BUILD_PROFILE lets someone pick a
// lighter Free profile; the repository default is used otherwise.
const profiles = JSON.parse(readFileSync(path.join(REPO_ROOT, 'build-profiles.json'), 'utf8'));
const intendedProfile = process.env.BUILD_PROFILE || profiles.default;

if (!isFreeProfile(intendedProfile)) {
  fail(
    `This launcher only prepares Free profiles, and '${intendedProfile}' is not one.`,
    `Free profiles: ${FREE_PROFILES.join(', ')}.`,
    'Selecting the Pro profile is a deliberate act, so this refuses rather than',
    'silently overwriting your configuration.'
  );
}

// Pro-only runtime content must not be carried into a Free launch. Left in
// place, it would be served by the Free build and make offline R appear to work
// in an edition that does not ship it.
const stalePro = PRO_ONLY_RUNTIME_DIRS
  .map((d) => path.join(WWW_ROOT, 'vendor', d))
  .filter(existsSync);
if (stalePro.length) {
  fail(
    'This checkout contains Pro-only runtime content.',
    ...stalePro.map((d) => `  ${d}`),
    'That is bundled by the `pro` profile, not by any Free profile, so a Free',
    'launch must not serve it. Remove the directory (or re-run',
    '`npm run fetch:bundles` for a Free profile) and try again.'
  );
}

const existingProfile = configuredProfile();
const decision = decideConfiguration({ existingProfile, intendedProfile, force });

if (decision.action === 'configure') {
  heading(`Configuring the '${intendedProfile}' build profile — ${decision.reason}`);
  // The profile is passed explicitly: relying on the repository default is what
  // let a previously-Pro-configured tree launch as Free.
  run('npm', ['run', 'configure', '--', intendedProfile], { what: 'npm run configure' });

  const after = configuredProfile();
  if (after !== intendedProfile) {
    fail(
      `Configuration did not produce the '${intendedProfile}' profile.`,
      `www/js/kernel_config.js now reports '${after}'.`,
      'Run `npm run configure` manually to see what happened.'
    );
  }
} else {
  heading(`Build profile already configured ('${intendedProfile}') — skipping`);
}

/* ------------------------- 3. bundled runtimes -------------------------- */

const runtimeDirs = ['pyodide', 'swipl', 'scittle'];
const missingRuntimes = runtimeDirs.filter((d) => !existsSync(path.join(WWW_ROOT, 'vendor', d)));
if (force || missingRuntimes.length) {
  heading('Fetching bundled runtimes (~100 MB — first run only)');
  run('npm', ['run', 'fetch:bundles'], { what: 'npm run fetch:bundles' });
} else {
  heading('Bundled runtimes already present — skipping');
}

/* --------------------- 4/5. Electron, isolated + real -------------------- */

const electronPkgDir = path.join(ELECTRON_DIR, 'node_modules', 'electron');
if (force || !existsSync(electronPkgDir)) {
  heading('Installing the isolated Electron dependencies');
  say('    (these live under desktop/electron/, not the root package.json,');
  say('     so the Android and PWA builds never download a Chromium runtime)');
  run('npm', ['install'], { cwd: ELECTRON_DIR, what: 'npm install in desktop/electron' });
} else {
  heading('Electron dependencies already installed — skipping');
}

// electron@43 ships no postinstall: it downloads the binary lazily on first
// require(), which would otherwise happen in the middle of something else.
// Provision it explicitly so failures surface here, with context.
const electronBinaryPresent = () => {
  try {
    const rel = readFileSync(path.join(electronPkgDir, 'path.txt'), 'utf8').trim();
    return existsSync(path.join(electronPkgDir, 'dist', rel));
  } catch {
    return false;
  }
};

if (force || !electronBinaryPresent()) {
  heading('Downloading the Electron binary (~220 MB — first run only)');
  run(process.execPath, [path.join(electronPkgDir, 'install.js')], {
    cwd: ELECTRON_DIR,
    what: 'Electron binary download',
  });
  if (!electronBinaryPresent()) {
    fail(
      'The Electron binary is still missing after the download step.',
      `Looked under ${path.join(electronPkgDir, 'dist')}.`,
      'If you are behind a proxy, set HTTPS_PROXY and try again, or delete',
      '  desktop/electron/node_modules',
      'and re-run this command.'
    );
  }
} else {
  heading('Electron binary already present — skipping');
}

/* ------------------------------ 6. launch ------------------------------- */

if (skipLaunch) {
  console.log('\nSetup complete. Launch with:  npm run dev:windows\n');
  process.exit(0);
}

heading('Launching SciREPL');
say('    Close the window (or press Ctrl+C here) to stop.\n');

const res = spawnSync(process.execPath, [path.join(electronPkgDir, 'cli.js'), ELECTRON_DIR], {
  cwd: ELECTRON_DIR,
  stdio: 'inherit',
});

// A window the user closed is a normal exit; SIGINT from Ctrl+C is too.
if (res.status !== 0 && res.status !== null) {
  fail(
    `SciREPL exited with code ${res.status}.`,
    'For the main process\'s own output, run the launch diagnostic:',
    '  node desktop/electron/test/smoke.mjs'
  );
}
