/**
 * build-msix.mjs — wrap the tested Store-channel build in an MSIX for the
 * Microsoft Store pilot (Free edition, Windows x64).
 *
 *   npm run package:windows -- --channel store     # builds out/SciREPL-win32-x64
 *   node desktop/electron/test/run-all.mjs packaged  # tests that tree
 *   npm run package:windows:msix                    # packs it
 *
 * The packaged tree is copied as built and tested; this script only adds
 * AppxManifest.xml and the logo files next to it. Windows only: it needs
 * MakeAppx.exe from the Windows SDK (found automatically, or set
 * SCIREPL_MAKEAPPX) and PowerShell to render the logo sizes.
 *
 * Identity comes from Partner Center via SCIREPL_MSIX_IDENTITY_NAME,
 * SCIREPL_MSIX_PUBLISHER and SCIREPL_MSIX_PUBLISHER_DISPLAY_NAME. Without them
 * the package gets a placeholder identity and a `-local-test` file name: it can
 * be test-signed and installed on a developer machine, never submitted.
 *
 * What this script deliberately does NOT do:
 *   - sign anything (the Store signs submitted packages; a local test signature
 *     is a separate, explicit step on the tester's own machine);
 *   - add an auto-updater (the Store delivers updates);
 *   - touch Partner Center.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeVersion, resolveIdentity, buildManifest, LOGO_ASSETS } from './msix-manifest.mjs';

const ELECTRON_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..', '..');
const OUT_DIR = path.join(ELECTRON_DIR, 'out');
const PORTABLE_DIR = path.join(OUT_DIR, 'SciREPL-win32-x64');
const RESOURCES = path.join(PORTABLE_DIR, 'resources');
const ICON_SOURCE = path.join(REPO_ROOT, 'www', 'icons', 'icon-512.png');

class BuildError extends Error {}
const fail = (message) => { throw new BuildError(message); };

function findMakeAppx() {
  if (process.env.SCIREPL_MAKEAPPX) {
    if (!existsSync(process.env.SCIREPL_MAKEAPPX)) fail(`SCIREPL_MAKEAPPX does not exist: ${process.env.SCIREPL_MAKEAPPX}`);
    return process.env.SCIREPL_MAKEAPPX;
  }
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(kits)
    ? readdirSync(kits).filter((v) => /^10\.\d+\.\d+\.\d+$/.test(v)).sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      })
    : [];
  for (const v of versions) {
    const candidate = path.join(kits, v, 'x64', 'makeappx.exe');
    if (existsSync(candidate)) return candidate;
  }
  fail('MakeAppx.exe not found. Install the Windows SDK or set SCIREPL_MAKEAPPX.');
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The checks build-portable.mjs makes on its own output, repeated on what is about to be packed. */
function checkPortableTree({ requireProvenance }) {
  for (const [p, what] of [
    [path.join(PORTABLE_DIR, 'SciREPL.exe'), 'the executable'],
    [path.join(RESOURCES, 'app.asar'), 'the packaged shell'],
    [path.join(RESOURCES, 'www', 'index.html'), 'the application entry point'],
    [path.join(RESOURCES, 'www', 'js', 'kernel_config.js'), 'the build profile'],
    [path.join(RESOURCES, 'build-info.json'), 'build metadata'],
    [ICON_SOURCE, 'the app icon'],
  ]) {
    if (!existsSync(p)) fail(`Missing ${what}: ${p}\nRun:  npm run package:windows -- --channel store`);
  }
  // Free-only boundary, checked in the files rather than trusted from metadata.
  if (existsSync(path.join(RESOURCES, 'www', 'vendor', 'webr'))) fail('The tree contains the Pro offline R runtime (www/vendor/webr).');
  if (existsSync(path.join(RESOURCES, 'www', 'pro'))) fail('The tree contains www/pro, which must not ship in Free.');
  const profile = readFileSync(path.join(RESOURCES, 'www', 'js', 'kernel_config.js'), 'utf8')
    .match(/["']?profile["']?\s*:\s*["']([^"']+)["']/)?.[1];
  if (!profile || profile === 'pro') fail(`The packaged kernel_config.js has profile "${profile}". The pilot is Free only.`);

  const buildInfo = JSON.parse(readFileSync(path.join(RESOURCES, 'build-info.json'), 'utf8'));
  if (buildInfo.edition !== 'free' || buildInfo.profile !== profile) {
    fail(`build-info.json (edition "${buildInfo.edition}", profile "${buildInfo.profile}") does not match a Free "${profile}" tree.`);
  }
  if (buildInfo.channel !== 'store') {
    fail(`The tree was built for channel "${buildInfo.channel}". Rebuild with:  npm run package:windows -- --channel store`);
  }
  // A stale out/ directory must not be packed as if it were the current source.
  const head = git(['rev-parse', 'HEAD']);
  if (head && buildInfo.commit !== 'unknown' && buildInfo.commit !== head) {
    fail(`The tree was built from ${buildInfo.commit}, but HEAD is ${head}. Rebuild and retest it.`);
  }
  if (requireProvenance) {
    // A package with the real Partner Center identity must come from a known,
    // clean commit: no unverifiable copies and no uncommitted changes.
    if (!head || buildInfo.commit === 'unknown') {
      fail('A package with the Partner Center identity needs a git checkout whose build recorded its commit. Build from a clean clone.');
    }
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty === null || dirty !== '') {
      fail(`The checkout has uncommitted changes to tracked files; build the Partner Center package from a clean, pinned commit.\n${dirty || ''}`);
    }
  } else if (!head || buildInfo.commit === 'unknown') {
    console.warn('[build-msix] warning: cannot confirm the tree matches the source (no git commit recorded). Acceptable only for a local test package.');
  }
  return buildInfo;
}

function renderLogos(assetsDir) {
  // Paths go through the environment, never into the script text, so no
  // quoting in a path can break or alter the command.
  const env = { ...process.env, SCIREPL_ICON_SOURCE: ICON_SOURCE, SCIREPL_ASSETS_DIR: assetsDir,
    SCIREPL_LOGO_SPECS: LOGO_ASSETS.map(({ file, size }) => `${file}:${size}`).join(';') };
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:SCIREPL_ICON_SOURCE)
try {
  foreach ($spec in $env:SCIREPL_LOGO_SPECS.Split(';')) {
    $name, $size = $spec.Split(':'); $size = [int]$size
    $dst = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($dst)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($src, 0, 0, $size, $size)
      $dst.Save((Join-Path $env:SCIREPL_ASSETS_DIR $name), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $g.Dispose(); $dst.Dispose() }
  }
} finally { $src.Dispose() }
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, stdio: 'inherit' });
  for (const { file } of LOGO_ASSETS) {
    if (!existsSync(path.join(assetsDir, file))) fail(`Logo was not rendered: ${file}`);
  }
}

