/**
 * build-msix.mjs — wrap the tested portable build in an MSIX for the
 * Microsoft Store pilot (Free edition, Windows x64).
 *
 *   npm run package:windows                       # builds out/SciREPL-win32-x64
 *   node desktop/electron/packaging/build-msix.mjs
 *
 * It packs the portable tree unchanged, so what was tested by
 * `run-all.mjs packaged` is what goes into the package. Windows only: it needs
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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeVersion, resolveIdentity, buildManifest, LOGO_ASSETS } from './msix-manifest.mjs';

const ELECTRON_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..', '..');
const OUT_DIR = path.join(ELECTRON_DIR, 'out');
const PORTABLE_DIR = path.join(OUT_DIR, 'SciREPL-win32-x64');
const ICON_SOURCE = path.join(REPO_ROOT, 'www', 'icons', 'icon-512.png');

function fail(message) {
  console.error(`\n[build-msix] ${message}\n`);
  process.exit(1);
}

if (process.platform !== 'win32') fail('MSIX packing needs Windows (MakeAppx.exe and PowerShell).');

/* ------------------------------ inputs ------------------------------ */

for (const [p, what] of [
  [path.join(PORTABLE_DIR, 'SciREPL.exe'), 'the portable executable'],
  [path.join(PORTABLE_DIR, 'resources', 'www', 'index.html'), 'the packaged application tree'],
  [path.join(PORTABLE_DIR, 'resources', 'build-info.json'), 'build metadata'],
  [ICON_SOURCE, 'the app icon'],
]) {
  if (!existsSync(p)) fail(`Missing ${what}: ${p}\nRun:  npm run package:windows`);
}

const buildInfo = JSON.parse(readFileSync(path.join(PORTABLE_DIR, 'resources', 'build-info.json'), 'utf8'));
if (buildInfo.edition !== 'free' || buildInfo.profile === 'pro') {
  fail(`The portable build is edition "${buildInfo.edition}", profile "${buildInfo.profile}". The pilot is Free only.`);
}

let identity, version;
try {
  identity = resolveIdentity(process.env);
  version = storeVersion(buildInfo.appVersion);
} catch (err) {
  fail(err.message);
}

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
const makeappx = findMakeAppx();

/* ------------------------------ staging ------------------------------ */

const stage = mkdtempSync(path.join(tmpdir(), 'scirepl-msix-'));
const content = path.join(stage, 'content');
try {
  cpSync(PORTABLE_DIR, content, { recursive: true });

  // Record the distribution channel in the packaged copy only; the portable
  // build and its tests are untouched.
  const stagedInfo = { ...buildInfo, channel: 'msix-pilot', packageVersion: version, packageIdentity: identity.name,
    note: identity.placeholder ? 'Local test MSIX with a placeholder identity. Not for submission.' : 'Store-pilot MSIX.' };
  writeFileSync(path.join(content, 'resources', 'build-info.json'), JSON.stringify(stagedInfo, null, 2));

  const assets = path.join(content, 'Assets');
  mkdirSync(assets);
  // High-quality resize with System.Drawing; no image dependency in the repo.
  const ps = LOGO_ASSETS.map(({ file, size }) => `
$dst = New-Object System.Drawing.Bitmap ${size}, ${size}
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, ${size}, ${size})
$dst.Save('${path.join(assets, file).replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $dst.Dispose()`).join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Drawing; $src = [System.Drawing.Image]::FromFile('${ICON_SOURCE.replace(/'/g, "''")}');${ps}
$src.Dispose()`], { stdio: 'inherit' });
  for (const { file } of LOGO_ASSETS) {
    if (!existsSync(path.join(assets, file))) fail(`Logo was not rendered: ${file}`);
  }

  writeFileSync(path.join(content, 'AppxManifest.xml'), buildManifest({ identity, version }));

  /* ------------------------------ pack ------------------------------ */

  const suffix = identity.placeholder ? '-local-test' : '';
  const msix = path.join(OUT_DIR, `SciREPL-${version}-x64${suffix}.msix`);
  rmSync(msix, { force: true });
  console.log('[build-msix] packing');
  for (const [k, v] of Object.entries({ identity: identity.name, publisher: identity.publisher, version, makeappx })) {
    console.log(`  ${k.padEnd(10)} ${v}`);
  }
  execFileSync(makeappx, ['pack', '/d', content, '/p', msix, '/o'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (!existsSync(msix)) fail('MakeAppx reported success but produced no package.');

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
