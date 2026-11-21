/**
 * build-pilot-packages.mjs — steps 1 and 2 of the local MSIX pilot
 * (docs/WINDOWS_MSIX_PILOT_SCRIPTS.md), as one command:
 *
 *   npm run pilot:packages -- --run C:\scirepl-store-pilot\run-2
 *   npm run pilot:packages -- --run C:\scirepl-store-pilot\run-2 --dry-run
 *
 * Package A is the current checkout at HEAD. Package B is the upgrade: a second
 * clone of the same commit with only the patch version raised and the licence
 * notices regenerated. Both raises stay uncommitted, so A and B record the same
 * commit. Each package is built with the same sequence:
 *
 *   npm ci                         install exactly what package-lock.json lists
 *   npm run configure
 *   npm run fetch:bundles
 *   (both lockfiles must still match the commit)
 *   [B only] npm version patch --no-git-tag-version
 *   [B only] npm run licenses:generate   the notices name the app version
 *   npm run package:windows:msix-pilot
 *   (desktop/electron/package-lock.json must still match the commit)
 *
 * Each package and its build-info.json are then checked (channel `store`, the
 * expected commit, the bundled DOCX library, B newer than A, an MSIX newer
 * than its tree) and copied into <run>\A and <run>\B. Nothing is signed,
 * installed or trusted: those are the PowerShell steps that follow.
 *
 * These are the gates of steps 1 and 2 in docs/WINDOWS_MSIX_PILOT.md, which
 * were run by hand in pilot run 1.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
export const LOCKFILES = ['package-lock.json', 'desktop/electron/package-lock.json'];
const TREE = path.join('desktop', 'electron', 'out', 'SciREPL-win32-x64', 'resources');
const DOCX = path.join('www', 'vendor', 'docx', 'docx.iife.js');

export function parseArgs(argv) {
  const opts = { run: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--run') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('--run needs a folder');
      opts.run = argv[++i];
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.run) throw new Error('--run <new folder> is required, for example --run C:\\scirepl-store-pilot\\run-2');
  return opts;
}

/** The npm commands for one package, in order. `bump` adds B's version raise. */
export function buildSteps({ bump }) {
  return [
    { npm: ['ci'] },
    { npm: ['run', 'configure'] },
    { npm: ['run', 'fetch:bundles'] },
    { lockfiles: LOCKFILES, why: 'the setup changed a lockfile' },
    ...(bump ? [
      { npm: ['version', 'patch', '--no-git-tag-version'] },
      { npm: ['run', 'licenses:generate'], note: 'the licence notices name the app version' },
    ] : []),
    { npm: ['run', 'package:windows:msix-pilot'] },
    { lockfiles: [LOCKFILES[1]], why: 'the build changed desktop/electron/package-lock.json' },
  ];
}

/** Numeric x.y.z comparison; build-info versions are plain semver cores. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`not an x.y.z version: '${a}' / '${b}'`);
  }
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The checks on a collected tree's build-info.json. Returns a list of problems. */
export function buildInfoProblems(info, { label, commit, olderThan }) {
  const problems = [];
  if (!info || typeof info !== 'object') return [`${label}: no build-info.json`];
  if (info.channel !== 'store') problems.push(`${label} is channel '${info.channel}', not 'store'`);
  if (!/^[0-9a-f]{40}$/.test(String(info.commit))) problems.push(`${label} records commit '${info.commit}', not a full commit id`);
  else if (commit && info.commit !== commit) problems.push(`${label} was built from '${info.commit}', expected '${commit}'`);
  if (olderThan) {
    try {
      if (compareVersions(info.appVersion, olderThan) <= 0) problems.push(`${label} (${info.appVersion}) is not newer than A (${olderThan})`);
    } catch (e) { problems.push(`${label}: ${e.message}`); }
  }
  return problems;
}

/**
 * The environment for npm in another checkout. `npm run` exports its own
 * package's details (npm_package_*, npm_config_local_prefix, INIT_CWD, ...);
 * none of them may describe the clone, so drop them and let npm work them out
 * from the clone's working directory.
 */
export function childEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^npm_(package|lifecycle)_/i.test(k)) continue;
    if (/^(npm_config_local_prefix|npm_package_json|npm_command|INIT_CWD)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function fail(message) {
  const err = new Error(message);
  err.pilot = true;
  throw err;
}

function run(file, args, { cwd, env, shell = false }) {
  const result = spawnSync(file, args, { cwd, env, stdio: 'inherit', shell });
  if (result.error) fail(`${path.basename(file)} ${args.join(' ')}: ${result.error.message}`);
  return result.status;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) fail(`git ${args[0]}: ${result.error.message}. Git for Windows must be on PATH.`);
  return result;
}

