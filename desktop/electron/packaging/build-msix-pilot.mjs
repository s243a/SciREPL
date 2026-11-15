/**
 * build-msix-pilot.mjs — the whole Microsoft Store pilot build in one command
 * (Free edition, Windows x64):
 *
 *   npm run package:windows:msix-pilot
 *   npm run package:windows:msix-pilot -- --dry-run   # list the steps only
 *
 * It runs, in order, stopping at the first failure:
 *   1. npm run verify:bundles                    bundled runtimes are present and intact
 *   2. npm run windows:install                   Electron and the shell's dependencies
 *   3. npm run package:windows -- --channel store  the Store-channel tree
 *   4. node desktop/electron/test/run-all.mjs packaged  tests on that tree
 *   5. npm run package:windows:msix              packs the tested tree
 *
 * One-time setup is NOT repeated here, because it changes the checkout and
 * downloads about 1 GB: run `npm install`, `npm run configure` and
 * `npm run fetch:bundles` first (see docs/WINDOWS_MSIX_PILOT.md).
 *
 * Identity variables (SCIREPL_MSIX_*) and SCIREPL_MAKEAPPX pass through to
 * build-msix.mjs unchanged. Nothing is signed, installed or submitted.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export const STEPS = [
  { label: 'verify bundled runtimes', npm: ['run', 'verify:bundles'],
    hint: 'Run `npm run fetch:bundles` first (and `npm run configure` before it on a fresh checkout).' },
  { label: 'install the Electron shell', npm: ['run', 'windows:install'] },
  { label: 'build the Store-channel tree', npm: ['run', 'package:windows', '--', '--channel', 'store'] },
  { label: 'test the packaged tree', node: ['desktop/electron/test/run-all.mjs', 'packaged'],
    hint: 'The MSIX was not built: it must wrap a tree that passed these tests.' },
  { label: 'pack the MSIX', npm: ['run', 'package:windows:msix'] },
];

function describe(step) {
  return step.npm ? `npm ${step.npm.join(' ')}` : `node ${step.node.join(' ')}`;
}

/** npm sets npm_execpath when it runs this script; use it so no shell is needed for npm.cmd. */
function command(step) {
  if (step.node) return { file: process.execPath, args: step.node, shell: false };
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/i.test(cli)) return { file: process.execPath, args: [cli, ...step.npm], shell: false };
  // Started with plain `node`: npm on Windows is npm.cmd, which needs a shell.
  // The arguments are fixed literals above, never user input.
  return { file: 'npm', args: step.npm, shell: process.platform === 'win32' };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const unknown = process.argv.slice(2).filter((a) => a !== '--dry-run');
  if (unknown.length) {
    console.error(`[msix-pilot] unknown argument(s): ${unknown.join(' ')}`);
    return 2;
  }
  if (dryRun) {
    STEPS.forEach((step, i) => console.log(`${i + 1}. ${describe(step)}    (${step.label})`));
    return 0;
  }
  if (process.platform !== 'win32') {
    console.error('[msix-pilot] Windows only: the MSIX step needs MakeAppx.exe from the Windows SDK.');
    return 1;
  }
  const started = Date.now();
  for (const [i, step] of STEPS.entries()) {
    console.log(`\n[msix-pilot] step ${i + 1}/${STEPS.length}: ${step.label}\n  > ${describe(step)}`);
    const { file, args, shell } = command(step);
    const result = spawnSync(file, args, { cwd: REPO_ROOT, stdio: 'inherit', shell });
    if (result.error || result.status !== 0) {
      const why = result.error ? result.error.message : `exit code ${result.status ?? result.signal}`;
      console.error(`\n[msix-pilot] FAILED at step ${i + 1}/${STEPS.length} (${step.label}): ${why}`);
      if (step.hint) console.error(`[msix-pilot] ${step.hint}`);
      return 1;
    }
  }
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n[msix-pilot] all ${STEPS.length} steps passed in ${minutes} min; the package is in desktop/electron/out/.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