function main() {
  if (process.platform !== 'win32') fail('MSIX packing needs Windows (MakeAppx.exe and PowerShell).');
  const identity = resolveIdentity(process.env);
  const buildInfo = checkPortableTree({ requireProvenance: !identity.placeholder });
  const version = storeVersion(buildInfo.appVersion);
  const makeappx = findMakeAppx();

  const stage = mkdtempSync(path.join(tmpdir(), 'scirepl-msix-'));
  try {
    const content = path.join(stage, 'content');
    cpSync(PORTABLE_DIR, content, { recursive: true });
    const assets = path.join(content, 'Assets');
    mkdirSync(assets);
    renderLogos(assets);
    writeFileSync(path.join(content, 'AppxManifest.xml'), buildManifest({ identity, version }));

    const suffix = identity.placeholder ? '-local-test' : '';
    const msix = path.join(OUT_DIR, `SciREPL-${version}-x64${suffix}.msix`);
    rmSync(msix, { force: true });
    console.log('[build-msix] packing');
    for (const [k, v] of Object.entries({ identity: identity.name, publisher: identity.publisher, version, commit: buildInfo.commit, makeappx })) {
      console.log(`  ${k.padEnd(10)} ${v}`);
    }
    const packed = spawnSync(makeappx, ['pack', '/d', content, '/p', msix, '/o'], { encoding: 'utf8' });
    if (packed.status !== 0 || !existsSync(msix)) {
      fail(`MakeAppx failed (exit ${packed.status}).\n${(packed.stdout || '').slice(-4000)}${packed.stderr || ''}`);
    }

    console.log(`\n[build-msix] done`);
    console.log(`  package  ${msix}`);
    console.log(`  size     ${(statSync(msix).size / 1e6).toFixed(1)} MB`);
    if (identity.placeholder) {
      console.log('\n  Placeholder identity: install only with a local test signature. Do not submit.');
    }
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `msix=${msix}\n`, { flag: 'a' });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`\n[build-msix] ${err instanceof BuildError ? err.message : err?.message || err}\n`);
  process.exitCode = 1;
}
