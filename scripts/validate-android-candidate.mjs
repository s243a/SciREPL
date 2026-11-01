#!/usr/bin/env node
/** Read-only Free APK/AAB identity, unsigned-layout and exact web-asset gate.
 * --fetch-bundletool FILE is the only network/write operation; all validation
 * uses a supplied, hash-pinned jar. This never signs, installs or publishes.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const BUNDLETOOL = Object.freeze({
  version: '1.18.3', bytes: 32520401,
  sha256: 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29',
  url: 'https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (condition, message) => { if (!condition) throw new Error(message); };

export function verifyBundletool(file) {
  demand(existsSync(file), 'Pinned bundletool jar is missing');
  const bytes = readFileSync(file);
  demand(bytes.length === BUNDLETOOL.bytes && digest(bytes) === BUNDLETOOL.sha256, 'bundletool does not match its pinned official release');
}

export async function fetchBundletool(file) {
  if (existsSync(file)) { verifyBundletool(file); return; }
  const response = await fetch(BUNDLETOOL.url, { signal: AbortSignal.timeout(120_000) });
  demand(response.ok, `bundletool download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  demand(bytes.length === BUNDLETOOL.bytes && digest(bytes) === BUNDLETOOL.sha256, 'Downloaded bundletool failed its pinned size/hash');
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.download-${process.pid}`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  renameSync(temporary, file);
}

export function releaseIdentity(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  demand(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'Invalid release version');
  demand(Number.isInteger(pkg.android?.versionCode) && pkg.android.versionCode > 0, 'Invalid Android version code');
  demand(pkg.releaseChannel === 'release', 'Candidate must use the release channel');
  const gradle = readFileSync(path.join(root, 'android/variables.gradle'), 'utf8');
  const targetSdk = Number(gradle.match(/targetSdkVersion\s*=\s*(\d+)/)?.[1]);
  const compileSdk = Number(gradle.match(/compileSdkVersion\s*=\s*(\d+)/)?.[1]);
  demand(targetSdk >= 36 && compileSdk >= 36, 'Android target and compile SDK must be at least 36');
  return { packageName: 'com.unifyweaver.scirepl', version: pkg.version, code: pkg.android.versionCode, targetSdk, compileSdk };
}

function attributes(xml, element) {
  const opening = xml.match(new RegExp(`<${element}\\b[^>]*>`))?.[0] || '';
  return Object.fromEntries([...opening.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
}

export function checkBundleManifest(xml, identity) {
  const manifest = attributes(xml, 'manifest'), sdk = attributes(xml, 'uses-sdk');
  demand(manifest.package === identity.packageName, 'AAB has the wrong package (Free release, not Debug or Pro, is required)');
  demand(manifest['android:versionName'] === identity.version, 'AAB version name differs from package.json');
  demand(Number(manifest['android:versionCode']) === identity.code, 'AAB version code differs from package.json');
  demand(Number(sdk['android:targetSdkVersion']) === identity.targetSdk, 'AAB target SDK differs from the checked-in target');
  demand(Number(manifest['android:compileSdkVersion']) === identity.compileSdk, 'AAB compile SDK differs from the checked-in target');
}

export function checkApkBadging(text, identity) {
  const info = Object.fromEntries([...((text.match(/^package: (.+)$/m) || [])[1] || '').matchAll(/([\w]+)='([^']*)'/g)].map(m => [m[1], m[2]]));
  demand(info.name === identity.packageName, 'APK has the wrong package');
  demand(info.versionName === identity.version && Number(info.versionCode) === identity.code, 'APK release identity differs from package.json');
  demand(Number(text.match(/^targetSdkVersion:'(\d+)'$/m)?.[1]) === identity.targetSdk, 'APK target SDK differs from the checked-in target');
  demand(Number(info.compileSdkVersion) === identity.compileSdk, 'APK compile SDK differs from the checked-in target');
}

export function sourceFiles(www) {
  const files = new Map();
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Match the repository's aapt ignoreAssetsPattern. Runtime provenance
      // receipts and public Pro marketing/Help pages are intentionally kept.
      if (entry.name.startsWith('.') || entry.name.endsWith('~') || /^(?:CVS|SCCS|thumbs\.db|picasa\.ini)$/i.test(entry.name) || /\.scc$/i.test(entry.name)) continue;
      const relative = prefix + entry.name, absolute = path.join(directory, entry.name);
      demand(!entry.isSymbolicLink(), `Web asset is a symlink: ${relative}`);
      if (entry.isDirectory()) walk(absolute, relative + '/');
      else if (entry.isFile()) files.set(relative, { bytes: lstatSync(absolute).size, sha256: digest(readFileSync(absolute)) });
    }
  }
  walk(www);
  demand(files.has('index.html') && files.has('js/kernel_config.js') && files.has('sw.js'), 'Prepared web assets are incomplete');
  const config = readFileSync(path.join(www, 'js/kernel_config.js'), 'utf8');
  demand(/"profile"\s*:\s*"full"/.test(config), 'Free release must use the full profile');
  return files;
}

export function entryProblems(names, kind) {
  const problems = [], seen = new Set();
  for (const name of names) {
    if (seen.has(name)) problems.push(`Duplicate ZIP entry: ${name}`);
    seen.add(name);
    if (kind === 'aab' && name !== 'BundleConfig.pb' && !/^(?:base|BUNDLE-METADATA|META-INF)\//.test(name)) problems.push(`Unexpected Free bundle module/top-level entry: ${name}`);
    if (name.includes('\\') || name.startsWith('/') || path.posix.normalize(name.replace(/\/$/, '')) !== name.replace(/\/$/, '')) problems.push(`Unsafe ZIP entry: ${name}`);
    if (/\.gguf$/i.test(name) || /^(?:localmodel|qwen_[^/]+)\//.test(name)
        || /(?:^|\/)assets\/public\/vendor\/webr\//.test(name)) problems.push(`Pro runtime/model content: ${name}`);
    if ((kind === 'aab' && /^base\/lib\//.test(name)) || (kind === 'apk' && /^lib\//.test(name))) problems.push(`Free candidate unexpectedly carries native libraries: ${name}`);
    if (/^META-INF\/[^/]+\.(?:SF|RSA|DSA|EC)$/i.test(name)) problems.push(`Candidate is JAR-signed: ${name}`);
  }
  return problems;
}

export function apkSigningBlock(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, length = Math.min(size, 65535 + 22), tail = Buffer.alloc(length);
    readSync(fd, tail, 0, length, size - length);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    demand(end >= 0 && end + 22 + tail.readUInt16LE(end + 20) === tail.length, 'APK ZIP end record is invalid');
    const central = tail.readUInt32LE(end + 16);
    demand(central !== 0xffffffff, 'ZIP64 APK signing-layout check is unsupported');
    if (central < 16) return false;
    const magic = Buffer.alloc(16);
    readSync(fd, magic, 0, 16, central - 16);
    return magic.toString('ascii') === 'APK Sig Block 42';
  } finally { closeSync(fd); }
}

export function inspectArchive(file, kind, expected) {
  const prefix = kind === 'aab' ? 'base/assets/public/' : 'assets/public/';
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const names = [], publicFiles = new Set();
      let ended = false;
      const fail = error => { if (!ended) { ended = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('entry', async entry => {
        try {
          names.push(entry.fileName);
          if (entry.fileName.startsWith(prefix) && !entry.fileName.endsWith('/')) {
            const relative = entry.fileName.slice(prefix.length), source = expected.get(relative);
            demand(source, `Unexpected packaged web asset: ${relative}`);
            demand(source.bytes === entry.uncompressedSize, `Packaged web asset size differs: ${relative}`);
            const stream = await new Promise((yes, no) => zip.openReadStream(entry, (e, s) => e ? no(e) : yes(s)));
            const hash = createHash('sha256');
            await new Promise((yes, no) => {
              stream.on('data', bytes => hash.update(bytes));
              stream.once('end', yes); stream.once('error', no);
            });
            demand(hash.digest('hex') === source.sha256, `Packaged web asset bytes differ: ${relative}`);
            publicFiles.add(relative);
          }
          zip.readEntry();
        } catch (error) { fail(error); }
      });
      zip.on('end', () => {
        try {
          demand(!ended, 'Archive ended after an earlier failure');
          const problems = entryProblems(names, kind);
          demand(!problems.length, problems.join('\n'));
          for (const relative of expected.keys()) demand(publicFiles.has(relative), `Web asset missing from ${kind}: ${relative}`);
          if (kind === 'aab') {
            demand(names.includes('BundleConfig.pb') && names.includes('base/manifest/AndroidManifest.xml'), 'AAB structure is incomplete');
            demand(names.includes('base/dex/classes.dex'), 'AAB base DEX is missing');
          } else {
            demand(names.includes('AndroidManifest.xml') && names.includes('classes.dex'), 'APK structure is incomplete');
            demand(!apkSigningBlock(file), 'Candidate APK contains an APK v2/v3 signing block');
          }
          ended = true; zip.close(); resolve({ entries: names.length, publicAssets: publicFiles.size });
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    });
  });
}

export function sdkTool(name, env = process.env) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  demand(sdk && existsSync(path.join(sdk, 'build-tools')), 'ANDROID_HOME must identify an installed SDK');
  const versions = readdirSync(path.join(sdk, 'build-tools')).filter(x => /^\d[\w.-]*$/.test(x)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const found = versions.map(version => path.join(sdk, 'build-tools', version, name)).find(existsSync);
  demand(found, `Android build tool is missing: ${name}`);
  return found;
}

export function bundleManifest(aab, bundletool, command) {
  command('java', ['-jar', bundletool, 'validate', `--bundle=${path.resolve(aab)}`]);
  return command('java', ['-jar', bundletool, 'dump', 'manifest', `--bundle=${path.resolve(aab)}`, '--module=base']);
}

export async function validateCandidate({ root = ROOT, aab, apk, bundletool, aapt2, run = execFileSync }) {
  demand(aab && existsSync(aab), 'AAB is missing; build bundleRelease first');
  demand(!apk || existsSync(apk), 'APK is missing; build assembleRelease first');
  demand(bundletool, 'Pass --bundletool with the pinned official jar');
  verifyBundletool(bundletool);
  const identity = releaseIdentity(root), expected = sourceFiles(path.join(root, 'www'));
  const command = (program, args) => run(program, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const manifest = bundleManifest(aab, bundletool, command);
  checkBundleManifest(manifest, identity);
  const bundle = await inspectArchive(aab, 'aab', expected);
  let application;
  if (apk) {
    checkApkBadging(command(aapt2 || sdkTool('aapt2'), ['dump', 'badging', path.resolve(apk)]), identity);
    application = await inspectArchive(apk, 'apk', expected);
  }
  return { identity, aab: bundle, ...(application ? { apk: application } : {}), unsigned: true, bundletool: BUNDLETOOL.version };
}

export function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    demand(['--aab', '--apk', '--bundletool', '--aapt2', '--fetch-bundletool'].includes(option), `Unknown argument: ${option}`);
    demand(args[i + 1] && !args[i + 1].startsWith('--'), `${option} needs a path`);
    out[option.slice(2)] = args[++i];
  }
  if (out['fetch-bundletool']) demand(Object.keys(out).length === 1, '--fetch-bundletool cannot be combined with validation');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args['fetch-bundletool']) {
      await fetchBundletool(args['fetch-bundletool']);
      console.log(`[android-candidate] pinned bundletool ${BUNDLETOOL.version} ready`);
    } else {
      console.log(JSON.stringify(await validateCandidate({ aab: args.aab, apk: args.apk, bundletool: args.bundletool, aapt2: args.aapt2 }), null, 2));
    }
  } catch (error) { console.error(`[android-candidate] ${error.message}`); process.exitCode = 1; }
}
