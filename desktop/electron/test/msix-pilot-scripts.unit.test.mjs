/**
 * msix-pilot-scripts.unit.test.mjs — the local MSIX pilot scripts in
 * desktop/electron/packaging/pilot (docs/WINDOWS_MSIX_PILOT_SCRIPTS.md).
 *
 * Pure Node, plus PowerShell 7 (`pwsh`) when it is on PATH: nothing here
 * builds, signs, installs or changes certificate trust. The PowerShell checks
 * parse every script and exercise the pure decision functions; without pwsh
 * they are reported as skipped, never as passed.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from './reporter.mjs';
import {
  parseArgs, buildSteps, compareVersions, buildInfoProblems, childEnv, dirtyProblem, LOCKFILES,
} from '../packaging/pilot/build-pilot-packages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT_DIR = path.resolve(HERE, '..', 'packaging', 'pilot');
const NODE_SCRIPT = path.join(PILOT_DIR, 'build-pilot-packages.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'msix-pilot', 'wack-report.xml');
const PS_TESTS = path.join(HERE, 'msix-pilot-scripts.tests.ps1');
const COMMIT = 'e4a296b7e3101e566e84a4f4151eec82bf6b196d';

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

const ADMIN_SCRIPTS = new Set(['Step3-Sign.ps1', 'Step5-Wack.ps1', 'Cleanup.ps1']);
const APPX = /\b(Get|Add|Remove)-AppxPackage\b/;

export default async function run() {
  const r = createReporter('msix-pilot-scripts');

  // build-pilot-packages.mjs: arguments and plan.
  r.log('--run is required', throws(() => parseArgs([])));
  r.log('--run needs a value', throws(() => parseArgs(['--run'])) && throws(() => parseArgs(['--run', '--dry-run'])));
  r.log('unknown arguments are rejected', throws(() => parseArgs(['--run', 'x', '--sign'])));
  const parsed = parseArgs(['--run', 'C:\\pilot\\run-2', '--dry-run']);
  r.log('--run and --dry-run are read', parsed.run === 'C:\\pilot\\run-2' && parsed.dryRun === true);

  const npmSteps = (bump) => buildSteps({ bump }).filter((s) => s.npm).map((s) => s.npm.join(' '));
  const a = npmSteps(false);
  const b = npmSteps(true);
  r.log('A: npm ci (never npm install), configure, fetch:bundles, then the pilot build',
    a.join(' | ') === 'ci | run configure | run fetch:bundles | run package:windows:msix-pilot', a.join(' | '));
  r.log('B: the version raise, then the licence notices, then the pilot build',
    b.join(' | ') === 'ci | run configure | run fetch:bundles | version patch --no-git-tag-version | run licenses:generate | run package:windows:msix-pilot', b.join(' | '));
  const stepsB = buildSteps({ bump: true });
  const firstCheck = stepsB.findIndex((s) => s.lockfiles);
  r.log('both lockfiles are checked after setup and before the version raise',
    firstCheck > 0 && stepsB[firstCheck].lockfiles.join() === LOCKFILES.join()
      && firstCheck < stepsB.findIndex((s) => s.npm && s.npm[0] === 'version'));
  r.log('the Electron lockfile is checked after the build',
    stepsB.at(-1).lockfiles?.join() === 'desktop/electron/package-lock.json');

  r.log('a clean checkout has no problem', dirtyProblem('', { label: 'A', when: 'now' }) === null && dirtyProblem('\n', { label: 'A', when: 'now' }) === null);
  r.log('a modified tracked file is a problem', /www\/js\/app\.js/.test(dirtyProblem(' M www/js/app.js\n', { label: 'A', when: 'now' }) || ''));
  r.log('an untracked file is a problem', /\?\? www\/extra\.js/.test(dirtyProblem('?? www/extra.js\n', { label: 'A', when: 'now' }) || ''));
  r.log('the build refuses a dirty checkout before and after building A',
    (readFileSync(NODE_SCRIPT, 'utf8').match(/assertClean\(REPO_ROOT/g) || []).length === 2);
  r.log('versions compare numerically', compareVersions('1.5.10', '1.5.9') === 1 && compareVersions('1.5.0', '1.5.1') === -1 && compareVersions('2.0.0', '2.0.0') === 0);
  r.log('a non x.y.z version is an error', throws(() => compareVersions('1.5', '1.5.0')) && throws(() => compareVersions('1.5.0-rc.1', '1.5.0')));

  const good = { channel: 'store', commit: COMMIT, appVersion: '1.5.1' };
  r.log('a matching store-channel tree has no problems', buildInfoProblems(good, { label: 'B', commit: COMMIT, olderThan: '1.5.0' }).length === 0);
  r.log('a non-store channel is a problem', buildInfoProblems({ ...good, channel: 'preview' }, { label: 'A', commit: COMMIT }).length === 1);
  r.log("commit 'unknown' is a problem", buildInfoProblems({ ...good, commit: 'unknown' }, { label: 'A', commit: COMMIT }).length === 1);
  r.log('a different commit is a problem', buildInfoProblems({ ...good, commit: 'f'.repeat(40) }, { label: 'B', commit: COMMIT }).length === 1);
  r.log('B not newer than A is a problem', buildInfoProblems({ ...good, appVersion: '1.5.0' }, { label: 'B', commit: COMMIT, olderThan: '1.5.0' }).length === 1);

  const env = childEnv({
    PATH: '/bin', npm_execpath: '/npm/bin/npm-cli.js', npm_config_cache: '/cache',
    npm_package_version: '1.5.0', npm_package_name: 'sci-repl', npm_lifecycle_event: 'pilot:packages',
    npm_config_local_prefix: '/repo', npm_package_json: '/repo/package.json', INIT_CWD: '/repo', npm_command: 'run-script',
  });
  r.log("npm in the clone does not inherit the parent package's details",
    !('npm_package_version' in env) && !('npm_config_local_prefix' in env) && !('npm_package_json' in env)
      && !('INIT_CWD' in env) && !('npm_lifecycle_event' in env) && !('npm_command' in env), Object.keys(env).join(','));
  r.log('npm in the clone keeps PATH, the npm CLI path and user config', env.PATH === '/bin' && env.npm_execpath && env.npm_config_cache === '/cache');

  const dry = spawnSync(process.execPath, [NODE_SCRIPT, '--run', path.join('pilot', 'run-x'), '--dry-run'], { encoding: 'utf8' });
  r.log('--dry-run prints the plan and builds nothing', dry.status === 0 && /licenses:generate/.test(dry.stdout) && /core\.autocrlf=false/.test(dry.stdout), dry.stderr || dry.stdout.split('\n')[0]);
  const noRun = spawnSync(process.execPath, [NODE_SCRIPT], { encoding: 'utf8' });
  r.log('without --run it refuses with a usage message', noRun.status === 2 && /--run/.test(noRun.stderr));

  // The PowerShell scripts: static rules carried over from pilot run 1.
  const scripts = readdirSync(PILOT_DIR).filter((f) => f.endsWith('.ps1'));
  r.log('there is a script for steps 3 to 9 and cleanup',
    ['Step3-Sign.ps1', 'Step4-Baseline.ps1', 'Step5-Wack.ps1', 'Step6-InstallA.ps1', 'Step6-MarkInstall.ps1', 'Step7-CheckOffline.ps1',
      'Step8-UpgradeB.ps1', 'Step9-VerifyProfiles.ps1', 'Cleanup.ps1'].every((f) => scripts.includes(f)), scripts.join(', '));
  for (const f of scripts) {
    const text = readFileSync(path.join(PILOT_DIR, f), 'utf8');
    const lines = text.split(/\r?\n/);
    const problems = [];
    if (!/^#Requires -Version 7\s*$/m.test(text)) problems.push('no #Requires -Version 7');
    if (ADMIN_SCRIPTS.has(f) !== /^#Requires -RunAsAdministrator\s*$/m.test(text)) problems.push(ADMIN_SCRIPTS.has(f) ? 'needs #Requires -RunAsAdministrator' : 'must not require administrator');
    if (!/param\(\[Parameter\(Mandatory\)\]\[string\]\$Run\)/.test(text)) problems.push('no mandatory -Run');
    if (!/\$ErrorActionPreference = 'Stop'/.test(text)) problems.push("no $ErrorActionPreference = 'Stop'");
    if (/(^|[\s&])npm(\s|$)/m.test(text.replace(/npm run pilot:packages/g, ''))) problems.push("calls npm (PowerShell 7's npm.ps1 misreads arguments; use npm.cmd)");
    if (APPX.test(text) && !/^Initialize-PilotAppx\s*$/m.test(text)) problems.push('uses Appx cmdlets without Initialize-PilotAppx');
    lines.forEach((line, i) => {
      if (/^\s*& \$(signtool|appcert)/.test(line) && !/\$LASTEXITCODE -ne 0/.test(lines[i + 1] || '')) problems.push(`line ${i + 1}: native call without an exit-code check`);
    });
    r.log(`${f}: PowerShell 7, -Run, stop on error, exit codes checked`, problems.length === 0, problems.join('; '));
  }

  const read = (f) => readFileSync(path.join(PILOT_DIR, f), 'utf8');
  r.log("cleanup removes the package only through the ownership check",
    /Remove-PilotRunPackage \$pilot/.test(read('Cleanup.ps1')) && !/Remove-AppxPackage/.test(read('Cleanup.ps1')));
  r.log('step 6 records and marks the install; step 8 checks it and the exact A version before upgrading',
    /New-PilotInstallRecord \$pilot \$expected/.test(read('Step6-InstallA.ps1')) && /Set-PilotInstallMarker \$pilot/.test(read('Step6-InstallA.ps1'))
      && (read('Step8-UpgradeB.ps1').match(/Assert-PilotOwnsInstall \$pilot/g) || []).length === 2
      && /if \(\$before -ne \$a\)/.test(read('Step8-UpgradeB.ps1'))
      && read('Step8-UpgradeB.ps1').indexOf('$before -ne $a') < read('Step8-UpgradeB.ps1').indexOf('Add-AppxPackage'));

  // PowerShell itself, when available.
  const pwsh = process.env.SCIREPL_PWSH || 'pwsh';
  const probe = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || Number(probe.stdout.trim()) < 7) {
    r.skip('PowerShell 7 checks (parse, offline and WACK logic)', `pwsh not available (${probe.error ? probe.error.code : probe.stdout.trim()})`);
  } else {
    const res = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', PS_TESTS, '-PilotDir', PILOT_DIR, '-Fixture', FIXTURE], { encoding: 'utf8' });
    const checks = res.stdout.split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    r.log('the PowerShell checks ran to completion', res.status === 0 && checks.length > 0, (res.stderr || '').trim());
    for (const c of checks) r.log(`pwsh: ${c.name}`, c.passed === true, c.detail);
  }

  return r.summary();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await run();
  process.exitCode = s.failed ? 1 : 0;
}