/** npm through the npm CLI script that started us, so no shell is needed for npm.cmd. */
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  const env = childEnv(process.env);
  const status = cli && /\.c?js$/i.test(cli)
    ? run(process.execPath, [cli, ...args], { cwd, env })
    // Started with plain node: npm on Windows is npm.cmd, which needs a shell.
    // The arguments are fixed literals in buildSteps, never user input.
    : run('npm', args, { cwd, env, shell: process.platform === 'win32' });
  if (status !== 0) fail(`npm ${args.join(' ')} failed in ${cwd} (exit ${status})`);
}

function buildPackage(cwd, { bump }) {
  for (const step of buildSteps({ bump })) {
    if (step.lockfiles) {
      const r = git(['diff', '--quiet', '--', ...step.lockfiles], cwd);
      if (r.status !== 0) fail(`${step.why} in ${cwd}. Restore it and use npm ci.`);
      continue;
    }
    console.log(`\n[pilot] ${path.basename(cwd)}> npm ${step.npm.join(' ')}`);
    npm(step.npm, cwd);
  }
}

function collect(cwd, dest, { label, commit, olderThan }) {
  const res = path.join(cwd, TREE);
  const infoPath = path.join(res, 'build-info.json');
  if (!existsSync(infoPath)) fail(`${label}: ${infoPath} is missing`);
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));
  const problems = buildInfoProblems(info, { label, commit, olderThan });
  if (!existsSync(path.join(res, DOCX))) problems.push(`${label} has no bundled DOCX library`);
  const msix = path.join(cwd, 'desktop', 'electron', 'out', `SciREPL-${info.appVersion}.0-x64-local-test.msix`);
  if (!existsSync(msix)) problems.push(`${label}: ${msix} is missing`);
  else if (statSync(msix).mtimeMs < statSync(infoPath).mtimeMs) problems.push(`${label}: ${msix} is older than its tree`);
  if (problems.length) fail(problems.join('\n  '));
  mkdirSync(dest, { recursive: false });
  copyFileSync(msix, path.join(dest, path.basename(msix)));
  copyFileSync(infoPath, path.join(dest, 'build-info.json'));
  console.log(`\n[pilot] ${label}: ${info.appVersion} from ${info.commit}`);
  return info;
}

function printPlan(runDir) {
  const src = path.join(runDir, 'upgrade-src');
  console.log(`Package A, in ${REPO_ROOT} at HEAD:`);
  for (const s of buildSteps({ bump: false })) console.log(s.npm ? `  npm ${s.npm.join(' ')}` : `  check unchanged: ${s.lockfiles.join(', ')}`);
  console.log(`  collect into ${path.join(runDir, 'A')}`);
  console.log(`Package B, in ${src} (git clone -c core.autocrlf=false, checkout --detach <A's commit>):`);
  for (const s of buildSteps({ bump: true })) console.log(s.npm ? `  npm ${s.npm.join(' ')}` : `  check unchanged: ${s.lockfiles.join(', ')}`);
  console.log(`  collect into ${path.join(runDir, 'B')}`);
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`[pilot] ${e.message}`); return 2; }
  const runDir = path.resolve(opts.run);
  if (opts.dryRun) { printPlan(runDir); return 0; }
  try {
    if (process.platform !== 'win32') fail('Windows only: the MSIX step needs MakeAppx.exe from the Windows SDK.');
    if (existsSync(runDir)) fail(`${runDir} already exists: use a new folder for each run`);
    const head = git(['rev-parse', 'HEAD'], REPO_ROOT);
    if (head.status !== 0) fail('git rev-parse HEAD failed: run this from a git clone');
    const commit = head.stdout.trim();

    buildPackage(REPO_ROOT, { bump: false });
    mkdirSync(runDir, { recursive: true });
    const a = collect(REPO_ROOT, path.join(runDir, 'A'), { label: 'A', commit });

    const src = path.join(runDir, 'upgrade-src');
    // LF checkout, like A's: Git for Windows defaults to core.autocrlf=true.
    if (git(['clone', '--quiet', '-c', 'core.autocrlf=false', REPO_ROOT, src], REPO_ROOT).status !== 0) fail('git clone failed');
    if (git(['-C', src, 'checkout', '--quiet', '--detach', a.commit], REPO_ROOT).status !== 0) fail(`checkout of ${a.commit} failed`);
    buildPackage(src, { bump: true });
    collect(src, path.join(runDir, 'B'), { label: 'B', commit: a.commit, olderThan: a.appVersion });

    console.log(`\n[pilot] Packages A and B are in ${runDir}. ${src} can be deleted after the run.`);
    return 0;
  } catch (e) {
    if (!e.pilot) throw e;
    console.error(`\n[pilot] STOPPED: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
